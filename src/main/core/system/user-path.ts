// Checks every path that comes from the renderer before the main process touches it (spec §6.1).
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@shared/errors'
import type { OS } from '@shared/types'
import type { AllowedPaths } from '../context'

export interface UserPathOptions {
  /** Default true: a missing path is NOT_FOUND. */
  mustExist?: boolean
  kind?: 'file' | 'dir'
  /** Accepted extensions, with their dot (case-insensitive), e.g. ['.yaml', '.yml']. */
  exts?: string[]
  /** Default 'read'. 'write' also refuses Program Files. */
  access?: 'read' | 'write'
}

/** What the checks depend on; tests pass their own to cover both OSes. */
export interface UserPathEnv {
  os: OS
  windir: string | null
  /** ArchipelaGOAT's own installation folder. */
  appDir: string
}

const hostOs = (): OS => (process.platform === 'win32' ? 'win32' : 'linux')

export function currentUserPathEnv(): UserPathEnv {
  const os = hostOs()
  return {
    os,
    windir: os === 'win32' ? (process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows') : null,
    appDir: path.dirname(process.execPath),
  }
}

const LINUX_SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/proc', '/sys']
const WIN_PROGRAM_FILES = /^[a-z]:\\program files[^\\]*(\\|$)/i

const forbidden = (reason: string, p: string): AppError =>
  new AppError('PATH_FORBIDDEN', { reason }, { detail: p })

const lib = (os: OS): path.PlatformPath => (os === 'win32' ? path.win32 : path.posix)

/** Normalizes and drops a trailing separator, except at the root (`C:\`, `/`). */
function normalize(p: string, os: OS): string {
  const normalized = lib(os).normalize(p)
  const root = lib(os).parse(normalized).root
  if (normalized.length <= root.length) return normalized
  return normalized.replace(os === 'win32' ? /[\\/]+$/ : /\/+$/, '')
}

/** CON, NUL, COM1… (with or without an extension) name devices, not files, for the Win32 API. */
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|\s|$)/i

/**
 * Refuses empty, relative, drive-relative and UNC / device-namespace paths (`\\?\`, `\\.\`,
 * `\\server`); on Windows, also device names and alternate data streams (`file.yaml:stream`).
 */
function absolute(p: string, os: OS): string {
  if (!p || p.includes('\0')) throw forbidden('invalid', p)
  if (os === 'win32') {
    if (/^[\\/]{2}/.test(p)) throw forbidden('unc', p)
    if (!/^[a-z]:[\\/]/i.test(p)) throw forbidden('relative', p)
    if (p.slice(2).includes(':')) throw forbidden('invalid', p)
  } else if (!p.startsWith('/')) {
    throw forbidden('relative', p)
  }
  const normalized = normalize(p, os)
  if (os === 'win32' && normalized.split('\\').some((part) => WIN_DEVICE.test(part))) {
    throw forbidden('device', p)
  }
  return normalized
}

function isInside(child: string, parent: string, os: OS): boolean {
  const fold = (s: string): string => (os === 'win32' ? s.toLowerCase() : s)
  const c = fold(child)
  const p = fold(parent)
  const sep = os === 'win32' ? '\\' : '/'
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** System folders, Program Files for writes, and the app's own folder. */
function checkLocation(p: string, access: 'read' | 'write', env: UserPathEnv): void {
  if (env.os === 'win32') {
    if (env.windir && isInside(p, normalize(env.windir, 'win32'), 'win32')) throw forbidden('system', p)
    if (access === 'write' && WIN_PROGRAM_FILES.test(p)) throw forbidden('program-files', p)
  } else if (LINUX_SYSTEM_DIRS.some((dir) => isInside(p, dir, 'linux'))) {
    throw forbidden('system', p)
  }
  if (env.appDir && isInside(p, normalize(env.appDir, env.os), env.os)) throw forbidden('app-dir', p)
}

async function statOrNull(p: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(p)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw forbidden('unreadable', p)
  }
}

/** The env folders resolved like the paths compared with them (8.3 names, symlinks). */
async function resolveEnv(env: UserPathEnv): Promise<UserPathEnv> {
  const resolve = (p: string): Promise<string> =>
    realpath(p).then(
      (r) => normalize(r, env.os),
      () => p,
    )
  return { ...env, appDir: await resolve(env.appDir), windir: env.windir && (await resolve(env.windir)) }
}

/** Where a missing path would land: its closest existing parent, resolved, plus the rest. */
async function resolveMissing(p: string, os: OS): Promise<string | null> {
  const paths = lib(os)
  const rest: string[] = []
  for (let current = p; paths.dirname(current) !== current;) {
    rest.unshift(paths.basename(current))
    current = paths.dirname(current)
    try {
      return paths.join(normalize(await realpath(current), os), ...rest)
    } catch {
      // Missing as well: try the next parent up.
    }
  }
  return null
}

/**
 * Returns the normalized path, or throws PATH_FORBIDDEN (`params.reason` says why) or NOT_FOUND.
 * Every handler that receives a path from the renderer calls it.
 */
export async function assertUserPath(
  p: string,
  opts: UserPathOptions = {},
  env: UserPathEnv = currentUserPathEnv(),
): Promise<string> {
  const access = opts.access ?? 'read'
  const normalized = absolute(p, env.os)
  checkLocation(normalized, access, env)
  if (opts.exts) {
    const name = lib(env.os).basename(normalized).toLowerCase()
    if (!opts.exts.some((ext) => name.endsWith(ext.toLowerCase()))) throw forbidden('extension', normalized)
  }

  // An env for the other OS (tests) only gets the checks above: its paths mean nothing here.
  if (env.os !== hostOs()) return normalized

  const info = await statOrNull(normalized)
  // A symlink or junction, in the path or in one of its parents, must not lead somewhere forbidden.
  // (A mapped network drive may resolve to a UNC path: only the location rules apply to it.)
  const resolved = info
    ? normalize(await realpath(normalized), env.os)
    : await resolveMissing(normalized, env.os)
  if (resolved) checkLocation(resolved, access, await resolveEnv(env))
  if (!info) {
    if (opts.mustExist ?? true) throw new AppError('NOT_FOUND', undefined, { detail: normalized })
    return normalized
  }
  if (opts.kind === 'file' && !info.isFile()) throw forbidden('not-a-file', normalized)
  if (opts.kind === 'dir' && !info.isDirectory()) throw forbidden('not-a-dir', normalized)
  return normalized
}

/** `ctx.paths`: a path is allowed when it, and its resolved target, sit inside one of the roots. */
export function createAllowedPaths(defaultRoots: string[], os: OS = hostOs()): AllowedPaths {
  const providers: (() => Promise<string[]>)[] = []
  // Symlinks can only be resolved for paths of the OS we run on.
  const resolve = async (p: string): Promise<string | null> => {
    if (os !== hostOs()) return null
    try {
      return normalize(await realpath(p), os)
    } catch {
      return null
    }
  }

  return {
    addAllowedRoots(provider) {
      providers.push(provider)
    },
    async isAllowed(p) {
      let target: string
      try {
        target = absolute(p, os)
      } catch {
        return false
      }
      const provided = await Promise.all(providers.map((provider) => provider().catch(() => [])))
      const roots = [...defaultRoots, ...provided.flat()].flatMap((root) => {
        try {
          return [absolute(root, os)]
        } catch {
          return []
        }
      })
      const resolvedRoots = (await Promise.all(roots.map(resolve))).filter((r): r is string => r !== null)
      const inside = (x: string): boolean =>
        [...roots, ...resolvedRoots].some((root) => isInside(x, root, os))
      if (!inside(target)) return false
      const real = await resolve(target)
      return real === null || inside(real)
    },
  }
}
