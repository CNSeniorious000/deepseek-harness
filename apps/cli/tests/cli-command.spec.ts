import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliCommandError, resolveCliCommand, runCliCommand } from '../src/cli-command.ts'

let home: string
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-cli-command-'))) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function install(profile = 'web', packageName = 'test-genui', target: unknown = './command.mjs', source = 'export default argv => argv.length') {
  const dir = join(home, 'profiles', profile)
  const packageDir = join(dir, 'node_modules', packageName)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [packageName]: '*' } }))
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', dsh: { cli: { genui: target } } }))
  writeFileSync(join(packageDir, 'command.mjs'), source)
  return packageDir
}

const resolve = (argv: string[], manageDesktopProfile = false) => resolveCliCommand(argv, { home, runtimeVersion: '0.2.1-rc.2', manageDesktopProfile })

describe('installed plugin CLI commands', () => {
  it('discovers metadata without importing the plugin and preserves every utility argument', async () => {
    const packageDir = install()
    writeFileSync(join(packageDir, 'index.js'), 'throw new Error("plugin must not mount")')
    const args = ['check', 'a file.ui4a.tsx', '--profile', 'late', '-i', 'map.json', '--help']
    const command = resolve(['genui', ...args])!
    expect(command).toEqual({ name: 'genui', profile: 'web', entry: join(packageDir, 'command.mjs'), args })
    expect(await runCliCommand(command)).toBe(args.length)
  })

  it('requires explicit selection when multiple profiles provide a command', () => {
    install('web')
    install('headless')
    expect(() => resolve(['genui', 'check'])).toThrow(/multiple installed providers/)
    expect(resolve(['genui', '--profile', 'web', 'check'])).toMatchObject({ profile: 'web', args: ['check'] })
    expect(resolve(['genui', '--profile=headless', 'check'])).toMatchObject({ profile: 'headless', args: ['check'] })
  })

  it.each([[], ['--help'], ['--profile', 'web', 'genui'], ['plugin', '--profile', 'web'], ['web', 'genui'], ['headless'], ['sdk'], ['sdk-minimal'], ['acp'], ['desktop'], ['../escape']])('leaves launcher/profile input unchanged: %j', (...argv: string[]) => {
    install()
    expect(resolve(argv)).toBeUndefined()
  })

  it('lets an existing custom profile retain its shorthand', () => {
    install()
    const dir = join(home, 'profiles', 'genui')
    mkdirSync(dir)
    writeFileSync(join(dir, 'package.json'), '{}')
    expect(resolve(['genui', 'check'])).toBeUndefined()
  })

  it('does not initialize missing homes or profiles for unknown commands', () => {
    expect(resolve(['unknown', 'check'])).toBeUndefined()
    expect(() => resolve(['genui', '--profile', 'missing', 'check'])).toThrow(/no installed provider/)
  })

  it.each([['genui', '--profile'], ['genui', '--profile='], ['genui', '--profile', '--help'], ['genui', '--profile', '../escape']])('rejects invalid profile selection: %j', (...argv: string[]) => {
    expect(() => resolve(argv)).toThrow()
  })

  it('keeps Desktop installations available only to the Desktop carrier', () => {
    install('desktop')
    expect(resolve(['genui', 'check'])).toBeUndefined()
    expect(resolve(['genui', 'check'], true)).toMatchObject({ profile: 'desktop' })
  })

  it('resolves package symlinks without requiring a package.json export', () => {
    const packageDir = install()
    const actual = join(home, 'linked-package')
    mkdirSync(actual)
    writeFileSync(join(actual, 'package.json'), JSON.stringify({ exports: {}, dsh: { cli: { genui: './command.mjs' } } }))
    writeFileSync(join(actual, 'command.mjs'), 'export default () => 0')
    rmSync(packageDir, { recursive: true })
    symlinkSync(actual, packageDir, process.platform === 'win32' ? 'junction' : 'dir')
    expect(resolve(['genui'])).toMatchObject({ entry: join(actual, 'command.mjs') })
  })

  it.each([42, null, 'command.mjs', '../outside.mjs', '/tmp/outside.mjs'])('rejects invalid command targets: %j', (target) => {
    install('web', 'test-genui', target)
    expect(() => resolve(['genui'])).toThrow(CliCommandError)
  })

  // Windows file symlinks require host privileges; directory junction resolution is covered above.
  it.skipIf(process.platform === 'win32')('rejects a target escaping through a symlink', () => {
    const packageDir = install()
    const outside = join(home, 'outside.mjs')
    writeFileSync(outside, 'export default () => 0')
    rmSync(join(packageDir, 'command.mjs'))
    symlinkSync(outside, join(packageDir, 'command.mjs'))
    expect(() => resolve(['genui'])).toThrow(/must stay inside/)
  })

  it('rejects incompatible commands before executing them', () => {
    const packageDir = install()
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'test-genui', version: '1.0.0', engines: { dsh: '>=9' }, dsh: { cli: { genui: './command.mjs' } } }))
    expect(() => resolve(['genui'])).toThrow(/incompatible with dsh/)
  })

  it('does not require missing, unrelated dependencies to load', () => {
    const dir = join(home, 'profiles', 'web')
    install()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { missing: '*', 'test-genui': '*' } }))
    expect(resolve(['genui'])).toMatchObject({ profile: 'web' })
  })

  it.each([null, [], 'command.mjs'])('rejects malformed command maps: %j', (cli) => {
    const packageDir = install()
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ dsh: { cli } }))
    expect(() => resolve(['genui'])).toThrow(/dsh.cli must map command names/)
  })

  it('honors only an exact plugin/runtime compatibility exemption', () => {
    const packageDir = install()
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'test-genui', version: '1.0.0', engines: { dsh: '>=9' }, dsh: { cli: { genui: './command.mjs' } } }))
    const exemptions = join(home, 'profiles', 'web', 'compatibility.json')
    writeFileSync(exemptions, JSON.stringify({ 'test-genui@1.0.0': ['0.2.1-rc.1'] }))
    expect(() => resolve(['genui'])).toThrow(/incompatible with dsh/)
    writeFileSync(exemptions, JSON.stringify({ 'test-genui@1.0.0': ['0.2.1-rc.2'] }))
    expect(resolve(['genui'])).toMatchObject({ profile: 'web' })
  })

  it.each(['export default 1', 'export default () => undefined', 'export default () => -1', 'export default () => 256', 'export default () => 0.5'])('rejects invalid utility exports or exit statuses: %s', async (source) => {
    install('web', 'test-genui', './command.mjs', source)
    await expect(runCliCommand(resolve(['genui'])!)).rejects.toBeInstanceOf(CliCommandError)
  })

  it('awaits asynchronous commands and preserves nonzero exits', async () => {
    install('web', 'test-genui', './command.mjs', 'export default async () => 17')
    expect(await runCliCommand(resolve(['genui'])!)).toBe(17)
  })

  it('propagates module and command failures', async () => {
    install('web', 'test-genui', './command.mjs', 'export default () => { throw new Error("check failed") }')
    await expect(runCliCommand(resolve(['genui'])!)).rejects.toThrow('check failed')
  })
})
