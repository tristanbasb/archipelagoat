import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'
import { resolveApPaths, type Locator } from '@main/core/ap/locator'
import { createApSettings, type ApSettings, type SettingsPath } from '@main/core/ap/settings'
import type { ExecFn } from '@main/core/exec'
import {
  createVault,
  identifyRom,
  MAX_ROM_BYTES,
  md5Rom,
  SCAN_EXTENSIONS,
  type Vault,
} from '@main/core/play/roms'
import type { TaskHandle } from '@main/core/tasks'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
// The `vault` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/vault.service'
import { apExeFileName } from '@shared/data/ap-constants'
import { ROM_TABLE } from '@shared/data/rom-table'
import { AppError } from '@shared/errors'
import type { ApInstall, RomRecord, RomTableEntry, TaskDone } from '@shared/types'
import { createTestContext, hostOs, type TestCore } from '../../helpers/core'

let dir: string
let core: TestCore
let roms: string
let ap: string
let install: ApInstall | null

const md5 = (data: Buffer): string => createHash('md5').update(data).digest('hex')
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'

/** Deterministic filler, different for each seed. */
const bytes = (length: number, seed: number): Buffer =>
  Buffer.from(Array.from({ length }, (_, i) => (i * 7 + seed * 13 + (i >> 8)) & 0xff))

const COPIER_HEADER = Buffer.alloc(512, 0xaa)
const INES_MAGIC = [0x4e, 0x45, 0x53, 0x1a]
const ines = (prg: Buffer): Buffer =>
  Buffer.concat([Buffer.from([...INES_MAGIC, 2, 1, 0, 0]), Buffer.alloc(8), prg])

const SNES_BODY = bytes(8192, 3)
const SNES_BODY_2 = bytes(8192, 7)
const NES_PLAIN = bytes(4096, 4)
const NES_PRG = bytes(4096, 5)
const SHARED_EXE = bytes(6000, 6)

/** Synthetic ROMs: nobody can build a file with the MD5 of a real game. */
function entry(game: string, key: string, rest: Partial<RomTableEntry>): RomTableEntry {
  return {
    game,
    label: `${game} (test)`,
    md5s: [],
    header: 'none',
    settingsKey: `${key}.rom_file`,
    requiredAtGeneration: false,
    extensions: ['.sfc'],
    ...rest,
  }
}

// Two revisions of one game, with a copier header allowed.
const SNES_GAME = entry('Snes Game', 'snes_options', {
  header: 'snes',
  md5s: [md5(SNES_BODY), md5(SNES_BODY_2)],
})
// Two entries share `.nes`, one with and one without the iNES header rule.
const NES_PLAIN_GAME = entry('Plain Nes', 'plain_nes_options', {
  md5s: [md5(NES_PLAIN)],
  extensions: ['.nes'],
})
const NES_INES_GAME = entry('Ines Nes', 'ines_nes_options', {
  header: 'ines',
  md5s: [md5(NES_PRG)],
  extensions: ['.nes'],
})
// Like Mega Man 2 and 3, which accept the same program.
const EXE_ONE = entry('Exe One', 'exe_one_options', {
  header: 'ines',
  md5s: [md5(SHARED_EXE)],
  extensions: ['.exe'],
})
const EXE_TWO = entry('Exe Two', 'exe_two_options', {
  header: 'ines',
  md5s: [md5(SHARED_EXE)],
  extensions: ['.exe'],
})
const TABLE = [SNES_GAME, NES_PLAIN_GAME, NES_INES_GAME, EXE_ONE, EXE_TWO]

function write(file: string, data: Buffer | string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  return file
}

/** Sets both times of a file to a whole number of seconds, which a stat reads back unchanged. */
const stamp = (file: string, seconds: number): void => utimesSync(file, seconds, seconds)

/** A file of `size` bytes without writing them (the vault never reads one that is too big). */
function sparse(file: string, size: number): string {
  write(file, '')
  truncateSync(file, size)
  return file
}

type TestTask = TaskHandle & { progress: ReturnType<typeof vi.fn<TaskHandle['progress']>>; abort: () => void }

function task(): TestTask {
  const controller = new AbortController()
  return {
    id: 'task-1',
    signal: controller.signal,
    progress: vi.fn<TaskHandle['progress']>(),
    log: vi.fn<TaskHandle['log']>(),
    abort: () => controller.abort(new AppError('TASK_CANCELLED')),
  }
}

function fakeSettings(values: Record<string, unknown> = {}): {
  get: ReturnType<typeof vi.fn<ApSettings['get']>>
  set: ReturnType<typeof vi.fn<ApSettings['set']>>
} {
  return {
    get: vi.fn<ApSettings['get']>((path: SettingsPath) => Promise.resolve(values[path.join('.')])),
    set: vi.fn<ApSettings['set']>(() => Promise.resolve()),
  }
}

function apInstall(base: string): ApInstall {
  const paths = resolveApPaths(
    { localPath: base, os: hostOs, home: core.platform.paths.home, localWritable: true, cwd: base },
    existsSync,
  )
  return { kind: 'custom', version: '0.6.8', root: base, appImagePath: null, paths }
}

/** Answers the install the test holds at the time of each call. */
const locator = (): Locator => ({
  detect: () => Promise.resolve(install),
  fromRoot: () => Promise.reject(new Error('not used')),
  exe: () => {
    throw new Error('not used')
  },
  invalidate: () => undefined,
})

interface MakeVault {
  table?: RomTableEntry[]
  settings?: Pick<ApSettings, 'get' | 'set'>
}

function makeVault({ table = TABLE, settings = fakeSettings() }: MakeVault = {}): Vault {
  return createVault(core.ctx, { settings, locator: locator(), table })
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

const names = (records: RomRecord[]): string[] => records.map((record) => basename(record.path))
const byName = (records: RomRecord[]): Record<string, RomRecord> =>
  Object.fromEntries(records.map((record) => [basename(record.path), record]))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat vault é-'))
  core = createTestContext(dir)
  roms = join(dir, 'Mes ROMs')
  ap = join(dir, 'Archipelago')
  mkdirSync(roms, { recursive: true })
  mkdirSync(ap, { recursive: true })
  install = apInstall(ap)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('md5Rom', () => {
  it('strips 512-byte SNES copier header only when size % 1024 === 512', async () => {
    const body = bytes(4096, 1)
    const headeredBytes = Buffer.concat([COPIER_HEADER, body])
    const oddBytes = Buffer.concat([COPIER_HEADER.subarray(0, 100), body])
    const headered = write(join(roms, 'headered.sfc'), headeredBytes)
    const plain = write(join(roms, 'plain.sfc'), body)
    const odd = write(join(roms, 'odd.sfc'), oddBytes)

    expect(await md5Rom(headered, 'snes')).toBe(md5(body))
    expect(await md5Rom(plain, 'snes')).toBe(md5(body))
    // 4196 bytes: neither a headered nor a header-less size, so nothing is stripped.
    expect(await md5Rom(odd, 'snes')).toBe(md5(oddBytes))
    // Exactly the header: nothing is left to hash.
    expect(await md5Rom(write(join(roms, 'header-only.sfc'), COPIER_HEADER), 'snes')).toBe(EMPTY_MD5)
    // The other rules never strip a copier header.
    expect(await md5Rom(headered, 'none')).toBe(md5(headeredBytes))
    expect(await md5Rom(headered, 'ines')).toBe(md5(headeredBytes))
  })

  it('strips iNES header for MM2', async () => {
    const withHeader = write(join(roms, 'mm2.nes'), ines(NES_PRG))
    const headerless = write(join(roms, 'mm2-headerless.nes'), NES_PRG)
    expect(await md5Rom(withHeader, 'ines')).toBe(md5(NES_PRG))
    expect(await md5Rom(headerless, 'ines')).toBe(md5(NES_PRG))
    // `none` hashes the whole file, header included.
    expect(await md5Rom(withHeader, 'none')).toBe(md5(ines(NES_PRG)))

    // Only the four bytes `NES\x1A` make a header.
    const lookalike = Buffer.concat([Buffer.from('NESx'), bytes(100, 8)])
    expect(await md5Rom(write(join(roms, 'lookalike.nes'), lookalike), 'ines')).toBe(md5(lookalike))
    // Shorter than the magic number: hashed as it is.
    const tiny = write(join(roms, 'tiny.nes'), Buffer.from('NES'))
    expect(await md5Rom(tiny, 'ines')).toBe(md5(Buffer.from('NES')))
    expect(await md5Rom(write(join(roms, 'empty.nes'), Buffer.alloc(0)), 'ines')).toBe(EMPTY_MD5)
    // The magic number alone: a header with nothing after it.
    const magic = write(join(roms, 'magic.nes'), Buffer.from(INES_MAGIC))
    expect(await md5Rom(magic, 'ines')).toBe(EMPTY_MD5)
  })

  it('rejects with the system error when the file does not exist', async () => {
    await expect(md5Rom(join(roms, 'nope.sfc'), 'none')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('identifyRom', () => {
  it('applies the header rule of the entries whose extension matches', async () => {
    const snes = write(join(roms, 'headered.sfc'), Buffer.concat([COPIER_HEADER, SNES_BODY]))
    expect(await identifyRom(snes, TABLE)).toEqual({ md5: md5(SNES_BODY), entry: SNES_GAME })

    // A second revision of the same game is the same entry, and the extension has any case.
    const rev2 = write(join(roms, 'rev2.SFC'), SNES_BODY_2)
    expect(await identifyRom(rev2, TABLE)).toEqual({ md5: md5(SNES_BODY_2), entry: SNES_GAME })

    // Two entries share `.nes`: each rule is tried.
    const plain = write(join(roms, 'plain.nes'), NES_PLAIN)
    expect(await identifyRom(plain, TABLE)).toEqual({ md5: md5(NES_PLAIN), entry: NES_PLAIN_GAME })
    const withHeader = write(join(roms, 'ines.nes'), ines(NES_PRG))
    expect(await identifyRom(withHeader, TABLE)).toEqual({ md5: md5(NES_PRG), entry: NES_INES_GAME })
    const headerless = write(join(roms, 'headerless.nes'), NES_PRG)
    expect(await identifyRom(headerless, TABLE)).toEqual({ md5: md5(NES_PRG), entry: NES_INES_GAME })
  })

  it('gives the first entry when several accept the same hash', async () => {
    const exe = write(join(roms, 'Proteus.exe'), SHARED_EXE)
    expect(await identifyRom(exe, TABLE)).toEqual({ md5: md5(SHARED_EXE), entry: EXE_ONE })
  })

  it('answers no entry, with the hash of the first rule, for an unknown file', async () => {
    const unknownSnes = Buffer.concat([COPIER_HEADER, bytes(2048, 9)])
    const snes = write(join(roms, 'unknown.sfc'), unknownSnes)
    expect(await identifyRom(snes, TABLE)).toEqual({ md5: md5(unknownSnes.subarray(512)), entry: null })

    // `.nes` tries `none` first (the order of the table): the whole file.
    const unknownNes = ines(bytes(2048, 10))
    expect(await identifyRom(write(join(roms, 'unknown.nes'), unknownNes), TABLE)).toEqual({
      md5: md5(unknownNes),
      entry: null,
    })
  })

  it('does not match an extension no entry lists, even with the right content', async () => {
    const wrongExtension = write(join(roms, 'game.gb'), SNES_BODY)
    expect(await identifyRom(wrongExtension, TABLE)).toEqual({ md5: md5(SNES_BODY), entry: null })
  })

  it('uses the table of the app by default', async () => {
    const file = write(join(roms, 'unknown.sfc'), SNES_BODY)
    expect(await identifyRom(file)).toEqual({ md5: md5(SNES_BODY), entry: null })
  })
})

describe('scan extensions', () => {
  it('are the extensions of the spec and of every table entry', () => {
    const spec = '.sfc .smc .gb .gbc .gba .nes .z64 .n64 .v64 .bin .sms .gen .md .iso .srl'.split(' ')
    for (const extension of spec) expect(SCAN_EXTENSIONS.has(extension)).toBe(true)
    // Not in the spec list: they come from the table (Adventure, Mega Man 2 and 3).
    expect(SCAN_EXTENSIONS.has('.a26')).toBe(true)
    expect(SCAN_EXTENSIONS.has('.exe')).toBe(true)
    for (const { extensions } of ROM_TABLE) {
      for (const extension of extensions) expect(SCAN_EXTENSIONS.has(extension)).toBe(true)
    }
    expect(SCAN_EXTENSIONS.has('.txt')).toBe(false)
    expect(SCAN_EXTENSIONS.has('.zip')).toBe(false)
  })
})

describe('scan', () => {
  it('scan identifies matching file and ignores >128MB and unknown extensions', async () => {
    const game = write(join(roms, 'game.sfc'), Buffer.concat([COPIER_HEADER, SNES_BODY]))
    write(join(roms, 'other.bin'), bytes(100, 11))
    write(join(roms, 'notes.txt'), 'not a rom')
    write(join(roms, 'archive.zip'), 'not a rom')
    sparse(join(roms, 'big.sfc'), MAX_ROM_BYTES + 1)

    const vault = makeVault()
    const found = await vault.scan([roms], task())

    // The unknown `.bin` is kept as an unrecognised ROM; the other three files are not scanned.
    expect(names(found)).toEqual(['game.sfc', 'other.bin'])
    const [recognised, unknown] = found
    expect(recognised).toEqual({
      path: game,
      size: SNES_BODY.length + 512,
      mtimeMs: expect.any(Number) as number,
      md5: md5(SNES_BODY),
      game: 'Snes Game',
      label: 'Snes Game (test)',
      settingsKey: 'snes_options.rom_file',
    })
    expect(unknown).toMatchObject({ md5: md5(bytes(100, 11)), game: null, label: null, settingsKey: null })
    expect(await vault.list()).toEqual(found)
  })

  it('scans a file of exactly 128 MiB', async () => {
    sparse(join(roms, 'limit.sfc'), MAX_ROM_BYTES)
    const found = await makeVault().scan([roms], task())
    expect(names(found)).toEqual(['limit.sfc'])
  })

  it('walks four folder levels down and no further', async () => {
    write(join(roms, 'a.sfc'), SNES_BODY)
    write(join(roms, 'l1', 'b.sfc'), SNES_BODY)
    write(join(roms, 'l1', 'l2', 'c.sfc'), SNES_BODY)
    write(join(roms, 'l1', 'l2', 'l3', 'd.sfc'), SNES_BODY)
    write(join(roms, 'l1', 'l2', 'l3', 'l4', 'e.sfc'), SNES_BODY)
    write(join(roms, 'l1', 'l2', 'l3', 'l4', 'l5', 'f.sfc'), SNES_BODY)
    const found = await makeVault().scan([roms], task())
    expect(names(found).sort()).toEqual(['a.sfc', 'b.sfc', 'c.sfc', 'd.sfc', 'e.sfc'])
  })

  it('scans a file once however it is given, and applies the extension rule to files too', async () => {
    const game = write(join(roms, 'game.sfc'), SNES_BODY)
    const notes = write(join(roms, 'notes.txt'), 'hello')
    const vault = makeVault()
    // A file given twice, and again through its folder, is one record.
    const found = await vault.scan([game, notes, roms, game], task())
    expect(names(found)).toEqual(['game.sfc'])
    expect(await vault.scan([notes], task())).toEqual([])
    expect(await vault.scan([], task())).toEqual([])
  })

  it('checks every path with assertUserPath', async () => {
    const vault = makeVault()
    write(join(roms, 'game.sfc'), SNES_BODY)
    expect((await failure(vault.scan([roms, 'relative/folder'], task()))).code).toBe('PATH_FORBIDDEN')
    expect((await failure(vault.scan([join(roms, 'missing')], task()))).code).toBe('NOT_FOUND')
    // Nothing is scanned when one of the paths is refused.
    expect(await vault.list()).toEqual([])
  })

  it('reports its progress', async () => {
    write(join(roms, 'a.sfc'), SNES_BODY)
    write(join(roms, 'b.sfc'), SNES_BODY_2)
    const handle = task()
    await makeVault().scan([roms], handle)
    const calls = handle.progress.mock.calls
    expect(calls[0]).toEqual(['list', null])
    expect(calls).toContainEqual(['hash', 0, { done: 0, total: 2 }])
    expect(calls).toContainEqual(['hash', 50, { done: 1, total: 2 }])
  })

  it('keeps what it found when it is cancelled', async () => {
    for (const name of ['a', 'b', 'c', 'd']) write(join(roms, `${name}.sfc`), bytes(2048, name.charCodeAt(0)))
    const handle = task()
    handle.progress.mockImplementation((stage, _percent, detail) => {
      if (stage === 'hash' && detail?.done === 1) handle.abort()
    })
    const vault = makeVault()
    expect((await failure(vault.scan([roms], handle))).code).toBe('TASK_CANCELLED')
    const kept = await vault.list()
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(4)
    // Still there after a restart.
    expect(await makeVault().list()).toEqual(kept)
  })

  it('a rescan hashes only the files whose size or mtime changed', async () => {
    const stable = write(join(roms, 'stable.sfc'), bytes(2048, 20))
    const edited = write(join(roms, 'edited.sfc'), bytes(2048, 21))
    stamp(stable, 1_700_000_000)
    stamp(edited, 1_700_000_000)
    const vault = makeVault()
    const before = byName(await vault.scan([roms], task()))

    // Same size, same mtime, other bytes: the index is trusted, so this file is not read again.
    writeFileSync(stable, bytes(2048, 22))
    stamp(stable, 1_700_000_000)
    // Same size, new mtime: read again.
    writeFileSync(edited, bytes(2048, 23))
    stamp(edited, 2_000_000_000)

    const after = byName(await vault.scan([roms], task()))
    expect(after['stable.sfc']).toEqual(before['stable.sfc'])
    expect(after['edited.sfc']?.md5).toBe(md5(bytes(2048, 23)))
    expect(after['edited.sfc']?.mtimeMs).toBe(2_000_000_000_000)
  })
})

describe('apply', () => {
  it('apply writes rom_file keys in one settings write', async () => {
    const snes = write(join(roms, 'game.sfc'), Buffer.concat([COPIER_HEADER, SNES_BODY]))
    const plain = write(join(roms, 'plain.nes'), NES_PLAIN)
    const exe = write(join(roms, 'Proteus.exe'), SHARED_EXE)
    write(join(roms, 'unknown.gb'), bytes(300, 30))
    const settings = fakeSettings()
    const vault = makeVault({ settings })
    await vault.scan([roms], task())

    const result = await vault.apply()

    // One write, in the order of the table; the program both entries accept feeds both keys.
    expect(settings.set).toHaveBeenCalledTimes(1)
    expect(settings.set).toHaveBeenCalledWith([
      { path: ['snes_options', 'rom_file'], value: snes },
      { path: ['plain_nes_options', 'rom_file'], value: plain },
      { path: ['exe_one_options', 'rom_file'], value: exe },
      { path: ['exe_two_options', 'rom_file'], value: exe },
    ])
    expect(result).toEqual({
      applied: [
        { game: 'Snes Game', key: 'snes_options.rom_file', path: snes },
        { game: 'Plain Nes', key: 'plain_nes_options.rom_file', path: plain },
        { game: 'Exe One', key: 'exe_one_options.rom_file', path: exe },
        { game: 'Exe Two', key: 'exe_two_options.rom_file', path: exe },
      ],
      skipped: [],
    })
  })

  it('writes the keys into the settings file of Archipelago', async () => {
    const snes = write(join(roms, 'game.sfc'), SNES_BODY)
    const hostYaml = join(ap, 'host.yaml')
    writeFileSync(hostYaml, 'general_options:\n  output_path: "output"\n')
    // No Archipelago program runs.
    const noProcess: ExecFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    core.ctx.exec = noProcess
    const vault = makeVault({ settings: createApSettings(core.ctx, locator()) })
    await vault.scan([roms], task())

    await vault.apply()

    const text = readFileSync(hostYaml, 'utf8')
    expect(text).toContain('output_path: "output"')
    const written = parse(text, { version: '1.1' }) as Record<string, Record<string, unknown>>
    expect(written.snes_options).toEqual({ rom_file: snes })
  })

  it('has nothing to write for an empty vault', async () => {
    const settings = fakeSettings()
    expect(await makeVault({ settings }).apply()).toEqual({ applied: [], skipped: [] })
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('skips a ROM whose file is gone or no longer matches, and writes the others', async () => {
    const snes = write(join(roms, 'game.sfc'), SNES_BODY)
    const plain = write(join(roms, 'plain.nes'), NES_PLAIN)
    const exe = write(join(roms, 'Proteus.exe'), SHARED_EXE)
    const settings = fakeSettings()
    const vault = makeVault({ settings })
    await vault.scan([roms], task())

    rmSync(snes)
    writeFileSync(plain, bytes(4096, 31))
    stamp(plain, 2_000_000_000)
    expect(await vault.apply()).toEqual({
      applied: [
        { game: 'Exe One', key: 'exe_one_options.rom_file', path: exe },
        { game: 'Exe Two', key: 'exe_two_options.rom_file', path: exe },
      ],
      skipped: [
        { game: 'Snes Game', reason: 'ROM_MISSING' },
        { game: 'Plain Nes', reason: 'ROM_BAD_HASH' },
      ],
    })
    expect(settings.set).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when every ROM is skipped', async () => {
    const snes = write(join(roms, 'game.sfc'), SNES_BODY)
    const settings = fakeSettings()
    const vault = makeVault({ settings })
    await vault.scan([roms], task())
    rmSync(snes)
    expect(await vault.apply()).toEqual({
      applied: [],
      skipped: [{ game: 'Snes Game', reason: 'ROM_MISSING' }],
    })
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('prefers another copy of the ROM to a missing one', async () => {
    const first = write(join(roms, 'a', 'game.sfc'), SNES_BODY)
    const second = write(join(roms, 'b', 'game.sfc'), SNES_BODY)
    const vault = makeVault()
    await vault.scan([roms], task())
    rmSync(first)
    expect((await vault.apply()).applied).toEqual([
      { game: 'Snes Game', key: 'snes_options.rom_file', path: second },
    ])
  })

  it('passes SETTINGS_LOCKED through unchanged', async () => {
    write(join(roms, 'game.sfc'), SNES_BODY)
    const settings = fakeSettings()
    const locked = new AppError('SETTINGS_LOCKED', { processes: 'ArchipelagoServer.exe' })
    settings.set.mockRejectedValue(locked)
    const vault = makeVault({ settings })
    await vault.scan([roms], task())
    expect(await vault.apply().catch((error: unknown) => error)).toBe(locked)
  })
})

describe('resolveRomForEntry', () => {
  it('resolveRomForEntry: ok from effective key, ok via vault fallback, bad-hash when the key points to a wrong file', async () => {
    // Ok from the effective key: an absolute path, hashed with the header rule of the entry.
    const keyed = write(join(dir, 'Elsewhere', 'keyed.sfc'), Buffer.concat([COPIER_HEADER, SNES_BODY]))
    const withKey = makeVault({ settings: fakeSettings({ 'snes_options.rom_file': keyed }) })
    expect(await withKey.resolveRomForEntry(SNES_GAME)).toEqual({
      status: 'ok',
      path: keyed,
      vaultPath: null,
    })

    // A key that points to a wrong file, and nothing in the vault: a bad hash, with nothing to write.
    const wrong = write(join(dir, 'Elsewhere', 'wrong.sfc'), bytes(2048, 40))
    const wrongKey = fakeSettings({ 'snes_options.rom_file': wrong })
    expect(await makeVault({ settings: wrongKey }).resolveRomForEntry(SNES_GAME)).toEqual({
      status: 'bad-hash',
      path: null,
      vaultPath: null,
    })

    // Ok via the vault: no key, but the vault holds a verified copy...
    const inVault = write(join(roms, 'game.sfc'), SNES_BODY)
    const withVault = makeVault()
    await withVault.scan([roms], task())
    expect(await withVault.resolveRomForEntry(SNES_GAME)).toEqual({
      status: 'ok',
      path: inVault,
      vaultPath: inVault,
    })

    // ...and so does a key that points to a wrong file: it gives way to the vault's copy.
    expect(await makeVault({ settings: wrongKey }).resolveRomForEntry(SNES_GAME)).toEqual({
      status: 'ok',
      path: inVault,
      vaultPath: inVault,
    })
  })

  it('does not look in the vault when the effective key is valid', async () => {
    const keyed = write(join(dir, 'Elsewhere', 'keyed.sfc'), SNES_BODY)
    write(join(roms, 'copy.sfc'), SNES_BODY)
    const vault = makeVault({ settings: fakeSettings({ 'snes_options.rom_file': keyed }) })
    await vault.scan([roms], task())
    expect(await vault.resolveRomForEntry(SNES_GAME)).toEqual({ status: 'ok', path: keyed, vaultPath: null })
  })

  it('resolves a relative key against the user folder of Archipelago', async () => {
    const file = write(join(ap, 'Roms', 'game.sfc'), SNES_BODY)
    const settings = fakeSettings({ 'snes_options.rom_file': join('Roms', 'game.sfc') })
    expect(await makeVault({ settings }).resolveRomForEntry(SNES_GAME)).toEqual({
      status: 'ok',
      path: file,
      vaultPath: null,
    })
  })

  it('is missing without a key, a vault copy or an install', async () => {
    const none = { status: 'missing', path: null, vaultPath: null }
    expect(await makeVault().resolveRomForEntry(SNES_GAME)).toEqual(none)
    // An empty value, a value that is not a path, a file that is not there, a folder.
    for (const value of ['', '   ', null, 42, join(dir, 'nope.sfc'), roms]) {
      const vault = makeVault({ settings: fakeSettings({ 'snes_options.rom_file': value }) })
      expect(await vault.resolveRomForEntry(SNES_GAME)).toEqual(none)
    }
    install = null
    const settings = fakeSettings({ 'snes_options.rom_file': join(dir, 'nope.sfc') })
    expect(await makeVault({ settings }).resolveRomForEntry(SNES_GAME)).toEqual(none)
    expect(settings.get).not.toHaveBeenCalled()
  })

  it('still finds the vault copy when Archipelago is not installed', async () => {
    const inVault = write(join(roms, 'game.sfc'), SNES_BODY)
    const vault = makeVault()
    await vault.scan([roms], task())
    install = null
    expect(await vault.resolveRomForEntry(SNES_GAME)).toEqual({
      status: 'ok',
      path: inVault,
      vaultPath: inVault,
    })
  })

  it('lets an error of the settings file through', async () => {
    const settings = fakeSettings()
    settings.get.mockRejectedValue(new AppError('YAML_PARSE', { file: 'host.yaml' }))
    expect((await failure(makeVault({ settings }).resolveRomForEntry(SNES_GAME))).code).toBe('YAML_PARSE')
  })

  it('compares with the hashes it is given, such as those of a patch', async () => {
    const other = bytes(2048, 41)
    const file = write(join(roms, 'other.sfc'), other)
    const vault = makeVault({ settings: fakeSettings({ 'snes_options.rom_file': file }) })
    expect((await vault.resolveRomForEntry(SNES_GAME)).status).toBe('bad-hash')
    // The hash may be upper case, as some tools write it.
    expect(await vault.resolveRomForEntry(SNES_GAME, [md5(other).toUpperCase()])).toEqual({
      status: 'ok',
      path: file,
      vaultPath: null,
    })
  })

  it('looks in the vault for the hashes it is given', async () => {
    const other = bytes(2048, 42)
    const file = write(join(roms, 'other.sfc'), other)
    const vault = makeVault()
    await vault.scan([roms], task())
    expect((await vault.resolveRomForEntry(SNES_GAME)).status).toBe('missing')
    expect(await vault.resolveRomForEntry(SNES_GAME, [md5(other)])).toEqual({
      status: 'ok',
      path: file,
      vaultPath: file,
    })
  })

  it('hashes with the header rule of the entry', async () => {
    const withHeader = write(join(roms, 'mm.nes'), ines(NES_PRG))
    const vault = makeVault({ settings: fakeSettings({ 'ines_nes_options.rom_file': withHeader }) })
    expect((await vault.resolveRomForEntry(NES_INES_GAME)).status).toBe('ok')
    // The same file under a rule that keeps the header is another hash.
    expect((await vault.resolveRomForEntry({ ...NES_INES_GAME, header: 'none' })).status).toBe('bad-hash')
  })

  it('does not hash a file that is too big to be a ROM', async () => {
    const big = sparse(join(roms, 'big.sfc'), MAX_ROM_BYTES + 1)
    const vault = makeVault({ settings: fakeSettings({ 'snes_options.rom_file': big }) })
    expect((await vault.resolveRomForEntry(SNES_GAME)).status).toBe('bad-hash')
  })
})

describe('the index', () => {
  it('a vault record whose file changed is re-hashed before use', async () => {
    const file = write(join(roms, 'game.sfc'), SNES_BODY)
    const vault = makeVault()
    const [scanned] = await vault.scan([roms], task())
    expect(scanned?.md5).toBe(md5(SNES_BODY))

    // Same size, other bytes, later mtime: the record still says it is the game.
    const changed = bytes(SNES_BODY.length, 50)
    writeFileSync(file, changed)
    stamp(file, 2_000_000_000)
    expect(vault.findForMd5([md5(SNES_BODY)])).toEqual(scanned)

    // Using it reads the file again: no longer the game, so it is not offered...
    expect(await vault.resolveRomForEntry(SNES_GAME)).toEqual({
      status: 'missing',
      path: null,
      vaultPath: null,
    })
    // ...and the index now says what the file is.
    const rehashed = [
      {
        ...scanned,
        md5: md5(changed),
        mtimeMs: 2_000_000_000_000,
        game: null,
        label: null,
        settingsKey: null,
      },
    ]
    expect(await vault.list()).toEqual(rehashed)
    expect(vault.findForMd5([md5(SNES_BODY)])).toBeNull()
    // The new state is on disk too.
    expect(await makeVault().list()).toEqual(rehashed)
  })

  it('re-identifies a changed file that is still the game', async () => {
    const file = write(join(roms, 'game.sfc'), SNES_BODY)
    const vault = makeVault()
    await vault.scan([roms], task())
    // A longer file with the other revision: the size differs, and it is still the game.
    writeFileSync(file, Buffer.concat([COPIER_HEADER, SNES_BODY_2]))
    expect(await vault.resolveRomForEntry(SNES_GAME)).toEqual({ status: 'ok', path: file, vaultPath: file })
    expect(await vault.list()).toMatchObject([
      { md5: md5(SNES_BODY_2), size: SNES_BODY_2.length + 512, game: 'Snes Game' },
    ])
  })

  /** A folder where the index file should be: nothing can be saved there. */
  const breakIndex = (): void => {
    const file = join(core.platform.paths.userData, 'vault.json')
    rmSync(file, { force: true })
    write(join(file, 'blocker'), '')
  }

  it('fails a scan that cannot save its result', async () => {
    write(join(roms, 'game.sfc'), SNES_BODY)
    breakIndex()
    await expect(makeVault().scan([roms], task())).rejects.toBeInstanceOf(Error)
  })

  it('still offers a ROM it read again when the index cannot be saved', async () => {
    const file = write(join(roms, 'game.sfc'), SNES_BODY)
    const vault = makeVault()
    await vault.scan([roms], task())
    breakIndex()
    // The other revision, same size: read again, and still the game.
    writeFileSync(file, SNES_BODY_2)
    stamp(file, 2_000_000_000)
    expect(await vault.resolveRomForEntry(SNES_GAME)).toEqual({ status: 'ok', path: file, vaultPath: file })
  })

  it('keeps the record of a deleted file, and does not offer it', async () => {
    const file = write(join(roms, 'game.sfc'), SNES_BODY)
    const vault = makeVault()
    await vault.scan([roms], task())
    rmSync(file)
    expect((await vault.resolveRomForEntry(SNES_GAME)).status).toBe('missing')
    expect(names(await vault.list())).toEqual(['game.sfc'])
  })

  it('comes back after a restart, from userData/vault.json', async () => {
    write(join(roms, 'game.sfc'), SNES_BODY)
    write(join(roms, 'other.bin'), bytes(100, 60))
    const first = makeVault()
    await first.scan([roms], task())
    const index = JSON.parse(readFileSync(join(core.platform.paths.userData, 'vault.json'), 'utf8')) as {
      version: number
      records: RomRecord[]
    }
    expect(index.version).toBe(1)
    expect(index.records).toEqual(await first.list())
    expect(await makeVault().list()).toEqual(await first.list())
  })

  it('starts empty when vault.json is not valid, and drops the records that are not', async () => {
    const file = join(core.platform.paths.userData, 'vault.json')
    writeFileSync(file, '{ not json')
    expect(await makeVault().list()).toEqual([])

    const good: RomRecord = {
      path: join(roms, 'game.sfc'),
      size: 10,
      mtimeMs: 1,
      md5: md5(SNES_BODY),
      game: null,
      label: null,
      settingsKey: null,
    }
    const records = [good, { ...good, path: '' }, { ...good, md5: 'zz' }, { ...good, size: -1 }, 'text', null]
    writeFileSync(file, JSON.stringify({ version: 1, records }))
    expect(await makeVault().list()).toEqual([good])
    writeFileSync(file, JSON.stringify({ version: 2, records: [good] }))
    expect(await makeVault().list()).toEqual([])
  })

  it('remove forgets a ROM and never touches its file', async () => {
    const game = write(join(roms, 'game.sfc'), SNES_BODY)
    write(join(roms, 'other.bin'), bytes(100, 61))
    const vault = makeVault()
    await vault.scan([roms], task())

    await vault.remove(game)
    expect(names(await vault.list())).toEqual(['other.bin'])
    expect(existsSync(game)).toBe(true)
    expect(names(await makeVault().list())).toEqual(['other.bin'])
    // Forgetting a ROM twice, or one that was never there, is not an error.
    await vault.remove(game)
    await vault.remove(join(roms, 'never.sfc'))
    expect(names(await vault.list())).toEqual(['other.bin'])
  })

  it.runIf(hostOs === 'win32')('knows a Windows path whatever its case', async () => {
    const game = write(join(roms, 'game.sfc'), SNES_BODY)
    const vault = makeVault()
    await vault.scan([game.toUpperCase()], task())
    await vault.scan([game.toLowerCase()], task())
    expect(await vault.list()).toHaveLength(1)
    await vault.remove(game)
    expect(await vault.list()).toEqual([])
  })

  it('findForMd5 gives the first record with one of the hashes', async () => {
    write(join(roms, 'a.sfc'), SNES_BODY)
    write(join(roms, 'b.sfc'), SNES_BODY_2)
    const vault = makeVault()
    expect(vault.findForMd5([md5(SNES_BODY)])).toBeNull()
    await vault.scan([roms], task())
    expect(basename(vault.findForMd5(SNES_GAME.md5s)?.path ?? '')).toBe('a.sfc')
    const upper = md5(SNES_BODY_2).toUpperCase()
    expect(basename(vault.findForMd5(['0'.repeat(32), upper])?.path ?? '')).toBe('b.sfc')
    expect(vault.findForMd5(['0'.repeat(32)])).toBeNull()
    expect(vault.findForMd5([])).toBeNull()
  })

  it('serializes concurrent writes', async () => {
    const files = ['a', 'b', 'c', 'd'].map((name) =>
      write(join(roms, `${name}.sfc`), bytes(2048, name.charCodeAt(0))),
    )
    const vault = makeVault()
    await Promise.all(files.map((file) => vault.scan([file], task())))
    expect(names(await vault.list()).sort()).toEqual(['a.sfc', 'b.sfc', 'c.sfc', 'd.sfc'])
    expect(names(await makeVault().list()).sort()).toEqual(['a.sfc', 'b.sfc', 'c.sfc', 'd.sfc'])
  })
})

describe('vault handlers', () => {
  it('run the vault service', async () => {
    writeFileSync(join(ap, apExeFileName('ArchipelagoLauncher', hostOs)), '')
    writeFileSync(join(ap, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
    core.ctx.config.updateInternal({ apPathOverride: ap })
    // No real process list: none runs.
    core.ctx.exec = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    const done: TaskDone[] = []
    core.ctx.bus.on('task:done', (event) => done.push(event))

    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    const call = async <T>(name: string, input?: unknown): Promise<T> => {
      const result = await ipc.dispatch(name, input, { senderId: 1 })
      if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`)
      return result.value as T
    }

    expect(await call('vault:list')).toEqual([])
    expect(await call('vault:table')).toEqual(ROM_TABLE)

    const game = write(join(roms, 'unknown.sfc'), SNES_BODY)
    const { taskId } = await call<{ taskId: string }>('vault:scan', { paths: [roms] })
    await vi.waitFor(() => expect(done.map((event) => event.taskId)).toContain(taskId))
    const result = done.find((event) => event.taskId === taskId)
    expect(result?.kind).toBe('rom-scan')
    // The task result is what the screen counts: the ROMs of this scan.
    expect(result?.result).toMatchObject([{ path: game, md5: md5(SNES_BODY), game: null }])
    expect(await call('vault:list')).toEqual(result?.result)

    // Nothing recognised: nothing to apply.
    expect(await call('vault:apply')).toEqual({ applied: [], skipped: [] })
    expect(await call('vault:remove', { path: game })).toBeUndefined()
    expect(await call('vault:list')).toEqual([])
  })

  it('answers a refused path as a failed task', async () => {
    const failed: string[] = []
    core.ctx.bus.on('task:failed', (event) => failed.push(event.error.code))
    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    const started = await ipc.dispatch('vault:scan', { paths: ['relative'] }, { senderId: 1 })
    expect(started.ok).toBe(true)
    await vi.waitFor(() => expect(failed).toEqual(['PATH_FORBIDDEN']))
  })
})
