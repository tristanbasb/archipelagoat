import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  backupFile,
  ensureDir,
  isWritableDir,
  moveFile,
  pathExists,
  safeJoin,
  writeFileAtomic,
  writeStreamAtomic,
} from '@main/core/system/fsx'

// `rename` and `rm` can be made to fail (a move between two volumes, a source that stays locked);
// they are the real ones unless a test says otherwise.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat fsx é-'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(rename).mockReset() // back to the real functions, and no call history
  vi.mocked(rm).mockReset()
  rmSync(root, { recursive: true, force: true })
})

const names = (dir: string): string[] => readdirSync(dir).sort()

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe('safeJoin', () => {
  it('rejects ../ escape and absolute injection', () => {
    expect(() => safeJoin('/a', '../b')).toThrow(/PATH_FORBIDDEN/)
    expect(() => safeJoin(root, '/etc/passwd')).toThrow(/PATH_FORBIDDEN/)
  })

  it.skipIf(process.platform !== 'win32')('rejects drive, drive-relative and UNC paths on Windows', () => {
    for (const part of ['C:\\Windows\\win.ini', 'D:evil', '\\\\server\\share\\x', '..\\..\\x']) {
      expect(() => safeJoin(root, part)).toThrow(/PATH_FORBIDDEN/)
    }
  })

  it('rejects every way out of the base, including sibling folders that share its prefix', () => {
    const base = join(root, 'base')
    for (const parts of [['..'], ['..', 'x'], ['a', '..', '..', 'x'], ['../base-evil/x'], ['a/../../b']]) {
      expect(() => safeJoin(base, ...parts)).toThrow(/PATH_FORBIDDEN/)
    }
  })

  it('says why it refused', () => {
    expect(thrown(() => safeJoin(root, '../x'))).toMatchObject({
      code: 'PATH_FORBIDDEN',
      params: { reason: 'traversal' },
    })
    expect(thrown(() => safeJoin(root, 'a\0b'))).toMatchObject({
      code: 'PATH_FORBIDDEN',
      params: { reason: 'invalid' },
    })
  })

  it('returns the absolute joined path when it stays inside the base', () => {
    const base = join(root, 'base')
    expect(safeJoin(base, 'a', 'b.txt')).toBe(resolve(base, 'a', 'b.txt'))
    expect(safeJoin(base, 'a/../b')).toBe(resolve(base, 'b'))
    expect(safeJoin(base, 'dossier é', 'fichier 1.txt')).toBe(resolve(base, 'dossier é', 'fichier 1.txt'))
  })

  it('accepts the base itself', () => {
    expect(safeJoin(root)).toBe(resolve(root))
    expect(safeJoin(root, '.')).toBe(resolve(root))
  })
})

describe('writeFileAtomic', () => {
  it('writes text and bytes and replaces an existing file', async () => {
    const file = join(root, 'f.txt')
    await writeFileAtomic(file, 'one')
    expect(readFileSync(file, 'utf8')).toBe('one')
    await writeFileAtomic(file, Buffer.from([0, 1, 2, 255]))
    expect(readFileSync(file)).toEqual(Buffer.from([0, 1, 2, 255]))
  })

  it('leaves no .tmp and survives a path with spaces and é', async () => {
    const dir = join(root, 'Jérôme Dupont', 'sous dossier')
    const file = join(dir, 'réglages hôte.yaml')
    await writeFileAtomic(file, 'name: Jérôme\n')
    expect(readFileSync(file, 'utf8')).toBe('name: Jérôme\n')
    expect(names(dir)).toEqual(['réglages hôte.yaml'])
  })

  it('leaves the old content and no temporary file when it cannot replace the target', async () => {
    const target = join(root, 'dir-target')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow()
    expect(names(root)).toEqual(['dir-target'])
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('does not interleave two concurrent writes', async () => {
    const file = join(root, 'race.txt')
    const a = 'a'.repeat(200_000)
    const b = 'b'.repeat(200_000)
    await Promise.all([writeFileAtomic(file, a), writeFileAtomic(file, b)])
    expect([a, b]).toContain(readFileSync(file, 'utf8'))
    expect(names(root)).toEqual(['race.txt'])
  })
})

describe('writeStreamAtomic', () => {
  it('replaces the file with the content of the stream', async () => {
    const file = join(root, 'out', 's é.bin')
    await writeStreamAtomic(file, Readable.from([Buffer.from('new '), Buffer.from('data')]))
    await writeStreamAtomic(file, Readable.from([Buffer.from('newer')]))
    expect(readFileSync(file, 'utf8')).toBe('newer')
    expect(names(join(root, 'out'))).toEqual(['s é.bin'])
  })

  it('keeps the old file and leaves no temporary file when the stream fails', async () => {
    const file = join(root, 's.bin')
    writeFileSync(file, 'old')
    const failing = new Readable({
      read() {
        this.push('partial')
        this.destroy(new Error('stream broke'))
      },
    })
    await expect(writeStreamAtomic(file, failing)).rejects.toThrow('stream broke')
    expect(readFileSync(file, 'utf8')).toBe('old')
    expect(names(root)).toEqual(['s.bin'])
  })
})

describe('pathExists, ensureDir', () => {
  it('pathExists tells files, folders and missing paths apart', async () => {
    writeFileSync(join(root, 'f'), '')
    expect(await pathExists(join(root, 'f'))).toBe(true)
    expect(await pathExists(root)).toBe(true)
    expect(await pathExists(join(root, 'nope'))).toBe(false)
  })

  it('ensureDir creates nested folders and is idempotent', async () => {
    const dir = join(root, 'a é', 'b', 'c')
    await ensureDir(dir)
    await ensureDir(dir)
    expect(existsSync(dir)).toBe(true)
  })
})

describe('isWritableDir', () => {
  it('is true for a folder we can write to, and leaves nothing behind', async () => {
    expect(await isWritableDir(root)).toBe(true)
    expect(names(root)).toEqual([])
  })

  it('is false for a missing path and for a file, and does not create the folder', async () => {
    expect(await isWritableDir(join(root, 'missing'))).toBe(false)
    expect(existsSync(join(root, 'missing'))).toBe(false)
    writeFileSync(join(root, 'file'), '')
    expect(await isWritableDir(join(root, 'file'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is false for a read-only folder (a real write, not an access() check)',
    async () => {
      const dir = join(root, 'ro')
      mkdirSync(dir)
      chmodSync(dir, 0o555)
      try {
        expect(await isWritableDir(dir)).toBe(false)
      } finally {
        chmodSync(dir, 0o755)
      }
    },
  )
})

describe('backupFile', () => {
  it('creates a timestamped folder and preserves content', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 16, 13, 5, 9))
    const src = join(root, 'host.yaml')
    writeFileSync(src, 'server_options: é\n')
    const backups = join(root, 'backups')

    const copy = await backupFile(src, backups, 'before-update')

    expect(copy).toBe(join(backups, '20261016-130509-before-update', 'host.yaml'))
    expect(readFileSync(copy, 'utf8')).toBe('server_options: é\n')
    expect(readFileSync(src, 'utf8')).toBe('server_options: é\n')
  })

  it('never overwrites a backup made within the same second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5))
    const src = join(root, 'options.yaml')
    const backups = join(root, 'backups')
    writeFileSync(src, 'v1')
    const first = await backupFile(src, backups, 'x')
    writeFileSync(src, 'v2')
    const second = await backupFile(src, backups, 'x')
    writeFileSync(src, 'v3')
    const third = await backupFile(src, backups, 'x')

    expect([first, second, third].map((p) => readFileSync(p, 'utf8'))).toEqual(['v1', 'v2', 'v3'])
    expect(names(backups)).toEqual(['20260102-030405-x', '20260102-030405-x-2', '20260102-030405-x-3'])
  })

  it('keeps the label inside one folder name', async () => {
    const src = join(root, 'a.txt')
    writeFileSync(src, 'a')
    const backups = join(root, 'backups')
    const copy = await backupFile(src, backups, '../../évasion/x:y')
    expect(resolve(copy, '..', '..')).toBe(resolve(backups))
    expect(names(root)).toEqual(['a.txt', 'backups'])
  })

  it('works with an empty label', async () => {
    const src = join(root, 'a.txt')
    writeFileSync(src, 'a')
    const copy = await backupFile(src, join(root, 'b'), '')
    expect(copy).toMatch(/[\\/]\d{8}-\d{6}[\\/]a\.txt$/)
  })

  it('rejects a missing source and leaves no empty folder behind', async () => {
    const backups = join(root, 'b')
    await expect(backupFile(join(root, 'ghost'), backups, 'x')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(names(backups)).toEqual([])
  })
})

describe('moveFile', () => {
  it('moves the file into the folder, creating it, and returns the new path', async () => {
    const src = join(root, 'download é.zip')
    writeFileSync(src, 'zip')
    const dest = join(root, 'new', 'dir')

    const moved = await moveFile(src, dest)

    expect(moved).toBe(join(dest, 'download é.zip'))
    expect(readFileSync(moved, 'utf8')).toBe('zip')
    expect(existsSync(src)).toBe(false)
  })

  it('adds -2, -3… before the extension on collision and never overwrites', async () => {
    const dest = join(root, 'dest')
    mkdirSync(dest)
    writeFileSync(join(dest, 'w.apworld'), 'old')
    const moved: string[] = []
    for (const content of ['b', 'c']) {
      const src = join(root, 'w.apworld')
      writeFileSync(src, content)
      moved.push(await moveFile(src, dest))
    }
    expect(moved).toEqual([join(dest, 'w-2.apworld'), join(dest, 'w-3.apworld')])
    expect(readFileSync(join(dest, 'w.apworld'), 'utf8')).toBe('old')
    expect(readFileSync(join(dest, 'w-2.apworld'), 'utf8')).toBe('b')
    expect(readFileSync(join(dest, 'w-3.apworld'), 'utf8')).toBe('c')
  })

  it('keeps .tar.gz together and handles names without an extension', async () => {
    const dest = join(root, 'dest')
    mkdirSync(dest)
    writeFileSync(join(dest, 'ap.tar.gz'), 'old')
    writeFileSync(join(dest, 'README'), 'old')
    writeFileSync(join(root, 'ap.tar.gz'), 'new')
    writeFileSync(join(root, 'README'), 'new')
    expect(await moveFile(join(root, 'ap.tar.gz'), dest)).toBe(join(dest, 'ap-2.tar.gz'))
    expect(await moveFile(join(root, 'README'), dest)).toBe(join(dest, 'README-2'))
  })

  it('moves two files of the same name at once without losing one', async () => {
    const dest = join(root, 'dest')
    const a = join(root, 'a', 'same.bin')
    const b = join(root, 'b', 'same.bin')
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    writeFileSync(a, 'A')
    writeFileSync(b, 'B')
    const moved = await Promise.all([moveFile(a, dest), moveFile(b, dest)])
    expect(new Set(moved).size).toBe(2)
    expect(moved.map((p) => readFileSync(p, 'utf8')).sort()).toEqual(['A', 'B'])
    expect(names(dest)).toEqual(['same-2.bin', 'same.bin'])
  })

  it('falls back to copy then delete when the volumes differ (EXDEV)', async () => {
    const src = join(root, 'big.zip')
    writeFileSync(src, 'payload')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }))
    const dest = join(root, 'other-volume')

    const moved = await moveFile(src, dest)

    expect(vi.mocked(rename)).toHaveBeenCalled()
    expect(readFileSync(moved, 'utf8')).toBe('payload')
    expect(existsSync(src)).toBe(false)
    expect(names(dest)).toEqual(['big.zip'])
  })

  it('keeps the source when the copy of a cross-volume move cannot delete it', async () => {
    const src = join(root, 'big.zip')
    writeFileSync(src, 'payload')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }))
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }))
    const dest = join(root, 'other-volume')

    await expect(moveFile(src, dest)).rejects.toMatchObject({ code: 'EBUSY' })

    expect(readFileSync(src, 'utf8')).toBe('payload')
    expect(names(dest)).toEqual([])
  })

  it('leaves the source and no placeholder behind when the move fails', async () => {
    const src = join(root, 'a.txt')
    writeFileSync(src, 'a')
    // Every attempt fails: a held file (antivirus scan) is retried a few times, then reported.
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('nope'), { code: 'EACCES' }))
    const dest = join(root, 'dest')

    await expect(moveFile(src, dest)).rejects.toMatchObject({ code: 'EACCES' })

    expect(readFileSync(src, 'utf8')).toBe('a')
    expect(names(dest)).toEqual([])
  })

  it('rejects a missing source without leaving a placeholder', async () => {
    const dest = join(root, 'dest')
    await expect(moveFile(join(root, 'ghost.txt'), dest)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(names(dest)).toEqual([])
  })
})
