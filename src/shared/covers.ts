// Game covers (spec §3.1): the only places a cover is downloaded from, and how the app shows it.

/** The hosts a cover may be downloaded from. Never extended, never configurable (spec §6). */
export const COVER_HOSTS = ['static.wikitide.net', 'upload.wikimedia.org'] as const

/** The scheme the main process serves the cached covers under: `goat-cover://<file name>`. */
export const COVER_SCHEME = 'goat-cover'

/** https, no port nor credentials, and exactly one of COVER_HOSTS (not a subdomain, not a look-alike). */
export function isCoverUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    (COVER_HOSTS as readonly string[]).includes(parsed.hostname)
  )
}
