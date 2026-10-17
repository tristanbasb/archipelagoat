// A fake archipelago.gg (spec §7.2) on 127.0.0.1, for the webhost client, the integration runs and
// the E2E runs (GOAT_WEBHOST_URL). It reproduces what the client relies on and the traps of the real
// site (research brief §1.8): a Flask-like `session` cookie refreshed on every answer and owning what
// it uploads, `/uploads` and `/new_room` answering 302 with relative locations, upload errors as a 200
// HTML page holding `<div class="user-message">`, a `last_port` at 0 until the room has started,
// `/log` with `Range: bytes=N-` (206, no Content-Range), owner-only routes, and 404s in HTML.
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockWebhostOptions {
  /** How many `/api/room_status` answers of a new room say `last_port: 0` before it gets a port. */
  portDelayPolls?: number
  /** Every upload fails with this flash message (a 200 HTML page, as the real site does). */
  failUpload?: string
}

export interface MockSeed {
  id: string
  owner: string
  fileName: string
  size: number
}

export interface MockRoom {
  id: string
  seedId: string
  owner: string
  tracker: string
  createdAt: Date
  lastActivity: Date
  /** 0 until the room has started, -1 when it failed. */
  port: number
  statusPolls: number
  /** GET /room visits (each one wakes the room). */
  visits: number
  /** Commands posted by the owner, in order. */
  commands: string[]
  /** The room's log file; '' means it does not exist yet. */
  log: string
}

export interface MockRequest {
  method: string
  /** Path and query, as received. */
  url: string
  headers: IncomingHttpHeaders
}

export interface MockWebhostState {
  seeds: Map<string, MockSeed>
  rooms: Map<string, MockRoom>
  requests: MockRequest[]
  /** GET /new_room calls, whatever their outcome. */
  newRoomCalls: number
  /** The `last_port` a room gets once started: -1 makes every new room fail. */
  assignPort: number
  /** The players of every seed, as `[name, game]` (`/api/room_status` `players`). */
  players: [string, string][]
  /**
   * The file of each slot, by slot number, served at `/dl_patch/<room>/<slot>` as it was set: the real
   * site also rewrites the manifest's `server` with its address and the room's port.
   */
  slotFiles: Map<number, Buffer>
}

export interface MockWebhost {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  url: string
  state: MockWebhostState
  close(): Promise<void>
}

const SESSION_RE = /^([0-9a-f]{32})\.\d+$/
const UUID4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SUUID = '([A-Za-z0-9_-]{22})'
const COOKIE_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000
const ROOM_TIMEOUT_S = 7200

/** An suuid: the URL-safe base64 of 16 UUID bytes, padding stripped (22 characters). */
const suuid = (): string => randomBytes(16).toString('base64url')

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;')

function page(title: string, body: string, messages: string[] = []): string {
  const flashed = messages.length
    ? `<div>${messages.map((m) => `<div class="user-message">${escapeHtml(m)}</div>`).join('')}</div>`
    : ''
  return `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><title>${title}</title></head>\n<body><main>${flashed}${body}</main></body>\n</html>\n`
}

const NOT_FOUND_PAGE =
  '<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server.</p>\n'

/** One request being answered: who asks (the identity of its cookie, possibly replaced) and how to reply. */
interface Call {
  req: IncomingMessage
  url: URL
  body: Buffer
  identity: string
  reply(status: number, body: string | Buffer, headers?: Record<string, string>): void
}

export async function startMockWebhost(opts: MockWebhostOptions = {}): Promise<MockWebhost> {
  const portDelayPolls = opts.portDelayPolls ?? 0
  const state: MockWebhostState = {
    seeds: new Map(),
    rooms: new Map(),
    requests: [],
    newRoomCalls: 0,
    assignPort: 50123,
    players: [
      ['Alice', 'A Link to the Past'],
      ['Bob', 'TUNIC'],
    ],
    slotFiles: new Map(),
  }
  let refreshes = 0
  let origin = ''

  /** The identity of the request's cookie, or a new one (as Flask does for a missing or bad cookie). */
  function identityOf(req: IncomingMessage): string {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [name, value = ''] = part.trim().split('=')
      const hex = name === 'session' ? SESSION_RE.exec(value)?.[1] : undefined
      if (hex) {
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      }
    }
    return randomUUID()
  }

  const html = (call: Call, status: number, text: string): void =>
    call.reply(status, text, { 'content-type': 'text/html; charset=utf-8' })
  const json = (call: Call, value: unknown, headers: Record<string, string> = {}): void =>
    call.reply(200, JSON.stringify(value), { 'content-type': 'application/json', ...headers })
  const redirect = (call: Call, location: string): void =>
    call.reply(302, `<p>Redirecting to <a href="${location}">${location}</a>.</p>`, {
      'content-type': 'text/html; charset=utf-8',
      location,
    })
  const notFound = (call: Call): void => html(call, 404, NOT_FOUND_PAGE)

  async function upload(call: Call): Promise<void> {
    const fail = (message: string): void =>
      html(call, 200, page('Upload Multidata', '<h1>Upload</h1>', [message]))
    if (opts.failUpload !== undefined) return fail(opts.failUpload)
    const contentType = call.req.headers['content-type'] ?? ''
    const form = contentType.startsWith('multipart/form-data')
      ? await new Response(new Uint8Array(call.body), { headers: { 'content-type': contentType } })
          .formData()
          .catch(() => null)
      : null
    const file = form?.get('file')
    if (!(file instanceof File)) return fail('No file part in POST request.')
    if (file.name === '') return fail('No selected file.')
    if (!/\.(zip|archipelago)$/.test(file.name)) {
      return fail('Not recognized file format. Awaiting a .archipelago file or .zip containing one.')
    }
    const seed: MockSeed = { id: suuid(), owner: call.identity, fileName: file.name, size: file.size }
    state.seeds.set(seed.id, seed)
    redirect(call, `/seed/${seed.id}`)
  }

  function newRoom(call: Call, seedId: string): void {
    state.newRoomCalls += 1
    if (!state.seeds.has(seedId)) return notFound(call)
    const now = new Date()
    const room: MockRoom = {
      id: suuid(),
      seedId,
      owner: call.identity,
      tracker: suuid(),
      createdAt: now,
      lastActivity: now,
      port: 0,
      statusPolls: 0,
      visits: 0,
      commands: [],
      log: '',
    }
    state.rooms.set(room.id, room)
    redirect(call, `/room/${room.id}`)
  }

  function viewRoom(call: Call, room: MockRoom): void {
    room.visits += 1
    room.lastActivity = new Date()
    const connect = room.port > 0 ? `<p>/connect ${call.url.hostname}:${room.port}</p>` : '<p>Starting…</p>'
    html(call, 200, page('Room', `<h1>Room</h1>${connect}`))
  }

  function roomCommand(call: Call, room: MockRoom): void {
    // Non-owners are silently ignored, as on the real site.
    const cmd = new URLSearchParams(call.body.toString('utf8')).get('cmd')
    if (room.owner === call.identity && cmd) room.commands.push(cmd)
    redirect(call, `/room/${room.id}`)
  }

  function roomStatus(call: Call, room: MockRoom): void {
    room.statusPolls += 1
    if (room.port === 0 && room.statusPolls > portDelayPolls) {
      room.port = state.assignPort
      if (room.port > 0) room.log += `Hosting game at ${call.url.hostname}:${room.port} (No password)\n`
    }
    json(
      call,
      {
        tracker: room.tracker,
        players: state.players,
        last_port: room.port,
        last_activity: room.lastActivity.toUTCString(),
        timeout: ROOM_TIMEOUT_S,
        downloads: state.players.map((_, index) => ({
          slot: index + 1,
          download: `/dl_patch/${room.id}/${index + 1}`,
        })),
      },
      { 'access-control-allow-origin': '*' },
    )
  }

  /** A slot's file; a slot without one gets a 200 text, as on the real site, not a 404. */
  function downloadPatch(call: Call, room: MockRoom, slot: number): void {
    const file = state.slotFiles.get(slot)
    if (!file) return call.reply(200, 'Patch not found', { 'content-type': 'text/html; charset=utf-8' })
    call.reply(200, file, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename=P${slot}_${room.id}`,
    })
  }

  function readLog(call: Call, room: MockRoom): void {
    if (room.owner !== call.identity) return html(call, 403, 'Access Denied')
    if (room.log === '') {
      return call.reply(
        200,
        `Logfile logs/${room.id}.txt does not exist. Likely a crash during spinup of multiworld instance or it is still spinning up.`,
        { 'content-type': 'text/plain; charset=utf-8' },
      )
    }
    const bytes = Buffer.from(room.log, 'utf8')
    const range = call.req.headers.range
    if (range === undefined) return call.reply(200, bytes, { 'content-type': 'text/plain; charset=utf-8' })
    const match = /^bytes=(\d+)-$/.exec(range.replace(/\s/g, ''))
    if (!match) return call.reply(500, 'Unsupported range', { 'content-type': 'text/html; charset=utf-8' })
    call.reply(206, bytes.subarray(Number(match[1])), { 'content-type': 'text/plain; charset=utf-8' })
  }

  function sessionPage(call: Call, oldId?: string): void {
    const old = oldId === undefined ? '' : `<p>Your old code was:</p><code>${oldId}</code><br>`
    const link = `/session/${call.identity}`
    html(
      call,
      200,
      page(
        'Session',
        `<div class="markdown">${old}<p>The following code is your unique identifier.</p><code>${call.identity}</code><br>` +
          `<p><a href="${link}">${origin}${link}</a></p></div>`,
      ),
    )
  }

  function myRooms(call: Call): void {
    json(
      call,
      [...state.rooms.values()]
        .filter((room) => room.owner === call.identity)
        .map((room) => ({
          room_id: room.id,
          seed_id: room.seedId,
          creation_time: room.createdAt.toUTCString(),
          last_activity: room.lastActivity.toUTCString(),
          last_port: room.port,
          timeout: ROOM_TIMEOUT_S,
          tracker: room.tracker,
        })),
    )
  }

  async function route(call: Call): Promise<void> {
    const { pathname } = call.url
    const method = call.req.method ?? 'GET'
    const match = (re: string): string | undefined => new RegExp(`^${re}$`).exec(pathname)?.[1]
    const roomOf = (id: string | undefined): MockRoom | undefined => (id ? state.rooms.get(id) : undefined)

    if (pathname === '/uploads' && method === 'POST') return upload(call)
    const seedId = match(`/new_room/${SUUID}`)
    if (seedId !== undefined && method === 'GET') return newRoom(call, seedId)
    const viewed = match(`/seed/${SUUID}`)
    if (viewed !== undefined && method === 'GET') {
      return state.seeds.has(viewed) ? html(call, 200, page('Seed', '<h1>Seed</h1>')) : notFound(call)
    }
    const roomId = match(`/room/${SUUID}`)
    if (roomId !== undefined) {
      const room = roomOf(roomId)
      if (!room) return notFound(call)
      if (method === 'POST') return roomCommand(call, room)
      if (method === 'GET') return viewRoom(call, room)
    }
    const statusId = match(`/api/room_status/${SUUID}`)
    if (statusId !== undefined && method === 'GET') {
      const room = roomOf(statusId)
      return room ? roomStatus(call, room) : notFound(call)
    }
    const download = new RegExp(`^/dl_patch/${SUUID}/(\\d+)$`).exec(pathname)
    if (download && method === 'GET') {
      const room = roomOf(download[1])
      return room ? downloadPatch(call, room, Number(download[2])) : notFound(call)
    }
    const logId = match(`/log/${SUUID}`)
    if (logId !== undefined && method === 'GET') {
      const room = roomOf(logId)
      return room ? readLog(call, room) : notFound(call)
    }
    if (pathname === '/api/get_rooms' && method === 'GET') return myRooms(call)
    if (pathname === '/session' && method === 'GET') return sessionPage(call)
    const newId = match('/session/([^/]+)')
    if (newId !== undefined && method === 'GET') {
      if (!UUID4_RE.test(newId)) return html(call, 500, 'Internal Server Error')
      const oldId = call.identity
      call.identity = newId.toLowerCase()
      return sessionPage(call, oldId)
    }
    notFound(call)
  }

  const server = createServer((req, res: ServerResponse) => {
    state.requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers })
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const call: Call = {
        req,
        url: new URL(req.url ?? '/', origin),
        body: Buffer.concat(chunks),
        identity: identityOf(req),
        reply(status, body, headers = {}) {
          // Flask refreshes the permanent session cookie on every answer: its value changes each time.
          refreshes += 1
          const value = `${call.identity.replace(/-/g, '')}.${refreshes}`
          const expires = new Date(Date.now() + COOKIE_LIFETIME_MS).toUTCString()
          res.writeHead(status, {
            'content-length': Buffer.byteLength(body),
            'set-cookie': `session=${value}; Expires=${expires}; HttpOnly; Path=/`,
            ...headers,
          })
          res.end(body)
        },
      }
      route(call).catch(() => {
        if (!res.headersSent) call.reply(500, 'Internal Server Error')
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url: origin,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
