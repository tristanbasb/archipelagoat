// The health check (spec §3.15): one check per DoctorCheckId, with its severity and its fix. The
// screens show the params raw, so every text param goes through `redact`. A check that cannot run
// is a note carrying its error: one broken probe never hides the others.
import { readFile, statfs } from 'node:fs/promises'
import semver from 'semver'
import { parseDocument } from 'yaml'
import { DOCTOR_CHECK_IDS, type DoctorCheckId } from '@shared/codes'
import { DEFAULT_PORT } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'
import type { ApInstall, ApRelease, BizhawkState, DoctorCheck, WorldInfo, WorldState } from '@shared/types'
import { quarantineCorruptWorlds } from '../ap/install-steps'
import { checkGlibc } from '../ap/installer-linux'
import type { Locator } from '../ap/locator'
import type { ProcessInfo } from '../ap/processes'
import { fetchLatestApRelease } from '../ap/releases'
import type { CoreContext, Http } from '../context'
import type { ExecFn } from '../exec'
import { disabledWorldsDir, scanWorlds } from '../worlds/inventory'
import { isPortFree } from './net'
import { psQuote, runPowerShell } from './powershell'
import { redact } from './redact'

/** Below this, installing or generating may run out of room. */
export const MIN_FREE_BYTES = 1024 ** 3
/** A clock further off than this breaks TLS and signed downloads. */
export const MAX_CLOCK_SKEW_S = 300
const NETWORK_PROBE_URL = 'https://github.com'
const NETWORK_TIMEOUT_MS = 5000
const ACL_TIMEOUT_MS = 15_000
const MIN_GLIBC = '2.35'

export interface NetworkStatus {
  online: boolean
  /** Local clock minus the server's, in seconds; null when the server sent no date. */
  clockSkewS: number | null
}

export interface DoctorDeps {
  ctx: CoreContext
  locator: Pick<Locator, 'detect'>
  /** `ApSettings.file`: the settings file Archipelago loads. */
  settingsFile: () => Promise<string>
  bizhawkState: () => Promise<BizhawkState>
  listProcesses: () => Promise<ProcessInfo[]>
  /** Ports of the app's own running servers: busy, and never probed (a probe shows in their console). */
  ownServerPorts?: () => number[]
  // The probes below default to the real ones.
  latestRelease?: () => Promise<ApRelease>
  isPortFree?: (port: number) => Promise<boolean>
  checkGlibc?: () => Promise<{ version: string | null; ok: boolean }>
  freeBytes?: (dir: string) => Promise<number>
  everyoneCanModify?: (dir: string) => Promise<boolean>
  network?: () => Promise<NetworkStatus>
}

type Params = DoctorCheck['params']
type Fix = DoctorCheck['fix']

const AUTO: Fix = { kind: 'auto' }
const INSTALL_SCREEN: Fix = { kind: 'navigate', to: '/install' }
const WORLDS_SCREEN: Fix = { kind: 'navigate', to: '/worlds' }
const VAULT_SCREEN: Fix = { kind: 'navigate', to: '/vault' }

function check(
  id: DoctorCheckId,
  severity: DoctorCheck['severity'],
  params: Params = {},
  fix: Fix = null,
): DoctorCheck {
  const shown = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]),
  )
  return { id, severity, params: shown, fix }
}

/** Nothing to check here (no Archipelago, another system…): passing, with the reason. */
const skipped = (id: DoctorCheckId, reason: string): DoctorCheck => check(id, 'ok', { skipped: reason })

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The free space of the volume that holds `dir`, in bytes. */
export async function freeBytes(dir: string): Promise<number> {
  const info = await statfs(dir)
  return info.bavail * info.bsize
}

/** Whether github.com answers, and how far the local clock is from its `Date`. */
export async function probeNetwork(
  http: Pick<Http, 'fetchRaw'>,
  now: () => number = Date.now,
): Promise<NetworkStatus> {
  try {
    const res = await http.fetchRaw(NETWORK_PROBE_URL, { method: 'HEAD', timeoutMs: NETWORK_TIMEOUT_MS })
    await res.body?.cancel().catch(() => undefined)
    const server = Date.parse(res.headers.get('date') ?? '')
    return { online: true, clockSkewS: Number.isNaN(server) ? null : Math.round((now() - server) / 1000) }
  } catch {
    return { online: false, clockSkewS: null }
  }
}

/**
 * Whether Everyone, Users or Authenticated Users may modify `dir` (Inno's `everyone-modify`), read by
 * SID: the group names are translated. Creating files alone, which every ProgramData folder inherits,
 * does not count.
 */
export async function everyoneCanModify(exec: ExecFn, dir: string): Promise<boolean> {
  const script = [
    `$acl = Get-Acl -LiteralPath ${psQuote(dir)}`,
    "$groups = @('S-1-1-0', 'S-1-5-32-545', 'S-1-5-11')",
    '$modify = [System.Security.AccessControl.FileSystemRights]::Modify',
    '$open = $false',
    'foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {',
    "  if ($rule.AccessControlType -ne 'Allow' -or $groups -notcontains $rule.IdentityReference.Value) { continue }",
    '  if (($rule.FileSystemRights -band $modify) -eq $modify) { $open = $true }',
    '}',
    "if ($open) { 'true' } else { 'false' }",
  ].join('\n')
  const result = await runPowerShell(exec, script, { timeoutMs: ACL_TIMEOUT_MS })
  if (result.code !== 0) throw new Error(`Get-Acl failed (exit ${result.code}): ${result.stderr.trim()}`)
  return result.stdout.trim() === 'true'
}

/** What one run computes once and several checks read. */
interface Run {
  install: Promise<ApInstall | null>
  worlds: Promise<WorldInfo[] | null>
}

type Runner = (run: Run) => Promise<DoctorCheck>

/** The worlds in `state` Archipelago would trip on. */
function worldsCheck(id: DoctorCheckId, state: WorldState, severity: DoctorCheck['severity']): Runner {
  return async ({ worlds }) => {
    const all = await worlds
    if (!all) return skipped(id, 'ap-not-installed')
    // A core world that a newer custom one replaces is shadowed on purpose.
    const hit = all.filter(
      (w) => w.states.includes(state) && (state !== 'shadowed' || w.location === 'custom'),
    )
    if (hit.length === 0) return check(id, 'ok')
    // Only a custom world can be set aside; a broken core world needs Archipelago reinstalled.
    const fix =
      state === 'corrupt' ? (hit.some((w) => w.location === 'custom') ? AUTO : INSTALL_SCREEN) : WORLDS_SCREEN
    return check(id, severity, { count: hit.length, files: hit.map((w) => w.fileName).join(', ') }, fix)
  }
}

function runners(deps: DoctorDeps): Record<DoctorCheckId, Runner> {
  const { ctx } = deps
  const { os } = ctx.platform
  const latestRelease = deps.latestRelease ?? (() => fetchLatestApRelease(ctx.http))
  const portFree = deps.isPortFree ?? isPortFree
  const glibc = deps.checkGlibc ?? (() => checkGlibc(ctx.exec))
  const free = deps.freeBytes ?? freeBytes
  const modifiable = deps.everyoneCanModify ?? ((dir: string) => everyoneCanModify(ctx.exec, dir))
  const network = deps.network ?? (() => probeNetwork(ctx.http))

  return {
    'ap-installed': async ({ install }) => {
      const found = await install
      if (!found) return check('ap-installed', 'error', {}, INSTALL_SCREEN)
      return check('ap-installed', 'ok', { version: found.version ?? 'unknown', path: found.root })
    },

    'ap-update': async ({ install }) => {
      const found = await install
      if (!found) return skipped('ap-update', 'ap-not-installed')
      let latest: ApRelease
      try {
        latest = await latestRelease()
      } catch (error) {
        // The network check tells why; the version itself is not in question.
        return check('ap-update', 'ok', { skipped: 'release-unavailable', error: errorText(error) })
      }
      const params = { installed: found.version ?? 'unknown', latest: latest.version }
      const installed = semver.coerce(found.version)
      const newest = semver.coerce(latest.version)
      // A version that cannot be read (no manifest.json) cannot be compared: worth a look.
      if (!installed || !newest) return check('ap-update', 'info', params, INSTALL_SCREEN)
      return semver.lt(installed, newest)
        ? check('ap-update', 'warning', params, INSTALL_SCREEN)
        : check('ap-update', 'ok', params)
    },

    'settings-file': async ({ install }) => {
      if (!(await install)) return skipped('settings-file', 'ap-not-installed')
      const file = await deps.settingsFile()
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        // Archipelago writes a new one on its next start: a note, not a problem.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return check('settings-file', 'info', { path: file, reason: 'missing' })
        return check('settings-file', 'error', { path: file, reason: 'unreadable', error: errorText(error) })
      }
      // YAML 1.1, as PyYAML reads it: a file it cannot parse stops every Archipelago program.
      const [error] = parseDocument(text.replaceAll('\r\n', '\n'), { version: '1.1' }).errors
      if (error) {
        return check('settings-file', 'error', {
          path: file,
          reason: 'yaml',
          line: error.linePos?.[0].line ?? 0,
        })
      }
      return check('settings-file', 'ok', { path: file })
    },

    'worlds-corrupt': worldsCheck('worlds-corrupt', 'corrupt', 'error'),
    'worlds-no-manifest': worldsCheck('worlds-no-manifest', 'no-manifest', 'warning'),
    'worlds-incompatible': worldsCheck('worlds-incompatible', 'incompatible', 'warning'),
    'worlds-shadowed': worldsCheck('worlds-shadowed', 'shadowed', 'warning'),

    'ap-processes': async () => {
      const running = await deps.listProcesses()
      if (running.length === 0) return check('ap-processes', 'ok')
      return check('ap-processes', 'warning', {
        count: running.length,
        processes: running.map((p) => p.name).join(', '),
      })
    },

    'port-38281': async () => {
      if ((deps.ownServerPorts?.() ?? []).includes(DEFAULT_PORT)) {
        return check('port-38281', 'info', { port: DEFAULT_PORT, owner: 'archipelagoat' })
      }
      return (await portFree(DEFAULT_PORT))
        ? check('port-38281', 'ok', { port: DEFAULT_PORT })
        : check('port-38281', 'warning', { port: DEFAULT_PORT })
    },

    bizhawk: async () => {
      const state = await deps.bizhawkState()
      // Only some games need it: missing is a note.
      if (!state.installed) return check('bizhawk', 'info', {}, VAULT_SCREEN)
      const missing = state.prereqs.filter((p) => !p.ok).map((p) => p.name)
      if (missing.length === 0) return check('bizhawk', 'ok', { version: state.version ?? 'unknown' })
      return check('bizhawk', 'warning', { missing: missing.join(', ') }, VAULT_SCREEN)
    },

    'disk-space': async ({ install }) => {
      const found = await install
      const dirs = [...new Set([ctx.platform.paths.dataRoot, ...(found ? [found.paths.userPath] : [])])]
      let lowest: { path: string; bytes: number } | null = null
      for (const dir of dirs) {
        // A folder Archipelago has not created yet (an AppImage's data) has nothing to measure.
        const bytes = await free(dir).catch(() => null)
        if (bytes !== null && (lowest === null || bytes < lowest.bytes)) lowest = { path: dir, bytes }
      }
      if (lowest === null) throw new Error(`cannot read the free space of ${dirs.join(', ')}`)
      const params = { path: lowest.path, freeMb: Math.floor(lowest.bytes / 1024 ** 2) }
      return check('disk-space', lowest.bytes < MIN_FREE_BYTES ? 'warning' : 'ok', params)
    },

    'programdata-acl': async ({ install }) => {
      if (os !== 'win32') return skipped('programdata-acl', 'not-windows')
      const found = await install
      // The official installer's folder (C:\ProgramData\Archipelago by default).
      if (found?.kind !== 'windows-installer') return skipped('programdata-acl', 'no-installer-folder')
      // Spec: information only. Anyone may drop code there that runs when someone else starts AP.
      return (await modifiable(found.root))
        ? check('programdata-acl', 'info', { path: found.root })
        : check('programdata-acl', 'ok', { path: found.root })
    },

    glibc: async () => {
      if (os !== 'linux') return skipped('glibc', 'not-linux')
      const { version, ok } = await glibc()
      if (ok) return check('glibc', 'ok', { version: version ?? 'unknown' })
      return check('glibc', version === null ? 'warning' : 'error', {
        version: version ?? 'unknown',
        min: MIN_GLIBC,
      })
    },

    network: async () => {
      const { online, clockSkewS } = await network()
      if (!online) return check('network', 'warning', { reason: 'offline' })
      if (clockSkewS !== null && Math.abs(clockSkewS) > MAX_CLOCK_SKEW_S) {
        return check('network', 'warning', { reason: 'clock', skewS: clockSkewS })
      }
      return check('network', 'ok')
    },
  }
}

/** Every check, in the order of DOCTOR_CHECK_IDS, run at the same time. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const { ctx } = deps
  const install = deps.locator.detect()
  const run: Run = {
    install,
    worlds: install.then((found) =>
      found ? scanWorlds(found.paths, disabledWorldsDir(ctx.platform.paths.dataRoot), found.version) : null,
    ),
  }
  // Rejections are handled by each check that reads them.
  run.worlds.catch(() => undefined)
  const all = runners(deps)
  return Promise.all(
    DOCTOR_CHECK_IDS.map(async (id) => {
      try {
        return await all[id](run)
      } catch (error) {
        ctx.log.warn(`doctor: the ${id} check failed`, error)
        return check(id, 'info', { error: errorText(error) })
      }
    }),
  )
}

/**
 * Runs the automatic fix of `checkId`, then every check again. Only `worlds-corrupt` has one: the
 * corrupt custom worlds move to `dataRoot/disabled-worlds`, where the worlds screen lists them.
 */
export async function fixDoctor(checkId: DoctorCheckId, deps: DoctorDeps): Promise<DoctorCheck[]> {
  if (checkId !== 'worlds-corrupt') {
    throw new AppError('INVALID_INPUT', { checkId }, { detail: `no automatic fix for ${checkId}` })
  }
  const install = await deps.locator.detect()
  if (!install) throw new AppError('AP_NOT_INSTALLED')
  const moved = await quarantineCorruptWorlds(deps.ctx, install)
  if (moved.length > 0) deps.ctx.bus.emit('worlds:changed', null)
  return runDoctor(deps)
}
