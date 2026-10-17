// The ROM vault (spec §3.12): the ROMs the user owns, found on disk and recognised by their MD5 the way
// Archipelago checks them. The vault keeps references (path, size, mtime, MD5, game) in
// userData/vault.json, never a copy of a file, and it never uploads or shares anything.
//
// The MD5 follows what Archipelago 0.6.8 does before it compares a file with a world's `md5s`:
// `settings.SNESRomPath` skips 512 bytes when the size leaves 512 modulo 1024 (settings.py:491-512);
// Mega Man 2 and 3 skip the 16 bytes of an iNES header (worlds/mm2/__init__.py:44-62).
import { createHash } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { ROM_TABLE } from '@shared/data/rom-table'
import type { ErrorCode } from '@shared/codes'
import type { RomNeed, RomRecord, RomTableEntry, VaultApplyResult } from '@shared/types'
import { SETTINGS_KEYS, type ApSettings, type SettingsEntry } from '../ap/settings'
import type { Locator } from '../ap/locator'
import type { CoreContext } from '../context'
import { readJsonSync } from '../json-file'
import { writeFileAtomic } from '../system/fsx'
import { assertUserPath } from '../system/user-path'
import type { TaskHandle } from '../tasks'

/** A file bigger than this is no ROM Archipelago asks for (the biggest is the 64 MB Ocarina of Time). */
export const MAX_ROM_BYTES = 128 * 1024 * 1024

/** Folder levels a scan goes down: the folder it is given is level 0, so its files are found at 0 to 4. */
export const SCAN_MAX_DEPTH = 4

/** The plausible extensions of spec §3.12. */
const SPEC_EXTENSIONS = [
  '.sfc',
  '.smc',
  '.gb',
  '.gbc',
  '.gba',
  '.nes',
  '.z64',
  '.n64',
  '.v64',
  '.bin',
  '.sms',
  '.gen',
  '.md',
  '.iso',
  '.srl',
]

/** What `table` accepts (`.a26` and `.exe` come from it): the spec list plus every entry's extensions. */
function scanExtensions(table: readonly RomTableEntry[]): ReadonlySet<string> {
  return new Set([...SPEC_EXTENSIONS, ...table.flatMap((entry) => entry.extensions)])
}

/** The extensions a scan looks at, for the table of the app. */
export const SCAN_EXTENSIONS: ReadonlySet<string> = scanExtensions(ROM_TABLE)

type RomHeader = RomTableEntry['header']

/** `NES\x1A`, the start of an iNES file. */
const INES_MAGIC = Buffer.from([0x4e, 0x45, 0x53, 0x1a])
const INES_HEADER_BYTES = 16
const SNES_HEADER_BYTES = 512

async function startsWithInes(file: string): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(INES_MAGIC.length)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return bytesRead === head.length && head.equals(INES_MAGIC)
  } finally {
    await handle.close()
  }
}

/** How many bytes Archipelago skips at the start of the file before it hashes the rest. */
async function headerLength(file: string, size: number, header: RomHeader): Promise<number> {
  switch (header) {
    case 'snes':
      return size % 1024 === SNES_HEADER_BYTES ? SNES_HEADER_BYTES : 0
    case 'ines':
      return (await startsWithInes(file)) ? INES_HEADER_BYTES : 0
    case 'none':
      return 0
  }
}

/** Streaming MD5 of the file from byte `start`. */
async function md5From(file: string, start: number): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(file, { start, highWaterMark: 1 << 20 })) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * The MD5 of a ROM the way Archipelago computes it. `snes` skips a 512-byte copier header when
 * `size % 1024 === 512`; `ines` skips 16 bytes when the file starts with `NES\x1A`; `none` hashes the
 * whole file. Rejects with the system error (`ENOENT`…) when the file cannot be read.
 */
export async function md5Rom(file: string, header: RomHeader): Promise<string> {
  const { size } = await stat(file)
  return md5From(file, await headerLength(file, size, header))
}

export interface RomIdentity {
  md5: string
  /** The entry that accepts the file; null when none does. */
  entry: RomTableEntry | null
}

async function identify(file: string, size: number, table: readonly RomTableEntry[]): Promise<RomIdentity> {
  const extension = path.extname(file).toLowerCase()
  const candidates = table.filter((entry) => entry.extensions.includes(extension))
  // Two rules can skip the same bytes (an iNES rule on a headerless file): hash once per offset.
  const hashes = new Map<number, string>()
  let first: string | null = null
  for (const header of new Set(candidates.map((entry) => entry.header))) {
    const offset = await headerLength(file, size, header)
    let md5 = hashes.get(offset)
    if (md5 === undefined) {
      md5 = await md5From(file, offset)
      hashes.set(offset, md5)
    }
    first ??= md5
    const entry = candidates.find((candidate) => candidate.header === header && candidate.md5s.includes(md5))
    if (entry) return { md5, entry }
  }
  // Unknown: the hash of the first rule an entry with this extension applies (the whole file when no
  // entry has it), which is the one Archipelago would have computed for such a file.
  return { md5: first ?? (await md5From(file, 0)), entry: null }
}

/**
 * Which table entry accepts the file, found with the header rules of the entries that list its
 * extension (case-insensitive); the first entry when several accept the same hash (the Proteus program
 * of Mega Man 2 and 3). `md5` is the hash under the first rule tried, so an unknown file still gets the
 * hash Archipelago would compute for it.
 */
export async function identifyRom(
  file: string,
  table: readonly RomTableEntry[] = ROM_TABLE,
): Promise<RomIdentity> {
  const { size } = await stat(file)
  return identify(file, size, table)
}

/** What `resolveRomForEntry` answers: the fields of a `RomNeed` that do not depend on the session. */
export type RomResolution = Pick<RomNeed, 'status' | 'path' | 'vaultPath'>

export interface VaultDeps {
  settings: Pick<ApSettings, 'get' | 'set'>
  locator: Pick<Locator, 'detect'>
  /** The ROMs to recognise. Default: `ROM_TABLE`. */
  table?: readonly RomTableEntry[]
}

export interface Vault {
  /** Every ROM of the index, recognised or not, as it was when it was last read. */
  list(): Promise<RomRecord[]>
  /**
   * Adds the ROMs found in the files and folders to the index and returns them, whether they were read
   * now or already known. Every path goes through `assertUserPath` first. A folder is walked four
   * levels down (links are not followed); a file, given or found, is taken when its extension is one
   * of `SCAN_EXTENSIONS` and it is at most `MAX_ROM_BYTES`. A file whose size and mtime are those of
   * its record is not read again. What was read stays in the index when the task is cancelled.
   */
  scan(paths: readonly string[], task: TaskHandle): Promise<RomRecord[]>
  /** Forgets a ROM. The file is never touched. */
  remove(path: string): Promise<void>
  /**
   * Writes `<key>.rom_file` for every table entry the vault has a verified ROM for, in one
   * `settings.set` (`SETTINGS_LOCKED` and the other errors of the settings file pass through). A ROM
   * whose file is gone or no longer matches is reported as skipped.
   */
  apply(): Promise<VaultApplyResult>
  /**
   * The first record whose MD5 is one of `md5s`, straight from the index: the file is not looked at
   * (that takes a read of the disk). To use a ROM, go through `resolveRomForEntry`.
   */
  findForMd5(md5s: readonly string[]): RomRecord | null
  /**
   * The one place that decides where the ROM of a table entry is: the effective `rom_file` key of the
   * settings (resolved against the user folder of Archipelago) when the file there hashes, with the
   * header rule of the entry, to one of `md5s`; otherwise a verified ROM of the vault.
   *
   * - key valid: `{ status: 'ok', path: <the key's file>, vaultPath: null }`
   * - else a vault ROM: `{ status: 'ok', path: <its path>, vaultPath: <the same path> }`, so
   *   `vaultPath !== null` says that the ROM comes from the vault and not from the settings
   * - else `{ status: 'bad-hash' | 'missing', path: null, vaultPath: null }`, `bad-hash` when the key
   *   points to a file that is no accepted ROM, `missing` when it points to nothing or is not set
   *
   * `md5s` defaults to the hashes of the entry; a patch passes its `base_checksum`.
   */
  resolveRomForEntry(entry: RomTableEntry, md5s?: readonly string[]): Promise<RomResolution>
}

const INDEX_FILE = 'vault.json'
const INDEX_VERSION = 1

const StoredRecord = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  md5: z.string().regex(/^[0-9a-f]{32}$/),
  game: z.string().nullable(),
  label: z.string().nullable(),
  settingsKey: z.string().nullable(),
})
const StoredIndex = z.object({ version: z.literal(INDEX_VERSION), records: z.array(z.unknown()) })

/** One of the two reasons `apply` gives for a ROM it cannot use. */
type SkipReason = Extract<ErrorCode, 'ROM_MISSING' | 'ROM_BAD_HASH'>

type VaultMatch = { record: RomRecord } | { reason: SkipReason }

interface Candidate {
  path: string
  size: number
  mtimeMs: number
}

const lowerCased = (md5s: readonly string[]): ReadonlySet<string> =>
  new Set(md5s.map((md5) => md5.toLowerCase()))

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export function createVault(ctx: CoreContext, deps: VaultDeps): Vault {
  const { log } = ctx
  const { settings, locator } = deps
  const table = deps.table ?? ROM_TABLE
  const extensions = deps.table ? scanExtensions(table) : SCAN_EXTENSIONS
  const lib = ctx.platform.os === 'win32' ? path.win32 : path.posix
  const indexFile = path.join(ctx.platform.paths.userData, INDEX_FILE)
  // Windows paths differ by case only when they are not the same file.
  const keyOf = (file: string): string => (ctx.platform.os === 'win32' ? file.toLowerCase() : file)

  // The index is small and read once, as the config is: `findForMd5` has to answer without waiting.
  let records = new Map<string, RomRecord>()
  const stored = StoredIndex.safeParse(readJsonSync(indexFile))
  if (stored.success) {
    for (const raw of stored.data.records) {
      const record = StoredRecord.safeParse(raw)
      if (record.success) records.set(keyOf(record.data.path), record.data)
    }
  }

  // One change at a time, each on top of the one before: two scans that end together lose nothing.
  let writes: Promise<unknown> = Promise.resolve()
  function update(change: (next: Map<string, RomRecord>) => void): Promise<void> {
    const run = writes.then(async () => {
      const next = new Map(records)
      change(next)
      const index = { version: INDEX_VERSION, records: [...next.values()] }
      await writeFileAtomic(indexFile, `${JSON.stringify(index, null, 2)}\n`)
      records = next
    })
    writes = run.catch(() => undefined)
    return run
  }

  async function inspect(file: string, info: { size: number; mtimeMs: number }): Promise<RomRecord> {
    const { md5, entry } = await identify(file, info.size, table)
    return {
      path: file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      md5,
      game: entry?.game ?? null,
      label: entry?.label ?? null,
      settingsKey: entry?.settingsKey ?? null,
    }
  }

  /** The files a scan will look at: what `assertUserPath` accepted, and what is below it. */
  async function collect(roots: readonly string[], task: TaskHandle): Promise<Candidate[]> {
    const seen = new Set<string>()
    const found: Candidate[] = []

    async function consider(file: string): Promise<void> {
      if (!extensions.has(path.extname(file).toLowerCase()) || seen.has(keyOf(file))) return
      seen.add(keyOf(file))
      const info = await stat(file).catch(() => null)
      if (info?.isFile() && info.size <= MAX_ROM_BYTES) {
        found.push({ path: file, size: info.size, mtimeMs: info.mtimeMs })
      }
    }

    async function walk(dir: string, depth: number): Promise<void> {
      task.signal.throwIfAborted()
      let children: Dirent[]
      try {
        children = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        log.warn('vault: cannot read a folder', { dir, error: String(error) })
        return
      }
      // Links are left alone: a scan stays inside the folder it was given.
      for (const child of children.sort(byName)) {
        const full = lib.join(dir, child.name)
        if (child.isDirectory()) {
          if (depth < SCAN_MAX_DEPTH) await walk(full, depth + 1)
        } else if (child.isFile()) {
          await consider(full)
        }
      }
    }

    for (const root of roots) {
      const info = await stat(root).catch(() => null)
      if (info?.isDirectory()) await walk(root, 0)
      else if (info?.isFile()) await consider(root)
    }
    return found
  }

  /**
   * The record as the file is now. A file whose size or mtime is not the record's is read again and
   * the index follows; null when the file is gone, is no file, or cannot be read.
   */
  async function refresh(record: RomRecord): Promise<RomRecord | null> {
    const info = await stat(record.path).catch(() => null)
    if (!info?.isFile()) return null
    if (info.size === record.size && info.mtimeMs === record.mtimeMs) return record
    if (info.size > MAX_ROM_BYTES) return null
    let fresh: RomRecord
    try {
      fresh = await inspect(record.path, info)
    } catch (error) {
      log.warn('vault: cannot read a ROM again', { file: record.path, error: String(error) })
      return null
    }
    // The file is what it is whether or not the index could be saved: a full disk must not turn a good
    // ROM into a missing one.
    await update((next) => void next.set(keyOf(fresh.path), fresh)).catch((error: unknown) =>
      log.warn('vault: cannot save the index', { error: String(error) }),
    )
    return fresh
  }

  /** The first record that is still one of `accepted` once its file has been looked at again. */
  async function verifiedMatch(accepted: ReadonlySet<string>): Promise<VaultMatch | null> {
    let reason: SkipReason | null = null
    for (const candidate of [...records.values()].filter((record) => accepted.has(record.md5))) {
      const current = await refresh(candidate)
      if (current === null) reason ??= 'ROM_MISSING'
      else if (accepted.has(current.md5)) return { record: current }
      else reason = 'ROM_BAD_HASH'
    }
    return reason && { reason }
  }

  /** The file the effective key of the entry names, when it is an accepted ROM. */
  async function checkEffectiveKey(
    entry: RomTableEntry,
    accepted: ReadonlySet<string>,
  ): Promise<{ status: 'ok'; path: string } | { status: 'missing' | 'bad-hash' }> {
    const install = await locator.detect()
    if (!install) return { status: 'missing' }
    const value = await settings.get(SETTINGS_KEYS.romFile(entry.settingsKey))
    if (typeof value !== 'string' || value.trim() === '') return { status: 'missing' }
    // Archipelago resolves a relative path against its user folder (`_UserPath.resolve`).
    const file = lib.resolve(install.paths.userPath, value)
    // Only a regular file is opened: a device name (CON) or a pipe would block the read.
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return { status: 'missing' }
    if (info.size > MAX_ROM_BYTES) return { status: 'bad-hash' }
    try {
      return accepted.has(await md5Rom(file, entry.header))
        ? { status: 'ok', path: file }
        : { status: 'bad-hash' }
    } catch (error) {
      log.warn('vault: cannot read the ROM of a settings key', {
        key: entry.settingsKey,
        error: String(error),
      })
      return { status: 'missing' }
    }
  }

  return {
    list: () => Promise.resolve([...records.values()].map((record) => ({ ...record }))),

    async scan(paths, task) {
      const roots: string[] = []
      for (const p of paths) roots.push(await assertUserPath(p))

      task.progress('list', null)
      const candidates = await collect(roots, task)
      const found: RomRecord[] = []
      const read: RomRecord[] = []
      let completed = false
      try {
        for (const [i, candidate] of candidates.entries()) {
          task.signal.throwIfAborted()
          task.progress('hash', Math.round((i * 100) / candidates.length), {
            done: i,
            total: candidates.length,
          })
          const known = records.get(keyOf(candidate.path))
          if (known && known.size === candidate.size && known.mtimeMs === candidate.mtimeMs) {
            found.push(known)
            continue
          }
          try {
            const record = await inspect(candidate.path, candidate)
            found.push(record)
            read.push(record)
          } catch (error) {
            // A file that is locked or unreadable is left out; the others are still worth reading.
            task.signal.throwIfAborted()
            log.warn('vault: cannot read a file', { file: candidate.path, error: String(error) })
          }
        }
        completed = true
      } finally {
        // A scan that is cancelled or fails keeps what it read. A save that fails does not hide why the
        // scan stopped; when the scan itself went well, it is the error.
        if (read.length > 0) {
          const save = update((next) => {
            for (const record of read) next.set(keyOf(record.path), record)
          })
          await (completed
            ? save
            : save.catch((error: unknown) =>
                log.warn('vault: cannot save the index', { error: String(error) }),
              ))
        }
      }
      log.info('vault: scan done', { files: candidates.length, kept: found.length })
      return found.map((record) => ({ ...record }))
    },

    async remove(file) {
      const key = keyOf(file)
      if (records.has(key)) await update((next) => void next.delete(key))
    },

    async apply() {
      const entries: SettingsEntry[] = []
      const applied: VaultApplyResult['applied'] = []
      const skipped: VaultApplyResult['skipped'] = []
      for (const entry of table) {
        const match = await verifiedMatch(lowerCased(entry.md5s))
        if (match === null) continue
        if ('reason' in match) {
          skipped.push({ game: entry.game, reason: match.reason })
          continue
        }
        entries.push({ path: SETTINGS_KEYS.romFile(entry.settingsKey), value: match.record.path })
        applied.push({ game: entry.game, key: entry.settingsKey, path: match.record.path })
      }
      if (entries.length > 0) await settings.set(entries)
      return { applied, skipped }
    },

    findForMd5(md5s) {
      const accepted = lowerCased(md5s)
      for (const record of records.values()) if (accepted.has(record.md5)) return { ...record }
      return null
    },

    async resolveRomForEntry(entry, md5s = entry.md5s) {
      const accepted = lowerCased(md5s)
      const effective = await checkEffectiveKey(entry, accepted)
      if (effective.status === 'ok') return { status: 'ok', path: effective.path, vaultPath: null }
      const match = await verifiedMatch(accepted)
      if (match && 'record' in match) {
        return { status: 'ok', path: match.record.path, vaultPath: match.record.path }
      }
      return { status: effective.status, path: null, vaultPath: null }
    },
  }
}
