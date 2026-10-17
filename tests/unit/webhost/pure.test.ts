import { normalizeWebUrl, parseUserMessage, type RoomStatus } from '@main/core/webhost/client'
import { toWebRoom } from '@main/core/webhost/rooms'

const page = (main: string): string =>
  `<!DOCTYPE html>\n<html lang="en">\n<head><title>Upload Multidata</title></head>\n<body><main>${main}<h1>Upload</h1></main></body></html>`

describe('parseUserMessage', () => {
  it('reads the flash message of an upload page, entities decoded', () => {
    const html = page(
      '<div>\n  <div class="user-message">Error: Unexpected file found in .zip: a&amp;b &#39;c&#39; &lt;d&gt; &#34;e&#34; &#x41;</div>\n</div>',
    )
    expect(parseUserMessage(html)).toBe(`Error: Unexpected file found in .zip: a&b 'c' <d> "e" A`)
  })

  it('drops the markup of a Markup message and joins several messages', () => {
    const html = page(
      '<div class="user-message">Error: Your .zip file only contains options files. ' +
        'Did you mean to <a href="/generate">generate a game</a>?</div>' +
        '<div class="user-message notice">Second\n   line</div>',
    )
    expect(parseUserMessage(html)).toBe(
      'Error: Your .zip file only contains options files. Did you mean to generate a game?\nSecond line',
    )
  })

  it('is null without a message, or with an empty one', () => {
    expect(parseUserMessage(page('<p>Nothing to report</p>'))).toBeNull()
    expect(parseUserMessage(page('<div class="user-message">  </div>'))).toBeNull()
    expect(parseUserMessage('')).toBeNull()
  })
})

describe('normalizeWebUrl', () => {
  it('resolves relative paths against the site', () => {
    expect(normalizeWebUrl('https://archipelago.gg', '/room/abc')).toBe('https://archipelago.gg/room/abc')
    expect(normalizeWebUrl('https://archipelago.gg/', 'seed/abc')).toBe('https://archipelago.gg/seed/abc')
    expect(normalizeWebUrl('http://127.0.0.1:5000', '/dl_patch/r/1')).toBe(
      'http://127.0.0.1:5000/dl_patch/r/1',
    )
  })

  it('upgrades http to https only for the host of an https site', () => {
    expect(normalizeWebUrl('https://archipelago.gg', 'http://archipelago.gg/room/abc')).toBe(
      'https://archipelago.gg/room/abc',
    )
    expect(normalizeWebUrl('https://archipelago.gg', 'http://example.com/x')).toBe('http://example.com/x')
    // The local fake site is plain http: its own URLs stay as they are.
    expect(normalizeWebUrl('http://127.0.0.1:5000', 'http://127.0.0.1:5000/room/abc')).toBe(
      'http://127.0.0.1:5000/room/abc',
    )
  })
})

describe('toWebRoom', () => {
  const status: RoomStatus = {
    tracker: 'TRACKER_suuid_000000000',
    players: [
      { name: 'Alice', game: 'A Link to the Past' },
      { name: 'Bob', game: 'TUNIC' },
    ],
    lastPort: 38281,
    lastActivity: 'Sat, 17 Oct 2026 12:00:00 GMT',
    timeoutS: 7200,
    downloads: [
      { slot: 1, download: '/dl_patch/ROOM/1' },
      { slot: 2, download: 'http://archipelago.gg/slot_file/ROOM/2' },
    ],
  }

  it('builds what the live screen shows, with absolute https links', () => {
    expect(toWebRoom('ROOM', 'SEED', status, 'https://archipelago.gg')).toEqual({
      roomId: 'ROOM',
      seedId: 'SEED',
      roomUrl: 'https://archipelago.gg/room/ROOM',
      host: 'archipelago.gg',
      port: 38281,
      lastActivity: '2026-10-17T12:00:00.000Z',
      timeoutS: 7200,
      players: status.players,
      downloads: [
        { slot: 1, url: 'https://archipelago.gg/dl_patch/ROOM/1' },
        { slot: 2, url: 'https://archipelago.gg/slot_file/ROOM/2' },
      ],
      trackerUrl: 'https://archipelago.gg/tracker/TRACKER_suuid_000000000',
    })
  })

  it('has no port before the first start nor after an error, and keeps the local host', () => {
    const local = 'http://127.0.0.1:5000'
    const never = toWebRoom('ROOM', 'SEED', { ...status, lastPort: 0, tracker: null }, local)
    expect(never).toMatchObject({ port: null, host: '127.0.0.1', trackerUrl: null })
    expect(never.roomUrl).toBe('http://127.0.0.1:5000/room/ROOM')
    expect(toWebRoom('ROOM', 'SEED', { ...status, lastPort: -1 }, local).port).toBeNull()
  })

  it('keeps an activity date it cannot read as null', () => {
    expect(
      toWebRoom('R', 'S', { ...status, lastActivity: 'soon' }, 'https://archipelago.gg').lastActivity,
    ).toBeNull()
    expect(
      toWebRoom('R', 'S', { ...status, lastActivity: null }, 'https://archipelago.gg').lastActivity,
    ).toBeNull()
  })
})
