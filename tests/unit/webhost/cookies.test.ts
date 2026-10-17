import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@main/core/logger'
import { createSecretStore } from '@main/core/secrets'
import { createCookieJar, WEBHOST_COOKIES_SECRET } from '@main/core/webhost/cookies'
import { AppError } from '@shared/errors'
import { createTestContext, type TestCore } from '../../helpers/core'

const SITE = 'https://archipelago.gg'
const FLASK_COOKIE =
  'session=eyJfaWQiOnsiIHUiOiJhYmMifX0.ZxAbCd.signature; Expires=Wed, 18 Nov 2026 12:00:00 GMT; HttpOnly; Path=/'

let root: string
let core: TestCore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat cookies é-'))
  core = createTestContext(join(root, 'core'))
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

describe('createCookieJar', () => {
  it('sends the cookies the site set, for its paths only', () => {
    const jar = createCookieJar(core.ctx.secrets)
    expect(jar.cookieHeader(`${SITE}/uploads`)).toBe('')
    jar.store(`${SITE}/uploads`, [FLASK_COOKIE, 'other=1; Path=/api'])
    expect(jar.cookieHeader(`${SITE}/room/abc`)).toBe('session=eyJfaWQiOnsiIHUiOiJhYmMifX0.ZxAbCd.signature')
    expect(jar.cookieHeader(`${SITE}/api/room_status/abc`)).toContain('other=1')
    expect(jar.cookieHeader('https://example.com/')).toBe('')
  })

  it('keeps the jar encrypted in the webhost.cookies secret, for the next start', () => {
    createCookieJar(core.ctx.secrets).store(`${SITE}/uploads`, [FLASK_COOKIE])
    expect(core.ctx.secrets.has(WEBHOST_COOKIES_SECRET)).toBe(true)
    expect(readFileSync(join(core.platform.paths.userData, 'secrets.bin'), 'utf8')).not.toContain('session=')

    // A new start: a new vault reading the same file, a new jar.
    const secrets = createSecretStore(
      join(core.platform.paths.userData, 'secrets.bin'),
      core.platform,
      core.ctx.config,
    )
    expect(createCookieJar(secrets).cookieHeader(`${SITE}/log/abc`)).toMatch(/^session=eyJ/)
  })

  it('replaces a refreshed cookie and ignores a malformed one', () => {
    const jar = createCookieJar(core.ctx.secrets)
    jar.store(`${SITE}/`, [FLASK_COOKIE])
    jar.store(`${SITE}/room/abc`, ['session=refreshed; Path=/; HttpOnly', '=; ;', 'bad\u0000cookie'])
    expect(jar.cookieHeader(`${SITE}/`)).toBe('session=refreshed')
  })

  it('starts empty when the secret is missing, unreadable or corrupted', () => {
    core.ctx.secrets.set(WEBHOST_COOKIES_SECRET, '{not json')
    expect(createCookieJar(core.ctx.secrets).cookieHeader(`${SITE}/`)).toBe('')
    core.ctx.secrets.set(WEBHOST_COOKIES_SECRET, JSON.stringify({ cookies: 'nope' }))
    expect(createCookieJar(core.ctx.secrets).cookieHeader(`${SITE}/`)).toBe('')
  })

  it('keeps working in memory when the vault cannot save it', () => {
    const warn = vi.fn()
    const log: Logger = { debug() {}, info() {}, warn, error() {} }
    const secrets = {
      get: () => null,
      has: () => false,
      set: () => {
        throw new AppError('SECRETS_UNAVAILABLE')
      },
    }
    const jar = createCookieJar(secrets, log)
    expect(() => jar.store(`${SITE}/new_room/abc`, [FLASK_COOKIE])).not.toThrow()
    expect(jar.cookieHeader(`${SITE}/room/abc`)).toMatch(/^session=eyJ/)
    expect(warn).toHaveBeenCalledOnce()
    // The warning says why, never what the cookie holds.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('eyJ')
  })
})
