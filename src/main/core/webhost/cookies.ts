// The cookie jar of archipelago.gg (spec §3.14). Its `session` cookie is the app's identity on the
// site: it owns the seeds and rooms the app uploads, and losing it loses owner access (the console and
// the log). The jar lives in the vault (`webhost.cookies`, encrypted like every secret, spec §6.3) and
// is saved after every answer that sets a cookie: the site refreshes it on each answer.
import { CookieJar } from 'tough-cookie'
import type { Logger } from '../logger'
import type { SecretStore } from '../secrets'

export const WEBHOST_COOKIES_SECRET = 'webhost.cookies'

export interface CookieJarStore {
  /** The `Cookie` header of a request to `url`; '' when there is no cookie for it. */
  cookieHeader(url: string): string
  /**
   * Keeps the `Set-Cookie` headers of the answer from `url` (malformed ones are ignored), then saves
   * the jar. Never throws: an answer that came back is never failed by its cookies.
   */
  store(url: string, setCookies: readonly string[]): void
}

/** The saved jar, or an empty one when there is none or it cannot be read. */
function load(secrets: Pick<SecretStore, 'get'>): CookieJar {
  const saved = secrets.get(WEBHOST_COOKIES_SECRET)
  if (saved !== null) {
    try {
      return CookieJar.deserializeSync(saved)
    } catch {
      // Corrupted: start a new identity rather than block hosting.
    }
  }
  return new CookieJar()
}

export function createCookieJar(secrets: Pick<SecretStore, 'get' | 'set'>, log?: Logger): CookieJarStore {
  let jar: CookieJar | null = null
  const current = (): CookieJar => (jar ??= load(secrets))
  let warned = false

  const save = (): void => {
    try {
      secrets.set(WEBHOST_COOKIES_SECRET, JSON.stringify(current().serializeSync()))
    } catch (error) {
      // No keyring (SECRETS_UNAVAILABLE) or a failed write: the identity still works until the app
      // quits. Said once, without the cookie.
      if (!warned) log?.warn('webhost: the archipelago.gg identity cannot be saved', (error as Error).message)
      warned = true
    }
  }

  return {
    cookieHeader: (url) => current().getCookieStringSync(url),

    store(url, setCookies) {
      if (setCookies.length === 0) return
      for (const header of setCookies) current().setCookieSync(header, url, { ignoreError: true })
      save()
    },
  }
}
