import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OS } from '@shared/types'

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '1.2.3'),
    getLocale: vi.fn(() => 'fr'),
    getPath: vi.fn((name: string) => `/paths/${name}`),
    setAsDefaultProtocolClient: vi.fn(() => true),
    removeAsDefaultProtocolClient: vi.fn(() => true),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString().slice(4)),
  },
  shell: { openPath: vi.fn(() => Promise.resolve('')), openExternal: vi.fn(() => Promise.resolve()) },
  dialog: {
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths: ['/picked'] })),
    showSaveDialog: vi.fn(() => Promise.resolve({ canceled: false, filePath: '/saved.yaml' })),
  },
}))

vi.mock('electron', () => electron)

const { createPlatform, resolveDataRoot } = await import('@main/platform')

const make = (os: OS, env: NodeJS.ProcessEnv = {}, testEnv = false) =>
  createPlatform({ os, dataRoot: '/data', testEnv, env, getWindow: () => null })

let dir: string

beforeEach(() => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'goat-platform-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('resolveDataRoot', () => {
  it('uses %LOCALAPPDATA% on Windows', () => {
    expect(
      resolveDataRoot({
        os: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
        home: 'C:\\Users\\a',
        testEnv: false,
      }),
    ).toBe('C:\\Users\\a\\AppData\\Local\\ArchipelaGOAT')
    expect(resolveDataRoot({ os: 'win32', env: {}, home: 'C:\\Users\\a', testEnv: false })).toBe(
      'C:\\Users\\a\\AppData\\Local\\ArchipelaGOAT',
    )
  })

  it('uses an absolute $XDG_DATA_HOME on Linux, ~/.local/share otherwise', () => {
    expect(
      resolveDataRoot({ os: 'linux', env: { XDG_DATA_HOME: '/x/data' }, home: '/home/u', testEnv: false }),
    ).toBe('/x/data/ArchipelaGOAT')
    expect(
      resolveDataRoot({ os: 'linux', env: { XDG_DATA_HOME: 'rel' }, home: '/home/u', testEnv: false }),
    ).toBe('/home/u/.local/share/ArchipelaGOAT')
  })

  it('honours GOAT_DATA_ROOT only in the test environment', () => {
    const env = { GOAT_DATA_ROOT: '/tmp/goat-e2e', XDG_DATA_HOME: '/x' }
    expect(resolveDataRoot({ os: 'linux', env, home: '/home/u', testEnv: true })).toBe('/tmp/goat-e2e')
    expect(resolveDataRoot({ os: 'linux', env, home: '/home/u', testEnv: false })).toBe('/x/ArchipelaGOAT')
  })
})

describe('electron platform', () => {
  it('reads the app identity and folders from Electron', () => {
    const platform = make('win32')
    expect(platform).toMatchObject({ os: 'win32', appVersion: '1.2.3', isPackaged: false, locale: 'fr' })
    expect(platform.paths).toEqual({
      userData: '/paths/userData',
      dataRoot: '/data',
      temp: '/paths/temp',
      home: '/paths/home',
      downloads: '/paths/downloads',
      exe: '/paths/exe',
    })
  })

  it('refuses the weak basic_text keyring on Linux', () => {
    expect(make('linux').canEncrypt()).toBe(true)
    electron.safeStorage.getSelectedStorageBackend.mockReturnValueOnce('basic_text')
    expect(make('linux').canEncrypt()).toBe(false)
    expect(make('win32').canEncrypt()).toBe(true)
    electron.safeStorage.isEncryptionAvailable.mockReturnValueOnce(false)
    expect(make('win32').canEncrypt()).toBe(false)
  })

  it('encrypts through safeStorage', () => {
    const platform = make('win32')
    expect(platform.decrypt(platform.encrypt('s3cret'))).toBe('s3cret')
  })

  it('maps dialog modes to Electron properties and cancellations to empty answers', async () => {
    const platform = make('win32')
    await expect(platform.showOpenDialog({ mode: 'directory', title: 'T' })).resolves.toEqual(['/picked'])
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith({ title: 'T', properties: ['openDirectory'] })
    await platform.showOpenDialog({ mode: 'files', filters: [{ name: 'YAML', extensions: ['yaml'] }] })
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith({
      filters: [{ name: 'YAML', extensions: ['yaml'] }],
      properties: ['openFile', 'multiSelections'],
    })
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(platform.showOpenDialog({ mode: 'file' })).resolves.toEqual([])

    await expect(platform.showSaveDialog({ defaultName: 'P1.yaml' })).resolves.toBe('/saved.yaml')
    expect(electron.dialog.showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'P1.yaml' })
    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' })
    await expect(platform.showSaveDialog({ defaultName: 'P1.yaml' })).resolves.toBeNull()
  })

  it('answers dialogs from the GOAT_E2E_DIALOGS queue in the test environment', async () => {
    const queue = join(dir, 'dialogs.json')
    writeFileSync(queue, JSON.stringify([['C:\\a.yaml', 'C:\\b.yaml'], 'C:\\out.yaml', null]))
    const platform = make('win32', { GOAT_E2E_DIALOGS: queue }, true)

    await expect(platform.showOpenDialog({ mode: 'files' })).resolves.toEqual(['C:\\a.yaml', 'C:\\b.yaml'])
    await expect(platform.showSaveDialog({ defaultName: 'x.yaml' })).resolves.toBe('C:\\out.yaml')
    expect(JSON.parse(readFileSync(queue, 'utf8'))).toEqual([null])
    await expect(platform.showOpenDialog({ mode: 'file' })).resolves.toEqual([])
    await expect(platform.showSaveDialog({ defaultName: 'x.yaml' })).resolves.toBeNull()
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled()
    expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled()
  })

  it('ignores GOAT_E2E_DIALOGS outside the test environment', async () => {
    const queue = join(dir, 'dialogs.json')
    writeFileSync(queue, JSON.stringify([['C:\\a.yaml']]))
    await expect(
      make('win32', { GOAT_E2E_DIALOGS: queue }, false).showOpenDialog({ mode: 'file' }),
    ).resolves.toEqual(['/picked'])
  })

  it('openPath reports shell failures as NOT_FOUND', async () => {
    const platform = make('win32')
    await expect(platform.openPath('/data/logs')).resolves.toBeUndefined()
    electron.shell.openPath.mockResolvedValueOnce('Failed to open path')
    await expect(platform.openPath('/data/nope')).rejects.toThrow(/NOT_FOUND/)
  })

  it('registers and removes the archipelago:// protocol client', () => {
    const platform = make('win32')
    expect(platform.setProtocolClient(true)).toBe(true)
    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      'archipelago',
      expect.any(String),
      expect.any(Array),
    )
    expect(platform.setProtocolClient(false)).toBe(true)
    expect(electron.app.removeAsDefaultProtocolClient).toHaveBeenCalledWith(
      'archipelago',
      expect.any(String),
      expect.any(Array),
    )
  })
})
