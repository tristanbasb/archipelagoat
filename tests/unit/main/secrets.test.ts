import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigStore, type ConfigStore } from '@main/core/config'
import { createSecretStore } from '@main/core/secrets'
import { fakePlatform } from '../../helpers/core'

const TOKEN = 'ghp_SuperSecret123'

let dir: string
let file: string
let config: ConfigStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat-secrets-'))
  file = join(dir, 'userData', 'secrets.bin')
  config = createConfigStore(join(dir, 'config.json'), 'linux')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('secret store', () => {
  it('encrypts at rest (file does not contain plaintext)', () => {
    const { platform } = fakePlatform(dir)
    const secrets = createSecretStore(file, platform, config)
    secrets.set('github.token', TOKEN)

    expect(secrets.get('github.token')).toBe(TOKEN)
    expect(secrets.has('github.token')).toBe(true)
    expect(readFileSync(file).includes(TOKEN)).toBe(false)
    expect(createSecretStore(file, platform, config).get('github.token')).toBe(TOKEN)
  })

  it('throws SECRETS_UNAVAILABLE when encryption unavailable and plaintext not allowed', () => {
    const { platform } = fakePlatform(dir, { canEncrypt: () => false })
    const secrets = createSecretStore(file, platform, config)
    expect(() => secrets.set('github.token', TOKEN)).toThrow(/SECRETS_UNAVAILABLE/)
    expect(existsSync(file)).toBe(false)
  })

  it('stores in clear only when the user allowed plaintext secrets', () => {
    const { platform } = fakePlatform(dir, { canEncrypt: () => false })
    config.update({ allowPlaintextSecrets: true })
    const secrets = createSecretStore(file, platform, config)
    secrets.set('github.token', TOKEN)
    expect(secrets.get('github.token')).toBe(TOKEN)
    expect(createSecretStore(file, platform, config).get('github.token')).toBe(TOKEN)
  })

  it('set(key, null) removes the secret, even without encryption', () => {
    const { platform } = fakePlatform(dir)
    createSecretStore(file, platform, config).set('github.token', TOKEN)
    const locked = createSecretStore(file, fakePlatform(dir, { canEncrypt: () => false }).platform, config)
    locked.set('github.token', null)
    expect(locked.has('github.token')).toBe(false)
    expect(createSecretStore(file, platform, config).get('github.token')).toBeNull()
  })

  it('get returns null instead of throwing when decryption is unavailable', () => {
    createSecretStore(file, fakePlatform(dir).platform, config).set('github.token', TOKEN)

    const noKeyring = createSecretStore(file, fakePlatform(dir, { canEncrypt: () => false }).platform, config)
    expect(noKeyring.get('github.token')).toBeNull()
    expect(noKeyring.has('github.token')).toBe(false)

    const broken = fakePlatform(dir, {
      decrypt: () => {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      },
    }).platform
    expect(createSecretStore(file, broken, config).get('github.token')).toBeNull()
  })

  it('a failed write leaves the store unchanged', () => {
    writeFileSync(join(dir, 'blocker'), '')
    const secrets = createSecretStore(join(dir, 'blocker', 'secrets.bin'), fakePlatform(dir).platform, config)
    expect(() => secrets.set('github.token', TOKEN)).toThrow()
    expect(secrets.get('github.token')).toBeNull()
  })

  it('get returns null for a missing key and for an unreadable file', () => {
    const { platform } = fakePlatform(dir)
    expect(createSecretStore(file, platform, config).get('nope')).toBeNull()
    writeFileSync(join(dir, 'garbage.bin'), 'not json')
    const secrets = createSecretStore(join(dir, 'garbage.bin'), platform, config)
    expect(secrets.get('github.token')).toBeNull()
    secrets.set('github.token', TOKEN)
    expect(createSecretStore(join(dir, 'garbage.bin'), platform, config).get('github.token')).toBe(TOKEN)
  })
})
