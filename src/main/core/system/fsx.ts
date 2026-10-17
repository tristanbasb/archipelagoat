// File helpers of the main process: atomic writes, real writability tests, containment of joined
// paths, timestamped backups and moves across volumes. (json-file.ts keeps the synchronous writes of
// config.json and secrets.bin; these are the asynchronous, general-purpose ones.)
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, open, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '@shared/errors'

const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 20

/** On Windows an antivirus scan can hold a fresh file for a moment (EPERM / EBUSY / EACCES). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < RENAME_ATTEMPTS && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await sleep(RENAME_RETRY_MS)
        continue
      }
      throw error
    }
  }
}

/**
 * Has `fill` write a temporary file next to `path`, then renames it over `path`; the temporary file
 * is removed when anything fails, and the old content stays. Creates the parent folders.
 */
async function replaceAtomically(path: string, fill: (tmp: string) => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await fill(tmp)
    await renameWithRetry(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Writes `data` to a temporary file next to `path`, flushes it, then renames it over `path`: a crash
 * leaves the old content or the new one, never half of it. Creates the parent folders.
 */
export function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  return replaceAtomically(path, async (tmp) => {
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
}

/** `writeFileAtomic` for a stream (an archive entry): nothing is left at `path` if the stream fails. */
export async function writeStreamAtomic(path: string, source: Readable): Promise<void> {
  // A stream may start to flow, and to fail, as soon as it exists: listen to it at once (an error
  // nobody listens to would crash the process); `pipeline` still reports it.
  source.on('error', () => undefined)
  try {
    await replaceAtomically(path, (tmp) => pipeline(source, createWriteStream(tmp)))
  } finally {
    // Frees what the stream holds (the zip file stays open while one of its streams does).
    source.destroy()
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true })
}

/**
 * True when a file can really be created in the folder: a write test, because `access` ignores
 * ACLs, read-only mounts and what a virtualized folder (Program Files) does. Never creates `p`.
 */
export async function isWritableDir(p: string): Promise<boolean> {
  const probe = join(p, `.goat-write-test-${randomUUID()}`)
  try {
    if (!(await stat(p)).isDirectory()) return false
    await writeFile(probe, 'x', { flag: 'wx' })
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { force: true }).catch(() => undefined)
  }
}

/**
 * `base` joined with `parts`, as an absolute path. Throws `PATH_FORBIDDEN` when the result is
 * outside `base` (`..`, an absolute part, another drive). Purely lexical: it does not follow symlinks.
 */
export function safeJoin(base: string, ...parts: string[]): string {
  if ([base, ...parts].some((p) => p.includes('\0'))) {
    throw new AppError('PATH_FORBIDDEN', { reason: 'invalid' }, { detail: parts.join('/') })
  }
  const root = resolve(base)
  const joined = resolve(root, ...parts)
  const rel = relative(root, joined)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new AppError('PATH_FORBIDDEN', { reason: 'traversal' }, { detail: joined })
  }
  return joined
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Local time, `YYYYMMDD-HHmmss`. */
function timestamp(d: Date): string {
  const date = `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  return `${date}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** One folder-name component: no separators, no characters Windows forbids, no trailing dot or space. */
function folderLabel(label: string): string {
  return label.replace(/[<>:"/\\|?*\p{Cc}]/gu, '-').replace(/[. ]+$/, '')
}

/**
 * Copies `src` to `backupsRoot/<YYYYMMDD-HHmmss>-<label>/<basename>` and returns the path of the copy.
 * A second backup in the same second with the same label goes to `…-<label>-2`, never over the first.
 */
export async function backupFile(src: string, backupsRoot: string, label: string): Promise<string> {
  await mkdir(backupsRoot, { recursive: true })
  const name = [timestamp(new Date()), folderLabel(label)].filter(Boolean).join('-')
  for (let n = 1; ; n++) {
    const dir = join(backupsRoot, n === 1 ? name : `${name}-${n}`)
    try {
      await mkdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    const copy = join(dir, basename(src))
    try {
      await copyFile(src, copy)
    } catch (error) {
      await rmdir(dir).catch(() => undefined)
      throw error
    }
    return copy
  }
}

/**
 * Moves `src` into `backupsRoot/<YYYYMMDD-HHmmss>-<label>/<sub…>/` (spec §5: nothing is deleted for
 * good) and returns its new path. A name taken there gets `-2`, `-3`… (moveFile).
 */
export async function moveFileToBackups(
  src: string,
  backupsRoot: string,
  label: string,
  ...sub: string[]
): Promise<string> {
  const stamp = [timestamp(new Date()), folderLabel(label)].filter(Boolean).join('-')
  return moveFile(src, join(backupsRoot, stamp, ...sub.map(folderLabel)))
}

/** `ap.tar.gz` → `ap` + `.tar.gz`, `w.apworld` → `w` + `.apworld`, `README` → `README` + ``. */
function splitName(file: string): { stem: string; ext: string } {
  const match = /^(.+?)((?:\.tar)?\.[^.]+)$/i.exec(file)
  return match ? { stem: match[1] ?? file, ext: match[2] ?? '' } : { stem: file, ext: '' }
}

/** Renames, or copies then deletes when `src` and `dest` are on different volumes. */
async function moveOver(src: string, dest: string): Promise<void> {
  try {
    await renameWithRetry(src, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(src, dest)
    try {
      await rm(src)
    } catch (rmError) {
      await rm(dest, { force: true }).catch(() => undefined)
      throw rmError
    }
  }
}

/**
 * Moves the file `src` into `destDir` (created when missing) and returns its new path. A name that is
 * already taken becomes `<name>-2<ext>`, `<name>-3<ext>`…: nothing is ever overwritten, even by two
 * moves running at once.
 */
export async function moveFile(src: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true })
  const file = basename(src)
  const { stem, ext } = splitName(file)
  for (let n = 1; ; n++) {
    const dest = join(destDir, n === 1 ? file : `${stem}-${n}${ext}`)
    // 'wx' creates the name or fails: it reserves it, so that no other move picks it meanwhile.
    try {
      await (await open(dest, 'wx')).close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      await moveOver(src, dest)
      return dest
    } catch (error) {
      await rm(dest, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
