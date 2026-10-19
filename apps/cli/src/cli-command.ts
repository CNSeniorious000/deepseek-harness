/** Discover installed plugin utilities without mounting a profile or importing unselected plugins. */
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluatePluginCompatibility, pluginCompatibilityWarning, PROFILE_TEMPLATES, PROFILES_DIR, readProfileManifest, readProfileVersionExemptions, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'

/** Expected command discovery, metadata, compatibility, or execution failure. */
export class CliCommandError extends Error {
  /** @param code Failure category. @param message Actionable command diagnostic. */
  constructor(readonly code: 'metadata' | 'ambiguous' | 'profile' | 'compatibility' | 'handler', message: string) {
    super(message)
    this.name = 'CliCommandError'
  }
}

/** One selected installed utility; arguments retain their original spelling and order. */
export interface CliCommand {
  readonly name: string
  readonly profile: string
  readonly entry: string
  readonly args: readonly string[]
}

/** Discovery inputs supplied by the installation rather than a running profile. */
export interface CliCommandOptions {
  readonly home: string
  readonly runtimeVersion: string
  /** Desktop's bundled launcher may use Desktop-owned plugin installations. */
  readonly manageDesktopProfile: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHandler(value: unknown): value is (argv: readonly string[]) => unknown {
  return typeof value === 'function'
}

function commandEntry(manifest: ProfileManifest, packageDir: string, name: string): string | undefined {
  const commands: unknown = manifest.dsh?.cli
  if (commands === undefined) return undefined
  if (!isRecord(commands)) {
    throw new CliCommandError('metadata', `${packageDir}: dsh.cli must map command names to package-relative module paths`)
  }
  if (!Object.hasOwn(commands, name)) return undefined
  const target = commands[name]
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new CliCommandError('metadata', `${packageDir}: dsh.cli.${name} must be a module path beginning with ./`)
  }
  const entry = realpathSync(join(packageDir, target))
  const child = relative(realpathSync(packageDir), entry)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new CliCommandError('metadata', `${packageDir}: dsh.cli.${name} must stay inside its package`)
  }
  return entry
}

/**
 * Resolve a leading utility name among direct installed profile dependencies. Existing profile names
 * and launcher options retain their grammar; --profile immediately after the utility selects its provider.
 * Discovery reads metadata only and creates no profiles. Multiple providers require an explicit profile.
 * @param argv Arguments after dsh.
 * @param options Harness home, runtime version, and Desktop installation permission.
 * @returns The sole matching utility, or undefined to retain ordinary launcher parsing.
 * @throws {CliCommandError} For invalid metadata, ambiguous providers, or incompatible selected plugins.
 */
export function resolveCliCommand(argv: readonly string[], options: CliCommandOptions): CliCommand | undefined {
  const [name, ...rest] = argv
  if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name) || name === 'plugin' || name === 'desktop'
    || Object.hasOwn(PROFILE_TEMPLATES, name) || existsSync(join(resolveProfileDir(name, options.home), 'package.json'))) return undefined

  let profile: string | undefined
  const selector = rest[0]
  if (selector === '--profile') {
    profile = rest[1]
    if (profile === undefined || profile.startsWith('-')) throw new CliCommandError('profile', `dsh ${name}: --profile needs a name`)
    rest.splice(0, 2)
  } else if (selector?.startsWith('--profile=')) {
    profile = selector.slice('--profile='.length)
    rest.shift()
  }
  if (profile === '') throw new CliCommandError('profile', `dsh ${name}: --profile needs a name`)
  const profilesDir = join(options.home, PROFILES_DIR)
  const profiles = profile === undefined
    ? existsSync(profilesDir) ? readdirSync(profilesDir).filter(candidate => candidate !== 'node_modules') : []
    : [profile]
  const matches: { command: CliCommand; manifest: ProfileManifest; dir: string; dependency: string }[] = []
  for (const candidate of profiles.toSorted()) {
    if (candidate.toLowerCase() === 'desktop' && !options.manageDesktopProfile) continue
    const dir = resolveProfileDir(candidate, options.home)
    if (!existsSync(join(dir, 'package.json'))) continue
    const manifest = readProfileManifest('dsh', dir)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const packageDir = join(dir, 'node_modules', dependency)
      if (!existsSync(join(packageDir, 'package.json'))) continue
      const installed = readProfileManifest('dsh', packageDir)
      const entry = commandEntry(installed, packageDir, name)
      if (entry !== undefined) {
        matches.push({ command: { name, profile: candidate, entry, args: rest }, manifest: installed, dir, dependency })
      }
    }
  }
  if (matches.length > 1) {
    const providers = matches.map(match => `${JSON.stringify(match.dependency)} in ${JSON.stringify(match.command.profile)}`).join(', ')
    throw new CliCommandError('ambiguous', `dsh ${name}: multiple installed providers: ${providers}; select one with dsh ${name} --profile <name>, or remove conflicting dependencies within that profile`)
  }
  const match = matches[0]
  if (match === undefined) {
    if (profile !== undefined) throw new CliCommandError('profile', `dsh ${name}: no installed provider in profile ${JSON.stringify(profile)}`)
    return undefined
  }
  const issue = evaluatePluginCompatibility(match.manifest, readProfileVersionExemptions(match.dir), options.runtimeVersion)
  if (issue !== undefined && !issue.exempted) throw new CliCommandError('compatibility', pluginCompatibilityWarning(issue))
  return match.command
}

/**
 * Import only the selected utility and await its default-exported function. Utilities own their
 * argument parsing and output; the caller owns the returned process exit status. No profile is booted.
 * @param command Resolved utility and unmodified arguments.
 * @returns The utility's integer exit status from 0 through 255.
 * @throws {CliCommandError} If the default export is not callable or returns an invalid exit status; module failures propagate.
 */
export async function runCliCommand(command: CliCommand): Promise<number> {
  const module: unknown = await import(pathToFileURL(command.entry).href)
  const handler = isRecord(module) ? module.default : undefined
  if (!isHandler(handler)) throw new CliCommandError('handler', `${command.entry}: default-export a function accepting argv and returning an exit status`)
  const code = await handler(command.args)
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) {
    throw new CliCommandError('handler', `${command.entry}: return an integer exit status from 0 through 255`)
  }
  return code
}
