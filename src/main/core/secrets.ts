// Secret vault (userData/secrets.bin): values encrypted with safeStorage, or kept in clear only when
// the user explicitly allowed it (Linux without a keyring). Spec §6.3.
import { AppError } from '@shared/errors'
import type { ConfigStore } from './config'
import type { Platform } from './context'
import { readJsonSync, writeJsonAtomicSync } from './json-file'

export interface SecretStore {
  /** null when absent, and when it cannot be decrypted: a missing keyring never blocks startup. */
  get(key: string): string | null
  /** Throws SECRETS_UNAVAILABLE when it cannot encrypt and plaintext secrets are not allowed. */
  set(key: string, value: string | null): void
  /** True when `get` would return a value. */
  has(key: string): boolean
}

type Entry = { enc: 'safeStorage'; data: string } | { enc: 'plain'; value: string }

function isEntry(x: unknown): x is Entry {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  return (
    (e.enc === 'safeStorage' && typeof e.data === 'string') ||
    (e.enc === 'plain' && typeof e.value === 'string')
  )
}

function readEntries(file: string): Map<string, Entry> {
  const raw = readJsonSync(file) as { entries?: unknown } | undefined
  const entries = raw?.entries
  if (typeof entries !== 'object' || entries === null) return new Map()
  return new Map(Object.entries(entries).filter((pair): pair is [string, Entry] => isEntry(pair[1])))
}

export function createSecretStore(
  file: string,
  platform: Pick<Platform, 'canEncrypt' | 'encrypt' | 'decrypt'>,
  config: Pick<ConfigStore, 'get'>,
): SecretStore {
  let entries: Map<string, Entry> | null = null
  const all = (): Map<string, Entry> => (entries ??= readEntries(file))
  /** Writes first, so a failed write leaves the store as it was. */
  const save = (next: Map<string, Entry>): void => {
    writeJsonAtomicSync(file, { version: 1, entries: Object.fromEntries(next) })
    entries = next
  }

  const get = (key: string): string | null => {
    const entry = all().get(key)
    if (!entry) return null
    if (entry.enc === 'plain') return entry.value
    if (!platform.canEncrypt()) return null
    try {
      return platform.decrypt(Buffer.from(entry.data, 'base64'))
    } catch {
      return null
    }
  }

  return {
    get,
    has: (key) => get(key) !== null,
    set(key, value) {
      const next = new Map(all())
      if (value === null) {
        if (next.delete(key)) save(next)
        return
      }
      if (platform.canEncrypt()) {
        next.set(key, { enc: 'safeStorage', data: platform.encrypt(value).toString('base64') })
      } else if (config.get().allowPlaintextSecrets) {
        next.set(key, { enc: 'plain', value })
      } else {
        throw new AppError('SECRETS_UNAVAILABLE')
      }
      save(next)
    },
  }
}
