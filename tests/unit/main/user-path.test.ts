import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertUserPath,
  createAllowedPaths,
  type UserPathEnv,
  type UserPathOptions,
} from '@main/core/system/user-path'

const WIN: UserPathEnv = { os: 'win32', windir: 'C:\\Windows', appDir: 'C:\\Program Files\\ArchipelaGOAT' }
const LINUX: UserPathEnv = { os: 'linux', windir: null, appDir: '/opt/ArchipelaGOAT' }

const lexical = (p: string, env: UserPathEnv, opts: UserPathOptions = {}): Promise<string> =>
  assertUserPath(p, { mustExist: false, ...opts }, env)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat-user-path-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('assertUserPath', () => {
  it('assertUserPath rejects relative, UNC, system dirs and missing files', async () => {
    const windows = [
      'relative\\file.yaml',
      'C:file.yaml',
      '\\rooted\\without\\drive',
      '\\\\?\\C:\\Users\\x',
      '\\\\.\\pipe\\x',
      '\\\\server\\share\\x.yaml',
      '//server/share/x.yaml',
      'C:\\Windows\\System32\\drivers',
      'c:\\windows',
      'C:\\Users\\..\\Windows\\win.ini',
      'C:\\Program Files\\ArchipelaGOAT\\resources\\app.asar',
    ]
    for (const p of windows) await expect(lexical(p, WIN), p).rejects.toThrow(/PATH_FORBIDDEN/)

    const linux = [
      'relative/x.yaml',
      '/etc/passwd',
      '/usr/bin',
      '/bin',
      '/proc/self/environ',
      '/sys/kernel',
      '/home/u/../../etc/shadow',
      '/opt/ArchipelaGOAT/chrome-sandbox',
    ]
    for (const p of linux) await expect(lexical(p, LINUX), p).rejects.toThrow(/PATH_FORBIDDEN/)

    await expect(assertUserPath(join(dir, 'missing.yaml'))).rejects.toThrow(/NOT_FOUND/)
  })

  it('refuses on Windows the characters no file name may hold, which could hide a forbidden folder', async () => {
    // Quoted on a command line, a pair of quotes vanishes: these would reach a program as
    // C:\\Program Files\\… and C:\\Windows\\System32, past the checks.
    const tricks = [
      'C:\\Program"" Files\\SomeVendor\\SomeApp',
      'C:\\Win""dows\\System32',
      'C:\\Games\\x" /LOADINF="\\Users\\Public\\a.inf',
      'D:\\Jeux\\a<b',
      'D:\\Jeux\\a>b',
      'D:\\Jeux\\a|b',
      'D:\\Jeux\\what?',
      'D:\\Jeux\\*',
      'D:\\Jeux\\tab\there',
    ]
    for (const p of tricks) {
      await expect(lexical(p, WIN, { access: 'write' }), p).rejects.toMatchObject({
        code: 'PATH_FORBIDDEN',
        params: { reason: 'invalid' },
      })
    }
    // Linux allows them in a name: only NUL is refused there.
    await expect(lexical('/home/u/what?', LINUX)).resolves.toBe('/home/u/what?')
  })

  it('refuses empty strings and NUL bytes', async () => {
    await expect(lexical('', WIN)).rejects.toThrow(/PATH_FORBIDDEN/)
    await expect(lexical('/home/u/x\0.yaml', LINUX)).rejects.toThrow(/PATH_FORBIDDEN/)
  })

  it('allows reading Program Files but never writing there', async () => {
    await expect(lexical('C:\\Program Files\\BizHawk', WIN)).resolves.toBe('C:\\Program Files\\BizHawk')
    await expect(lexical('C:\\Program Files\\BizHawk', WIN, { access: 'write' })).rejects.toThrow(
      /PATH_FORBIDDEN/,
    )
    await expect(lexical('D:\\Program Files (x86)\\AP', WIN, { access: 'write' })).rejects.toThrow(
      /PATH_FORBIDDEN/,
    )
    await expect(lexical('D:\\Jeux\\Program Files Backup', WIN, { access: 'write' })).resolves.toBe(
      'D:\\Jeux\\Program Files Backup',
    )
  })

  it('returns the normalized path, accents and spaces kept', async () => {
    await expect(lexical('C:/Users/Jérôme Dupont/./Documents/../x.yaml', WIN)).resolves.toBe(
      'C:\\Users\\Jérôme Dupont\\x.yaml',
    )
    await expect(lexical('D:\\Jeux\\', WIN)).resolves.toBe('D:\\Jeux')
    await expect(lexical('/home/jérôme/./roms//', LINUX)).resolves.toBe('/home/jérôme/roms')
    await expect(lexical('/', LINUX)).resolves.toBe('/')
  })

  it('checks the kind and the extension', async () => {
    const yaml = join(dir, 'Player One.YAML')
    writeFileSync(yaml, 'name: P1\n')
    await expect(assertUserPath(yaml, { kind: 'file', exts: ['.yaml', '.yml'] })).resolves.toBe(yaml)
    await expect(assertUserPath(yaml, { kind: 'dir' })).rejects.toThrow(/PATH_FORBIDDEN/)
    await expect(assertUserPath(dir, { kind: 'file' })).rejects.toThrow(/PATH_FORBIDDEN/)
    await expect(assertUserPath(dir, { kind: 'dir' })).resolves.toBe(dir)
    await expect(assertUserPath(yaml, { exts: ['.apworld'] })).rejects.toThrow(/PATH_FORBIDDEN/)
    await expect(assertUserPath(join(dir, 'new.txt'), { mustExist: false, exts: ['.yaml'] })).rejects.toThrow(
      /PATH_FORBIDDEN/,
    )
    await expect(assertUserPath(join(dir, 'new', 'out'), { mustExist: false, kind: 'dir' })).resolves.toBe(
      join(dir, 'new', 'out'),
    )
  })

  it('refuses Windows device names and alternate data streams', async () => {
    for (const p of [
      'C:\\Users\\x\\NUL',
      'C:\\Users\\x\\con.yaml',
      'D:\\roms\\COM1\\x',
      'C:\\Users\\x\\f.yaml:hidden',
    ]) {
      await expect(lexical(p, WIN), p).rejects.toThrow(/PATH_FORBIDDEN/)
    }
    await expect(lexical('C:\\Users\\x\\console.yaml', WIN)).resolves.toBe('C:\\Users\\x\\console.yaml')
    await expect(lexical('/home/u/con.yaml', LINUX)).resolves.toBe('/home/u/con.yaml')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink that leads into a system folder', async () => {
    const link = join(dir, 'innocent')
    symlinkSync('/etc', link)
    await expect(assertUserPath(link)).rejects.toThrow(/PATH_FORBIDDEN/)
  })

  it('follows a junction or symlink in the parents of a path that does not exist yet', async () => {
    const appDir = join(dir, 'app')
    mkdirSync(appDir)
    symlinkSync(appDir, join(dir, 'link'), 'junction')
    const env: UserPathEnv = { os: process.platform === 'win32' ? 'win32' : 'linux', windir: null, appDir }
    await expect(
      assertUserPath(join(dir, 'link', 'resources', 'new.txt'), { mustExist: false, access: 'write' }, env),
    ).rejects.toThrow(/PATH_FORBIDDEN/)
    await expect(assertUserPath(join(dir, 'link'), {}, env)).rejects.toThrow(/PATH_FORBIDDEN/)
    await expect(assertUserPath(join(dir, 'other', 'new.txt'), { mustExist: false }, env)).resolves.toBe(
      join(dir, 'other', 'new.txt'),
    )
  })
})

describe('allowed paths', () => {
  it('accepts paths inside a root, case-insensitively on Windows, and nothing else', async () => {
    const paths = createAllowedPaths(['C:\\Users\\a\\AppData\\Local\\ArchipelaGOAT'], 'win32')
    expect(await paths.isAllowed('c:\\users\\A\\AppData\\Local\\ArchipelaGOAT\\logs')).toBe(true)
    expect(await paths.isAllowed('C:\\Users\\a\\AppData\\Local\\ArchipelaGOAT')).toBe(true)
    expect(await paths.isAllowed('C:\\Users\\a\\AppData\\Local\\ArchipelaGOAT-evil')).toBe(false)
    expect(await paths.isAllowed('C:\\Users\\a\\AppData\\Local\\ArchipelaGOAT\\..\\x')).toBe(false)
    expect(await paths.isAllowed('relative\\logs')).toBe(false)
    expect(await paths.isAllowed('\\\\server\\share')).toBe(false)
  })

  it('is case-sensitive on Linux', async () => {
    const paths = createAllowedPaths(['/home/u/.local/share/ArchipelaGOAT'], 'linux')
    expect(await paths.isAllowed('/home/u/.local/share/ArchipelaGOAT/logs')).toBe(true)
    expect(await paths.isAllowed('/home/u/.local/share/archipelagoat/logs')).toBe(false)
  })

  it('asks every provider on each check and survives a failing one', async () => {
    const roots = createAllowedPaths([], 'linux')
    let extra: string[] = []
    roots.addAllowedRoots(() => Promise.reject(new Error('locator down')))
    roots.addAllowedRoots(() => Promise.resolve(extra))
    expect(await roots.isAllowed('/srv/ap/Players')).toBe(false)
    extra = ['/srv/ap']
    expect(await roots.isAllowed('/srv/ap/Players')).toBe(true)
  })

  it('follows symlinks of existing paths before comparing', async () => {
    const root = join(dir, 'root')
    mkdirSync(root)
    const paths = createAllowedPaths([root], process.platform === 'win32' ? 'win32' : 'linux')
    expect(await paths.isAllowed(join(root, 'sub'))).toBe(true)
    if (process.platform !== 'win32') {
      symlinkSync(tmpdir(), join(root, 'escape'))
      expect(await paths.isAllowed(join(root, 'escape'))).toBe(false)
    }
  })
})
