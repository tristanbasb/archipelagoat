// The licenses of the bundled dependencies, for the About panel. resources/licenses.json is written
// by the packaging script (Task 35), so a development build has none: the import is optional and
// `BUNDLED_LICENSES` is null then.

export interface LicenseEntry {
  name: string
  version: string
  /** SPDX expression, or null when the package declares none. */
  license: string | null
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function licenseOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const names = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    return names.length > 0 ? names.join(' OR ') : null
  }
  return null
}

/** `@scope/name@1.2.3` → name and version (the version follows the last `@`). */
function splitKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf('@')
  return at > 0 ? { name: key.slice(0, at), version: key.slice(at + 1) } : { name: key, version: '' }
}

/**
 * Accepts the two usual shapes: a list of `{ name, version, license }`, or the license-checker map
 * `{ "name@version": { licenses } }`. Entries without a name are dropped; anything else is null.
 */
export function parseLicenses(raw: unknown): LicenseEntry[] | null {
  let entries: LicenseEntry[]
  if (Array.isArray(raw)) {
    entries = raw.filter(isObject).flatMap((item) => {
      if (typeof item.name !== 'string' || !item.name) return []
      const version = typeof item.version === 'string' ? item.version : ''
      return [{ name: item.name, version, license: licenseOf(item.license ?? item.licenses) }]
    })
  } else if (isObject(raw)) {
    entries = Object.entries(raw).map(([key, info]) => ({
      ...splitKey(key),
      license: isObject(info) ? licenseOf(info.licenses ?? info.license) : null,
    }))
  } else {
    return null
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

// No wildcard: the glob matches the one file when it exists, and nothing (no build error) when not.
const files = import.meta.glob<{ default: unknown }>('../../../../../resources/licenses.json', {
  eager: true,
})

export const BUNDLED_LICENSES: LicenseEntry[] | null = parseLicenses(Object.values(files)[0]?.default)
