// Archives that come from the outside (APWorlds, patches, seeds, releases): read and extracted with
// limits and path checks, so that a hostile archive can neither fill the disk nor write outside the
// folder it is extracted to.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { extract, list, type ReadEntry } from 'tar'
import * as yauzl from 'yauzl'
import { AppError } from '@shared/errors'
import { pathExists, safeJoin, writeStreamAtomic } from './fsx'

// --- zip ----------------------------------------------------------------------------------------

export interface ZipLimits {
  /** Entries in the archive, folders included. */
  maxEntries: number
  /** Sum of the uncompressed sizes, in bytes. */
  maxUncompressed: number
  /** Uncompressed size divided by compressed size, for the archive and for each big entry. */
  maxRatio: number
}

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = {
  maxEntries: 20000,
  maxUncompressed: 512 * 1024 * 1024,
  maxRatio: 200,
}

export interface ZipEntryInfo {
  /** Path inside the zip, with `/` separators; folders end with `/`. */
  name: string
  /** Uncompressed size, in bytes. */
  size: number
  compressedSize: number
  isDir: boolean
}

/** A small entry can be very compressible without being dangerous (padding): below this size only the ratio of the whole archive counts. */
const RATIO_FLOOR = 1024 * 1024
const DEFAULT_READ_BYTES = 1024 * 1024

const S_IFMT = 0o170000
const S_IFLNK = 0o120000

/** `WORLD_INVALID` is the generic "this archive is not acceptable"; `reason` says why. */
const invalidZip = (
  reason: 'zip-bomb' | 'traversal' | 'not-zip',
  detail?: string,
  cause?: unknown,
): AppError =>
  new AppError('WORLD_INVALID', { reason }, { ...(detail === undefined ? {} : { detail }), cause })

/** EACCES, ENOENT, ENOSPC… as opposed to the errors of a malformed archive. */
const isSystemError = (error: unknown): boolean =>
  typeof (error as NodeJS.ErrnoException | undefined)?.code === 'string' &&
  /^E[A-Z0-9]+$/.test((error as NodeJS.ErrnoException).code ?? '')

/** What yauzl says about a name it refuses (it validates every name it decodes). */
const NAME_ERROR = /^(absolute path|invalid relative path|invalid characters in fileName)\b/

function toZipError(error: unknown): unknown {
  if (error instanceof AppError || isSystemError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  if (NAME_ERROR.test(message)) return invalidZip('traversal', message, error)
  // The data of an entry is longer than its header says: a lying header.
  if (message.startsWith('too many bytes')) return invalidZip('zip-bomb', message, error)
  return invalidZip('not-zip', message, error)
}

/** Opens the zip, runs `fn`, always closes the file, and reports failures as `AppError`s. */
async function withZip<T>(path: string, fn: (zip: yauzl.ZipFile) => Promise<T>): Promise<T> {
  let zip: yauzl.ZipFile
  try {
    zip = await yauzl.openPromise(path, { autoClose: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new AppError('NOT_FOUND', undefined, { detail: path, cause: error })
    }
    throw toZipError(error)
  }
  try {
    return await fn(zip)
  } catch (error) {
    throw toZipError(error)
  } finally {
    zip.close()
  }
}

const isDirectory = (entry: yauzl.Entry): boolean => entry.fileName.endsWith('/')

/** A zip made on Unix can hold symlinks: the attributes carry the file type (made by Unix = 3). */
const isSymlink = (entry: yauzl.Entry): boolean =>
  entry.versionMadeBy >> 8 === 3 && ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK

const describeEntry = (entry: yauzl.Entry): ZipEntryInfo => ({
  name: entry.fileName,
  size: entry.uncompressedSize,
  compressedSize: entry.compressedSize,
  isDir: isDirectory(entry),
})

/** Second look at a name, after yauzl's own. */
function assertSafeName(name: string): void {
  if (
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) ||
    name.split('/').includes('..')
  ) {
    throw invalidZip('traversal', name)
  }
}

/** Reads every entry header, refusing unsafe names and archives over the limits. */
async function scanZip(zip: yauzl.ZipFile, limits: ZipLimits): Promise<yauzl.Entry[]> {
  if (zip.entryCount > limits.maxEntries) {
    throw invalidZip('zip-bomb', `${zip.entryCount} entries, at most ${limits.maxEntries}`)
  }
  const entries: yauzl.Entry[] = []
  let size = 0
  let compressed = 0
  for await (const entry of zip.eachEntry()) {
    assertSafeName(entry.fileName)
    size += entry.uncompressedSize
    compressed += entry.compressedSize
    if (size > limits.maxUncompressed) {
      throw invalidZip('zip-bomb', `more than ${limits.maxUncompressed} bytes once extracted`)
    }
    const { uncompressedSize, compressedSize } = entry
    // Data that "compresses" to nothing is a lie; a huge entry that shrinks too much is a bomb.
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        (uncompressedSize >= RATIO_FLOOR && uncompressedSize / compressedSize > limits.maxRatio))
    ) {
      throw invalidZip('zip-bomb', `${entry.fileName}: ${uncompressedSize} bytes from ${compressedSize}`)
    }
    entries.push(entry)
  }
  if (size > 0 && (compressed === 0 || size / compressed > limits.maxRatio)) {
    throw invalidZip('zip-bomb', `${size} bytes from ${compressed}`)
  }
  return entries
}

/**
 * The entries of a zip. Throws `WORLD_INVALID` with `reason` `not-zip` (not readable as a zip),
 * `traversal` (a name that is absolute or climbs out) or `zip-bomb` (over `limits`), and `NOT_FOUND`
 * when the file does not exist.
 */
export async function listZip(path: string, limits: Partial<ZipLimits> = {}): Promise<ZipEntryInfo[]> {
  return withZip(path, async (zip) =>
    (await scanZip(zip, { ...DEFAULT_ZIP_LIMITS, ...limits })).map(describeEntry),
  )
}

/**
 * The bytes of one entry, or null when the zip has no such file. An entry bigger than `maxBytes`
 * is refused (`WORLD_INVALID`, `zip-bomb`) instead of being read into memory.
 */
export async function readZipBytes(
  path: string,
  entryName: string,
  maxBytes: number = DEFAULT_READ_BYTES,
): Promise<Buffer | null> {
  return withZip(path, async (zip) => {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== entryName) continue
      if (isDirectory(entry)) return null
      if (entry.uncompressedSize > maxBytes) {
        throw invalidZip('zip-bomb', `${entryName}: ${entry.uncompressedSize} bytes, at most ${maxBytes}`)
      }
      // yauzl checks that the data is as long as the header says, so this stays under maxBytes.
      const chunks: Buffer[] = []
      for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks)
    }
    return null
  })
}

/** Like `readZipBytes`, decoded as UTF-8 (a BOM is dropped). Use `readZipBytes` to pick the encoding. */
export async function readZipText(
  path: string,
  entryName: string,
  maxBytes: number = DEFAULT_READ_BYTES,
): Promise<string | null> {
  const bytes = await readZipBytes(path, entryName, maxBytes)
  return bytes === null ? null : new TextDecoder('utf-8').decode(bytes)
}

// Characters and names that Windows cannot create, or turns into something else (`a:b` is a stream
// of `a`; `con.txt` is a device; `..` followed by a dot or a space is still `..`).
const WINDOWS_BAD_CHARS = /[<>:"|?*\p{Cc}]/u
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|\s|$)/i

function assertWindowsName(name: string): void {
  for (const part of name.split('/')) {
    const dots = part !== '.' && /^[. ]+$/.test(part)
    if (WINDOWS_BAD_CHARS.test(part) || WINDOWS_DEVICE.test(part) || dots) throw invalidZip('traversal', name)
  }
}

export interface ExtractZipOptions {
  limits?: Partial<ZipLimits>
  /** Called with each entry name, folders included (`dir/`); false skips the entry. */
  filter?: (entryName: string) => boolean
}

/**
 * Extracts the zip into `destDir` (created when missing) and returns the absolute paths of the files
 * written. The whole archive is checked first (names, limits): nothing is written if it is refused,
 * even when `filter` would have skipped the entry at fault. Symlinks held by the zip are not created.
 */
export async function extractZipSafe(
  path: string,
  destDir: string,
  opts: ExtractZipOptions = {},
): Promise<string[]> {
  return withZip(path, async (zip) => {
    const entries = await scanZip(zip, { ...DEFAULT_ZIP_LIMITS, ...opts.limits })
    const plan = entries
      .filter((entry) => opts.filter?.(entry.fileName) ?? true)
      .map((entry) => {
        if (process.platform === 'win32') assertWindowsName(entry.fileName)
        return { entry, target: safeJoin(destDir, entry.fileName) }
      })

    const extracted: string[] = []
    await mkdir(destDir, { recursive: true })
    for (const { entry, target } of plan) {
      if (isDirectory(entry)) {
        await mkdir(target, { recursive: true })
      } else if (!isSymlink(entry)) {
        await mkdir(dirname(target), { recursive: true })
        await writeStreamAtomic(target, await zip.openReadStreamPromise(entry))
        extracted.push(target)
      }
    }
    return extracted
  })
}

// --- tar.gz -------------------------------------------------------------------------------------

const refused = (reason: 'absolute' | 'traversal' | 'symlink', entryPath: string): AppError =>
  new AppError('PATH_FORBIDDEN', { reason }, { detail: entryPath })

/** `/x`, `\x`, `C:\x` and `C:x`. */
const isAbsoluteTarPath = (p: string): boolean => /^([a-zA-Z]:|[\\/])/.test(p)

/** The segments of a tar path, whatever the separator it was written with. */
const tarSegments = (p: string): string[] => p.replaceAll('\\', '/').split('/')

/** The path without its empty and `.` segments. */
const cleanSegments = (segments: string[]): string[] => segments.filter((p) => p !== '' && p !== '.')

/** True when a prefix of `segments` (the whole path included when `whole`) is one of `symlinks`. */
function underSymlink(segments: string[], symlinks: Set<string>, whole: boolean): boolean {
  const last = whole ? segments.length : segments.length - 1
  for (let i = 1; i <= last; i++) if (symlinks.has(segments.slice(0, i).join('/'))) return true
  return false
}

/**
 * Looks at one entry before anything is extracted and returns why it is refused, or null.
 * `symlinks` holds the paths of the symlinks the archive has created so far (relative to the
 * destination, after stripping).
 */
function checkTarEntry(entry: ReadEntry, strip: number, symlinks: Set<string>): AppError | null {
  const entryPath = entry.path
  if (isAbsoluteTarPath(entryPath)) return refused('absolute', entryPath)
  if (tarSegments(entryPath).includes('..')) return refused('traversal', entryPath)

  // Same counting as node-tar's `strip`; an entry that is stripped away entirely is skipped.
  const key = cleanSegments(tarSegments(entryPath).slice(strip))
  if (key.length === 0) return null
  // Nothing may be written below a symlink that the archive made: it could lead anywhere.
  if (underSymlink(key, symlinks, false)) return refused('symlink', entryPath)

  const linkpath = entry.linkpath ?? ''
  const link = `${entryPath} -> ${linkpath}`
  if (entry.type === 'SymbolicLink') {
    if (linkpath === '' || isAbsoluteTarPath(linkpath)) return refused('symlink', link)
    // Relative to the folder that holds the link, which must stay inside the destination.
    const target = posix.normalize(posix.join(posix.dirname(key.join('/')), tarSegments(linkpath).join('/')))
    if (target === '..' || target.startsWith('../')) return refused('symlink', link)
    symlinks.add(key.join('/'))
  } else if (entry.type === 'Link') {
    // A hard link names another entry of the archive (path from the archive root, stripped too).
    if (isAbsoluteTarPath(linkpath) || tarSegments(linkpath).includes('..')) return refused('symlink', link)
    if (underSymlink(cleanSegments(tarSegments(linkpath).slice(strip)), symlinks, true)) {
      return refused('symlink', link)
    }
  }
  return null
}

function toTarError(error: unknown): unknown {
  if (error instanceof AppError || isSystemError(error)) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new AppError('INVALID_INPUT', { reason: 'not-tar' }, { detail, cause: error })
}

/**
 * Extracts a `.tar.gz` into `destDir` (created when missing), dropping `stripComponents` leading path
 * components. Throws `PATH_FORBIDDEN` (`reason` `absolute`, `traversal` or `symlink`) for an absolute
 * path, a `..`, a symlink that points to an absolute path or outside `destDir`, a hard link out of it,
 * or an entry that would be written through a symlink of the archive; nothing is extracted then.
 * File modes are kept, so executables stay executable. Archives that are not tar.gz, or are
 * truncated, throw `INVALID_INPUT`. No size limit: use it for archives whose hash was verified.
 */
export async function extractTarGzSafe(
  path: string,
  destDir: string,
  opts: { stripComponents?: number } = {},
): Promise<void> {
  const strip = opts.stripComponents ?? 0
  if (!(await pathExists(path))) throw new AppError('NOT_FOUND', undefined, { detail: path })
  try {
    // First pass: look at every entry (and parse the whole archive) before writing anything.
    const symlinks = new Set<string>()
    const refusal: { error: AppError | null } = { error: null }
    await list({
      file: path,
      strict: true,
      onReadEntry: (entry) => {
        refusal.error ??= checkTarEntry(entry, strip, symlinks)
      },
    })
    if (refusal.error) throw refusal.error

    await mkdir(destDir, { recursive: true })
    // node-tar's own protections (no absolute path, no `..`, nothing through a symlink) stay on.
    await extract({ file: path, cwd: destDir, strip, strict: true, chmod: true, processUmask: 0o022 })
  } catch (error) {
    throw toTarError(error)
  }
}

// --- hash ---------------------------------------------------------------------------------------

/** SHA-256 of a file, as lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
