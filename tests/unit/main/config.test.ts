import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigStore, defaultConfig } from '@main/core/config'
import { createEventBus } from '@main/core/events'
import type { AppConfig } from '@shared/types'
import { silentLogger } from '../../helpers/core'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat-config-'))
  file = join(dir, 'nested', 'config.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('defaultConfig', () => {
  it('has the documented defaults', () => {
    expect(defaultConfig('win32')).toEqual({
      language: 'auto',
      effects: { crt: true, glow: true, animations: true, sounds: false },
      showAfterDark: false,
      apPathOverride: null,
      desktopIcons: true,
      integration: { linuxDesktop: false, winProtocol: false, winAssociations: false },
      allowPlaintextSecrets: false,
      firstRunDone: false,
      firstLocalHostDone: false,
      webhostUrl: 'https://archipelago.gg',
    })
  })

  it('enables the linux desktop integration on linux only', () => {
    expect(defaultConfig('linux').integration.linuxDesktop).toBe(true)
    expect(defaultConfig('win32').integration.linuxDesktop).toBe(false)
  })
})

describe('config store', () => {
  it('starts from the defaults when no file exists', () => {
    expect(createConfigStore(file, 'linux').get()).toEqual(defaultConfig('linux'))
  })

  it('deep-merges patch, persists atomically, emits config:changed', () => {
    const bus = createEventBus(silentLogger)
    const changed = vi.fn()
    bus.on('config:changed', changed)
    const store = createConfigStore(file, 'win32', { bus })

    const next = store.update({ effects: { crt: false }, language: 'fr' })

    expect(next.effects).toEqual({ crt: false, glow: true, animations: true, sounds: false })
    expect(next.language).toBe('fr')
    expect(store.get()).toEqual(next)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(next)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['config.json'])
    expect(changed).toHaveBeenCalledExactlyOnceWith(next)
    expect(createConfigStore(file, 'win32').get()).toEqual(next)
  })

  it('refuses patch fields that only the main process may change', () => {
    const store = createConfigStore(file, 'win32')
    expect(() => store.update({ apPathOverride: 'C:\\evil' } as never)).toThrow(/INVALID_INPUT/)
    expect(() => store.update({ integration: { winProtocol: true } } as never)).toThrow(/INVALID_INPUT/)
    expect(() => store.update({ webhostUrl: 'https://evil.example' } as never)).toThrow(/INVALID_INPUT/)
    expect(store.get()).toEqual(defaultConfig('win32'))
  })

  it('updateInternal changes main-only fields and merges nested objects', () => {
    const bus = createEventBus(silentLogger)
    const changed = vi.fn()
    bus.on('config:changed', changed)
    const store = createConfigStore(file, 'win32', { bus })
    const next = store.updateInternal({
      apPathOverride: 'D:\\Archipelago',
      integration: { ...defaultConfig('win32').integration, winProtocol: true },
    })
    expect(next.apPathOverride).toBe('D:\\Archipelago')
    expect(next.integration).toEqual({ linuxDesktop: false, winProtocol: true, winAssociations: false })
    expect(createConfigStore(file, 'win32').get().apPathOverride).toBe('D:\\Archipelago')
    expect(changed).toHaveBeenCalledOnce()
  })

  it('falls back to the defaults for a corrupt file and for each invalid field', () => {
    const defaults = defaultConfig('win32')
    writeFileSync(join(dir, 'broken.json'), '{not json')
    expect(createConfigStore(join(dir, 'broken.json'), 'win32').get()).toEqual(defaults)

    writeFileSync(
      join(dir, 'partial.json'),
      JSON.stringify({ language: 'de', showAfterDark: true, effects: { crt: 'no', glow: false }, future: 1 }),
    )
    expect(createConfigStore(join(dir, 'partial.json'), 'win32').get()).toEqual({
      ...defaults,
      showAfterDark: true,
      effects: { ...defaults.effects, glow: false },
    })
  })

  it('applies the GOAT_WEBHOST_URL override at runtime without persisting it', () => {
    const store = createConfigStore(file, 'win32', { webhostUrlOverride: 'http://127.0.0.1:9999' })
    expect(store.get().webhostUrl).toBe('http://127.0.0.1:9999')
    expect(store.update({ firstRunDone: true }).webhostUrl).toBe('http://127.0.0.1:9999')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as AppConfig
    expect(saved.webhostUrl).toBe('https://archipelago.gg')
    expect(saved.firstRunDone).toBe(true)
  })

  it('get returns a copy that callers cannot use to mutate the store', () => {
    const store = createConfigStore(file, 'win32')
    store.get().effects.crt = false
    expect(store.get().effects.crt).toBe(true)
  })
})
