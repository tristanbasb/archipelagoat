// The folder of a session, `dataRoot/sessions/<id>/` (spec §2.3, §3.13): `session.json`, `players/`,
// `output/`, `logs/` and the session's own `host.yaml`. Archipelago's Generate reads every top-level
// file of the players folder (Generate.py:129-148), so only YAML files land there, under names that are
// safe on every OS: what the player files are made of is read here, from files and zips, in memory.
// The folder is private on Linux (0700), the host.yaml too (0600): it holds the server passwords. On
// Windows, %LOCALAPPDATA% is already the user's own.
import { chmod, cp, mkdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ApSettings, SettingsEntry } from '@main/core/ap/settings'
import { listZip, readZipBytes } from '@main/core/system/archive'
import { decodeYamlBytes, loadYaml11 } from '@main/core/yaml/load'
import { AppError } from '@shared/errors'
import type { Issue, OS } from '@shared/types'

/** `s_` + base36 time + 4 base36 characters. */
export const SESSION_ID_RE = /^s_[0-9a-z]+$/
/** A player file is a few kilobytes: anything this big is not one. */
export const MAX_PLAYER_FILE_BYTES = 8 * 1024 * 1024

const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600
/** A zip of player files holds a few of them. */
const ZIP_LIMITS = { maxEntries: 1000, maxUncompressed: 64 * 1024 * 1024 }
const PLAYER_EXTENSIONS = new Set(['.yaml', '.yml', '.txt'])
const SOURCE_EXTENSION = /\.(?:ya?ml|txt)$/i
const STEM_MAX = 64
const DEFAULT_STEM = 'player'
/** CON, NUL, COM1… name devices on Windows, with or without an extension. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i
/** Generate.py reads these as the weights and meta files of the generation, not as players. */
const RESERVED_NAMES = ['weights.yaml', 'meta.yaml']
const MOVE_ATTEMPTS = 5
const MOVE_RETRY_MS = 50

export interface WorkspacePaths {
  dir: string
  sessionFile: string
  players: string
  output: string
  logs: string
}

export const sessionsRoot = (dataRoot: string): string => path.join(dataRoot, 'sessions')

/** The folders of session `id`; NOT_FOUND when `id` is not a session id (it never leaves `sessions/`). */
export function workspacePaths(dataRoot: string, id: string): WorkspacePaths {
  if (!SESSION_ID_RE.test(id)) throw new AppError('NOT_FOUND', undefined, { detail: `session ${id}` })
  const dir = path.join(sessionsRoot(dataRoot), id)
  return {
    dir,
    sessionFile: path.join(dir, 'session.json'),
    players: path.join(dir, 'players'),
    output: path.join(dir, 'output'),
    logs: path.join(dir, 'logs'),
  }
}

/** Creates the session folder (EEXIST when it is already there) and its subfolders, owner-only. */
export async function createWorkspace(ws: WorkspacePaths): Promise<void> {
  await mkdir(path.dirname(ws.dir), { recursive: true })
  await mkdir(ws.dir, { mode: PRIVATE_DIR })
  for (const dir of [ws.players, ws.output, ws.logs]) await mkdir(dir, { mode: PRIVATE_DIR })
}

/**
 * Writes the session's host.yaml (the effective settings with `entries` applied) and makes it
 * owner-only on Linux. Every write of that file goes through here: each write is a new file.
 */
export async function writeSessionHostYaml(
  settings: Pick<ApSettings, 'makeSessionSettings'>,
  workspace: string,
  entries: readonly SettingsEntry[],
  os: OS,
): Promise<string> {
  const file = await settings.makeSessionSettings(workspace, entries)
  if (os === 'linux') await chmod(file, PRIVATE_FILE)
  return file
}

// --- names ---------------------------------------------------------------------------------------

const casefold = (name: string): string => name.toLowerCase()

/**
 * The name a player file gets in `players/`: its stem (accents dropped, anything else outside
 * `[A-Za-z0-9 _.-]` turned into `_`, at most 64 characters) + `.yaml`, `-2`, `-3`… when the name is
 * taken (case-insensitively, as on Windows). Never a dotfile (Generate skips them), a Windows device
 * name, `weights.yaml` or `meta.yaml`. A file without `name:` is called after its stem by Archipelago.
 */
export function storedNameFor(originalName: string, existing: readonly string[]): string {
  const base = originalName.split(/[\\/]/).pop() ?? ''
  let stem = base
    .replace(SOURCE_EXTENSION, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9 _.-]+/g, '_')
    .slice(0, STEM_MAX)
    .replace(/^[ ._]+|[ ._]+$/g, '')
  if (stem === '') stem = DEFAULT_STEM
  if (WINDOWS_DEVICE.test(stem)) stem = `_${stem}`
  const taken = new Set([...existing.map(casefold), ...RESERVED_NAMES])
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}.yaml` : `${stem}-${n}.yaml`
    if (!taken.has(casefold(name))) return name
  }
}

// --- imports -------------------------------------------------------------------------------------

export interface ImportedFile {
  originalName: string
  text: string
  /** What the decoding found (`encoding-fallback`). */
  issues: Issue[]
}

const extensionOf = (name: string): string => path.extname(name).toLowerCase()

/** True when `text` is YAML with a document a player file could be: a mapping with a name or a game. */
function looksLikePlayer(text: string): boolean {
  const { docs, issues } = loadYaml11(text)
  return (
    issues.length === 0 &&
    docs.some(
      (doc) =>
        typeof doc === 'object' &&
        doc !== null &&
        !Array.isArray(doc) &&
        (Object.hasOwn(doc, 'game') || Object.hasOwn(doc, 'name')),
    )
  )
}

/**
 * A player file from its bytes: a .yaml or .yml file always (its errors will be shown), a .txt file
 * only when it holds YAML. Null otherwise.
 */
function playerFile(originalName: string, bytes: Uint8Array): ImportedFile | null {
  const { text, issues } = decodeYamlBytes(bytes)
  if (extensionOf(originalName) === '.txt' && !looksLikePlayer(text)) return null
  return { originalName, text, issues }
}

/** The bytes of a regular file of at most MAX_PLAYER_FILE_BYTES; null for anything else. */
async function readPlayerBytes(file: string): Promise<Buffer | null> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_PLAYER_FILE_BYTES) return null
    return await readFile(file)
  } catch {
    return null
  }
}

/** The player files of a zip, read in memory; null when the zip cannot be read within its limits. */
async function importZip(zip: string): Promise<{ files: ImportedFile[]; ignored: string[] } | null> {
  let entries: Awaited<ReturnType<typeof listZip>>
  try {
    entries = await listZip(zip, ZIP_LIMITS)
  } catch {
    return null
  }
  const files: ImportedFile[] = []
  const ignored: string[] = []
  for (const entry of entries) {
    const parts = entry.name.split('/')
    const name = parts.at(-1) ?? ''
    // Folders, the resource forks macOS adds and dotfiles are not files anyone dropped.
    if (entry.isDir || parts[0] === '__MACOSX' || name.startsWith('.')) continue
    const label = path.join(zip, ...parts)
    let bytes: Buffer | null = null
    if (PLAYER_EXTENSIONS.has(extensionOf(name)) && entry.size <= MAX_PLAYER_FILE_BYTES) {
      bytes = await readZipBytes(zip, entry.name, MAX_PLAYER_FILE_BYTES).catch(() => null)
    }
    const file = bytes && playerFile(name, bytes)
    if (file) files.push(file)
    else ignored.push(label)
  }
  return { files, ignored }
}

/**
 * Reads player files from `paths`: .yaml, .yml, .txt holding YAML, and the same inside zips (in
 * memory, within limits). Every byte goes through `decodeYamlBytes`, so a Windows-1252 file keeps its
 * `encoding-fallback` warning. `ignored` lists what is not a player file: a path as given, or
 * `<zip>/<entry>` for an entry (the zip itself when nothing in it is one).
 */
export async function importPlayerSources(
  paths: readonly string[],
): Promise<{ files: ImportedFile[]; ignored: string[] }> {
  const files: ImportedFile[] = []
  const ignored: string[] = []
  for (const source of paths) {
    const extension = extensionOf(source)
    if (extension === '.zip') {
      const found = await importZip(source)
      if (found === null || found.files.length === 0) {
        ignored.push(source)
      } else {
        files.push(...found.files)
        ignored.push(...found.ignored)
      }
      continue
    }
    const bytes = PLAYER_EXTENSIONS.has(extension) ? await readPlayerBytes(source) : null
    const file = bytes && playerFile(path.basename(source), bytes)
    if (file) files.push(file)
    else ignored.push(source)
  }
  return { files, ignored }
}

// --- backups -------------------------------------------------------------------------------------

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Local time, `YYYYMMDD-HHmmss`, as the other backups. */
function timestamp(d: Date): string {
  const date = `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  return `${date}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Renames a folder; copies then deletes it across volumes. Retries what an antivirus holds. */
async function moveDir(src: string, dest: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(src, dest)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        await cp(src, dest, { recursive: true, errorOnExist: true, force: false })
        return await rm(src, { recursive: true })
      }
      if (attempt < MOVE_ATTEMPTS && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await sleep(MOVE_RETRY_MS)
        continue
      }
      throw error
    }
  }
}

/**
 * Moves the session folder `dir` to `backupsRoot/<YYYYMMDD-HHmmss>-session[-n]/<id>` and returns its
 * new path: a second backup in the same second gets its own folder.
 */
export async function moveWorkspaceToBackups(dir: string, backupsRoot: string): Promise<string> {
  await mkdir(backupsRoot, { recursive: true })
  const label = `${timestamp(new Date())}-session`
  for (let n = 1; ; n++) {
    const holder = path.join(backupsRoot, n === 1 ? label : `${label}-${n}`)
    try {
      await mkdir(holder)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    const dest = path.join(holder, path.basename(dir))
    try {
      await moveDir(dir, dest)
    } catch (error) {
      await rmdir(holder).catch(() => undefined)
      throw error
    }
    return dest
  }
}
