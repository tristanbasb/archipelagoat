// Archipelago's settings file (spec §3.6). AP loads exactly one file, options.yaml or host.yaml
// (settings.py:885-907, research brief C3): that file is the one read and edited, as YAML 1.1 (PyYAML's
// dialect) with its comments, only while no Archipelago program runs (AP saves its own copy at exit),
// backed up first and replaced atomically. The app's own session programs do not count: they run in
// their session folder and only ever load and save that folder's host.yaml. A session gets its own complete copy in its folder, which
// its programs load because they run there (cwd = session folder, research brief §1.7).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isNode, parseDocument, type Document } from 'yaml'
import { AppError } from '@shared/errors'
import type { CoreContext } from '../context'
import { backupFile, writeFileAtomic } from '../system/fsx'
import { resolveSettingsFile, type Locator } from './locator'
import { listApProcesses, sessionScopedPids } from './processes'

/** Keys from the top of the file: `['bizhawkclient_options', 'emuhawk_path']`. */
export type SettingsPath = readonly string[]

export interface SettingsEntry {
  path: SettingsPath
  value: unknown
}

export interface ApSettings {
  /** The file Archipelago loads, looked up again on each call. AP_NOT_INSTALLED without an install. */
  file(): Promise<string>
  /** The value at `path`, as plain data; undefined when the key or the file is missing. */
  get(path: SettingsPath): Promise<unknown>
  /**
   * Writes every entry in one go, one call after the other. SETTINGS_LOCKED{processes} while an
   * Archipelago program runs, the app's own session programs excepted; YAML_PARSE (file untouched)
   * when the file cannot be read. Creates `host.yaml` when there is no settings file, never
   * `options.yaml`.
   */
  set(entries: readonly SettingsEntry[]): Promise<void>
  /**
   * Writes `sessionDir/host.yaml`: the effective file (or an empty document) with the entries applied,
   * and returns its path. No lock: that file belongs to the session.
   */
  makeSessionSettings(sessionDir: string, entries: readonly SettingsEntry[]): Promise<string>
}

/** The keys other services write (BizHawk, ROM table). */
export const SETTINGS_KEYS = {
  emuhawkPath: ['bizhawkclient_options', 'emuhawk_path'],
  romStart: ['bizhawkclient_options', 'rom_start'],
  /** A ROM table key, `'lttp_options.rom_file'`, as a path. */
  romFile(key: string): SettingsPath {
    const path = key.split('.')
    if (path.length < 2 || path.includes('')) {
      throw new AppError('INVALID_INPUT', undefined, { detail: `settings key: ${key}` })
    }
    return path
  },
} as const

const SESSION_FILE = 'host.yaml'
const BACKUP_LABEL = 'settings'

/** The file's text; null when it does not exist. */
async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** YAML 1.1 like PyYAML (`yes` is a boolean). A file AP could not load either is refused. */
function parseSettings(text: string, file: string): Document {
  // Parsed as LF: the yaml package keeps the `\r` of some CRLF comment lines.
  const doc = parseDocument(text.replaceAll('\r\n', '\n'), { version: '1.1' })
  const [error] = doc.errors
  if (error) {
    const at = error.linePos?.[0]
    const params: Record<string, string | number> = at ? { file, line: at.line, column: at.col } : { file }
    throw new AppError('YAML_PARSE', params, { detail: error.message, cause: error })
  }
  return doc
}

/**
 * Makes every parent of `path` a mapping before `setIn`: in YAML 1.1, `setIn` would create a missing
 * one as `!!omap`, which PyYAML reads as a list. A parent that is not a mapping (`group:` left empty)
 * is replaced, as AP does: it ignores such a group and saves its defaults over it.
 */
function ensureParents(doc: Document, path: SettingsPath): void {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({})
  for (let end = 1; end < path.length; end++) {
    const parent = path.slice(0, end)
    if (!isMap(doc.getIn(parent, true))) doc.setIn(parent, doc.createNode({}))
  }
}

/** `text` (null: no file yet) with the entries applied, in the file's line endings. */
function applyEntries(text: string | null, entries: readonly SettingsEntry[], file: string): string {
  const doc = parseSettings(text ?? '', file)
  for (const { path, value } of entries) {
    if (path.length === 0) throw new AppError('INVALID_INPUT', undefined, { detail: 'empty settings path' })
    ensureParents(doc, path)
    // An existing scalar keeps its style (quotes) and its comments.
    doc.setIn(path, value)
  }
  const out = doc.toString({ lineWidth: 0 })
  // Python writes CRLF on Windows (text mode): keep what the file had.
  return text?.includes('\r\n') ? out.replaceAll('\n', '\r\n') : out
}

export interface ApSettingsOptions {
  /**
   * The pids of the app's own session programs (a generation, a local server): they run in their
   * session folder and never save over the file this service writes. Default: sessionScopedPids.
   */
  sessionPids?: () => ReadonlySet<number>
}

export function createApSettings(
  ctx: CoreContext,
  locator: Locator,
  opts: ApSettingsOptions = {},
): ApSettings {
  const sessionPids = opts.sessionPids ?? sessionScopedPids
  const backupsRoot = join(ctx.platform.paths.dataRoot, 'backups')
  let writes: Promise<unknown> = Promise.resolve()

  async function file(): Promise<string> {
    const install = await locator.detect()
    if (!install) throw new AppError('AP_NOT_INSTALLED')
    const { localPath, userPath } = install.paths
    // AP runs in its install folder; an AppImage's folder is inside its mount, so it runs in userPath.
    return resolveSettingsFile(localPath, userPath, localPath || userPath, existsSync)
  }

  async function write(entries: readonly SettingsEntry[]): Promise<void> {
    if (entries.length === 0) return
    // A running program would save its own copy over ours when it exits. A session's program loads the
    // host.yaml of its session folder (its cwd), so it cannot.
    const own = sessionPids()
    const running = (await listApProcesses(ctx.exec, ctx.platform.os)).filter((p) => !own.has(p.pid))
    if (running.length > 0) {
      const processes = [...new Set(running.map((p) => p.name))].join(', ')
      throw new AppError('SETTINGS_LOCKED', { processes })
    }
    const target = await file()
    const text = await readIfExists(target)
    const next = applyEntries(text, entries, target)
    if (text !== null) await backupFile(target, backupsRoot, BACKUP_LABEL)
    await writeFileAtomic(target, next)
    ctx.log.info('settings: written', { file: target, keys: entries.map((e) => e.path.join('.')) })
  }

  return {
    file,

    async get(path) {
      const target = await file()
      const text = await readIfExists(target)
      if (text === null) return undefined
      const doc = parseSettings(text, target)
      const value: unknown = doc.getIn(path)
      return isNode(value) ? (value.toJS(doc) as unknown) : value
    },

    set(entries) {
      // One write at a time: two writes started together would both edit the same original.
      const run = writes.then(() => write(entries))
      writes = run.catch(() => undefined)
      return run
    },

    async makeSessionSettings(sessionDir, entries) {
      const source = await file()
      const dest = join(sessionDir, SESSION_FILE)
      await writeFileAtomic(dest, applyEntries(await readIfExists(source), entries, source))
      return dest
    },
  }
}
