// Secret vault (userData/secrets.bin): values encrypted with safeStorage, or kept in clear only when
// the user explicitly allowed it (Linux without a keyring). Spec §6.3. A secret kept in clear never
// stays so for longer than needed: it is encrypted as soon as a keyring is there, and dropped when the
// user withdraws the permission (the store is read, then `migrate` runs on every config change).
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
  /**
   * The secrets kept in clear: encrypted when the keyring allows it, deleted when it does not and
   * plaintext secrets are no longer allowed. Runs when the store is first read; call it again when
   * the config changes. Never throws.
   */
  migrate(): void
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
  /** Writes first, so a failed write leaves the store as it was. */
  const save = (next: Map<string, Entry>): void => {
    writeJsonAtomicSync(file, { version: 1, entries: Object.fromEntries(next) })
    entries = next
  }

  /** `current` with its plaintext entries encrypted or dropped; null when nothing changes. */
  function migrated(current: Map<string, Entry>): Map<string, Entry> | null {
    const plain = [...current].filter((pair): pair is [string, Extract<Entry, { enc: 'plain' }>] => {
      return pair[1].enc === 'plain'
    })
    if (plain.length === 0) return null
    const next = new Map(current)
    if (platform.canEncrypt()) {
      for (const [key, { value }] of plain) {
        next.set(key, { enc: 'safeStorage', data: platform.encrypt(value).toString('base64') })
      }
    } else if (!config.get().allowPlaintextSecrets) {
      for (const [key] of plain) next.delete(key)
    } else {
      return null
    }
    return next
  }

  function migrateEntries(current: Map<string, Entry>): void {
    try {
      const next = migrated(current)
      if (next) save(next)
    } catch {
      // Left as it is (a full disk, a keyring that fails): tried again on the next config change.
    }
  }

  const all = (): Map<string, Entry> => {
    if (entries === null) {
      entries = readEntries(file)
      migrateEntries(entries)
    }
    return entries
  }

  const get = (key: string): string | null => {
    const entry = all().get(key)
    if (!entry) return null
    // Kept in clear only while that is allowed (or until it is encrypted).
    if (entry.enc === 'plain') {
      return config.get().allowPlaintextSecrets || platform.canEncrypt() ? entry.value : null
    }
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
    migrate: () => migrateEntries(all()),
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
