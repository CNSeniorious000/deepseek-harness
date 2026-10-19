import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
let home: string
let workspace: string
let packageDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-cli-utility-'))
  workspace = join(home, 'workspace')
  packageDir = join(home, 'profiles', 'web', 'node_modules', 'test-genui')
  mkdirSync(workspace)
  mkdirSync(join(packageDir, 'types'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'test-genui': '*' } }))
  // Invalid runtime composition and a throwing plugin entry must not affect a utility invocation.
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'this is not a valid profile patch')
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'test-genui', version: '1.0.0', type: 'module', main: './index.mjs', dsh: { cli: { genui: './command.mjs' } } }))
  writeFileSync(join(packageDir, 'index.mjs'), 'throw new Error("plugin must not mount")')
  writeFileSync(join(packageDir, 'types', 'importmap.json'), JSON.stringify({ imports: { '$dsh/fs': './fs.d.ts' } }))
  writeFileSync(join(packageDir, 'command.mjs'), [
    'import { readFileSync } from "node:fs"',
    'import { basename } from "node:path"',
    'export default async args => {',
    '  const map = JSON.parse(readFileSync(new URL("./types/importmap.json", import.meta.url), "utf8"))',
    '  console.log(JSON.stringify({args, imports: Object.keys(map.imports), cwd: basename(process.cwd())}))',
    '  process.stderr.write("checked\\n")',
    '  return args.includes("--fail") ? 17 : 0',
    '}',
  ].join('\n'))
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

async function run(args: string[]) {
  const result = await execa(process.execPath, [bin, ...args], { cwd: workspace, env: { DSH_HOME: home }, reject: false, timeout: 60_000, killSignal: 'SIGKILL' })
  expect(result.timedOut).toBe(false)
  expect(result.signal).toBeUndefined()
  return result
}

it('runs an installed utility with its own map and preserves argv, cwd, streams, and exit status', async () => {
  const result = await run(['genui', '--profile', 'web', 'check', 'a file.ui4a.tsx', '--profile', 'late', '--help'])
  expect({ stdout: result.stdout, stderr: result.stderr, code: result.exitCode }).toMatchInlineSnapshot(`
    {
      "code": 0,
      "stderr": "checked",
      "stdout": "{\"args\":[\"check\",\"a file.ui4a.tsx\",\"--profile\",\"late\",\"--help\"],\"imports\":[\"$dsh/fs\"],\"cwd\":\"workspace\"}",
    }
  `)
  expect((await run(['genui', 'check', '--fail'])).exitCode).toBe(17)
  expect(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toBe('this is not a valid profile patch')
})

it('fails when no utility is declared and does not initialize a matching profile', async () => {
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'test-genui', version: '1.0.0' }))
  const result = await run(['genui', 'check'])
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('profile "genui" does not exist')
  expect(existsSync(join(home, 'profiles', 'genui'))).toBe(false)
})

it('reports invalid handlers without returning success', async () => {
  writeFileSync(join(packageDir, 'command.mjs'), 'export default () => undefined')
  const result = await run(['genui', 'check'])
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('return an integer exit status from 0 through 255')
})
