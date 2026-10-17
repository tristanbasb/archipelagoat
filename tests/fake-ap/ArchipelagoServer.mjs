// Fake ArchipelagoServer (tests only). Prints the captured startup of a real server up to
// `Hosting game at` (logged before the bind, like MultiServer.py:2852), then 300 ms later really
// listens on --port, on 127.0.0.1 only (no firewall prompt), and prints `server listening on`.
//
// Like ArchipelagoServer 0.6.8, a frozen build that ignores PYTHONUNBUFFERED: what its console prints
// (the answers to /players, /save…) stays in the stdout buffer until the next log line, which flushes
// it (docs/verification/2026-10-16-real-run.md). Log lines go out at once.
//
// It speaks enough of Archipelago's WebSocket protocol for the app's own connections: RoomInfo on
// connect, Connect for the slots Alice and Bob (the game password of the session's host.yaml),
// websockets' `connection open` / `connection closed` lines, the join and leave notices of a client
// that logged in, and PrintJSON ItemSend packets with their item flags.
//
// Console on stdin like MultiServer: /players answers who is connected, /save writes the save file,
// /exit writes it then exits 0, any other text is said to everyone as `[Server]`, and EOF is ignored
// (MultiServer's console thread spins forever). `/fake_items` (tests only) has the players find five
// items, one of each class, each logged then broadcast like MultiServer.py:1229-1251.
//
// FAKE_MODE: port-busy (OSError then exit 1, as when --port is taken), ignore-exit (/exit does
// nothing), buffered (all output held until /save or the exit), no-websocket (WebSocket upgrades are
// dropped).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { parse } from 'yaml'
import { argValue, argv, err, exit, fixtureLines, flush, modes, out, record, sleep } from './common.mjs'

const port = Number(argValue('--port') ?? 38281)
// AP saves next to the multidata, output/AP_<seed>.zip → output/AP_<seed>.apsave: MultiServer 0.6.8
// parses --savefile but never reads it (MultiServer.py:694-701, 2708), as the real run showed.
const multidata = argv.find((arg) => /\.(?:zip|archipelago)$/i.test(arg))
const savefile = multidata?.replace(/\.[^.\\/]+$/, '.apsave')
const VERSION = { major: 0, minor: 6, build: 8, class: 'Version' }
// The players of the fake generation (ArchipelagoGenerate.mjs), slots 1 and 2 of team 1.
const SLOTS = [
  { name: 'Alice', game: 'Pokemon Emerald' },
  { name: 'Bob', game: 'A Hat in Time' },
]
// What `/fake_items` sends: [finder, receiver, item, location, flags] (flags: 1 progression, 2 useful, 4 trap).
const FAKE_ITEMS = [
  ['Alice', 'Bob', 'Umbrella', 'Route 104 - Hidden Item', 0b001],
  ['Bob', 'Alice', 'Rare Candy', 'Mafia Town - Umbrella Chest', 0b010],
  ['Alice', 'Bob', 'Baby Trap', 'Petalburg Woods - Item', 0b100],
  ['Bob', 'Bob', '10 Pons', 'Mafia Town - Pons Box', 0],
  ['Bob', 'Alice', 'Stone Badge', 'Mafia Boss Shop', 0b011],
]

/** The game password of the session, from the host.yaml of its folder (the cwd); null when none. */
function gamePassword() {
  try {
    const password = parse(readFileSync('host.yaml', 'utf8'))?.server_options?.password
    return typeof password === 'string' && password !== '' ? password : null
  } catch {
    return null
  }
}

const password = gamePassword()

// --- stdout like a frozen Python's ---------------------------------------------------------------

const printed = []

/** What a command prints: held until the next log line. */
function print(line) {
  printed.push(line)
}

/** A log line: it goes out at once, after what was printed before it. */
function log(line) {
  for (const text of printed.splice(0)) out(text)
  out(line)
}

/** Python flushes stdout at a normal exit. */
function quit(code) {
  for (const text of printed.splice(0)) out(text)
  exit(code)
}

function save() {
  if (savefile) writeFileSync(savefile, JSON.stringify({ fake: 'apsave', savedAt: new Date().toISOString() }))
}

function portInUse() {
  const [errno, reason] =
    process.platform === 'win32'
      ? [10048, 'only one usage of each socket address (protocol/network address/port) is normally permitted']
      : [98, 'address already in use']
  err('Traceback (most recent call last):')
  err('  File "MultiServer.py", line 2889, in <module>')
  err('  File "MultiServer.py", line 2855, in main')
  err(`OSError: [Errno ${errno}] error while attempting to bind on address ('0.0.0.0', ${port}): ${reason}`)
  exit(1)
}

// --- WebSocket (RFC 6455), server side ------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) header = Buffer.from([0x80 | opcode, length])
  else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header.writeUInt16BE(length, 2)
    header[1] = 126
  } else {
    header = Buffer.alloc(10)
    header.writeBigUInt64BE(BigInt(length), 2)
    header[1] = 127
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** The complete frames at the start of `buffer`, and what is left of it. */
function readFrames(buffer) {
  const frames = []
  let rest = buffer
  for (;;) {
    if (rest.length < 2) break
    const masked = (rest[1] & 0x80) !== 0
    let length = rest[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (rest.length < 4) break
      length = rest.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (rest.length < 10) break
      length = Number(rest.readBigUInt64BE(2))
      offset = 10
    }
    const start = offset + (masked ? 4 : 0)
    if (rest.length < start + length) break
    const payload = Buffer.from(rest.subarray(start, start + length))
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= rest[offset + (i % 4)]
    frames.push({ fin: (rest[0] & 0x80) !== 0, opcode: rest[0] & 0x0f, payload })
    rest = rest.subarray(start + length)
  }
  return { frames, rest }
}

// --- Archipelago's protocol -----------------------------------------------------------------------

/** The clients that logged in. */
const clients = new Set()

/** A Python list of strings, as MultiServer prints the tags of a client: `['Tracker', 'AP']`. */
const pythonList = (items) => `[${items.map((item) => `'${item}'`).join(', ')}]`

const VERBS = { HintGame: 'hinting', Tracker: 'tracking', TextOnly: 'viewing' }
const verbOf = (tags) => Object.entries(VERBS).find(([tag]) => tags.includes(tag))?.[1] ?? null

function broadcast(packets) {
  for (const client of clients) client.send(packets)
}

/** `Notice (all): …`, logged then sent to every client (MultiServer.py:475-477). */
function noticeAll(text) {
  log(`Notice (all): ${text}`)
  broadcast([{ cmd: 'PrintJSON', data: [{ text }] }])
}

function slotInfo() {
  return Object.fromEntries(
    SLOTS.map((slot, index) => [
      String(index + 1),
      { name: slot.name, game: slot.game, type: 1, group_members: [], class: 'NetworkSlot' },
    ]),
  )
}

function accept(socket) {
  let buffer = Buffer.alloc(0)
  let message = []
  let closing = false
  const client = {
    name: null,
    tags: [],
    send(packets) {
      if (!socket.destroyed) socket.write(frame(1, Buffer.from(JSON.stringify(packets))))
    },
  }

  const close = () => {
    if (closing) return
    closing = true
    socket.end(frame(8, Buffer.from([0x03, 0xe8])))
  }

  function onConnect(args) {
    const errors = []
    if (password !== null && args.password !== password) errors.push('InvalidPassword')
    const slot = SLOTS.findIndex((candidate) => candidate.name === args.name)
    if (slot < 0) errors.push('InvalidSlot')
    if (errors.length > 0) {
      log(`A client connection was refused due to: {${errors.map((e) => `'${e}'`).join(', ')}}.`)
      client.send([{ cmd: 'ConnectionRefused', errors }])
      return
    }
    client.name = args.name
    client.tags = Array.isArray(args.tags) ? args.tags.map(String) : []
    clients.add(client)
    client.send([
      {
        cmd: 'Connected',
        team: 0,
        slot: slot + 1,
        players: SLOTS.map((s, i) => ({
          team: 0,
          slot: i + 1,
          alias: s.name,
          name: s.name,
          class: 'NetworkPlayer',
        })),
        missing_locations: [],
        checked_locations: [],
        slot_info: slotInfo(),
        hint_points: 0,
      },
    ])
    const { major, minor, build } = args.version ?? VERSION
    const verb = verbOf(client.tags) ?? 'playing'
    noticeAll(
      `${client.name} (Team #1) ${verb} ${SLOTS[slot].game} has joined. Client(${major}.${minor}.${build}), ${pythonList(client.tags)}.`,
    )
    log(
      `Notice (Player ${client.name} in team 1): Now that you are connected, you can use !help to list commands to run via the server. If your client supports it, you may have additional local commands you can list with /help.`,
    )
    client.version = `${major}.${minor}.${build}`
  }

  function onMessage(text) {
    let packets
    try {
      packets = JSON.parse(text)
    } catch {
      return
    }
    for (const packet of Array.isArray(packets) ? packets : []) {
      if (packet?.cmd === 'Connect') onConnect(packet)
    }
  }

  socket.on('data', (chunk) => {
    const read = readFrames(Buffer.concat([buffer, chunk]))
    buffer = read.rest
    for (const { fin, opcode, payload } of read.frames) {
      if (opcode === 8) close()
      else if (opcode === 9) socket.write(frame(10, payload))
      else if (opcode === 1 || opcode === 0) {
        message.push(payload)
        if (fin) {
          onMessage(Buffer.concat(message).toString('utf8'))
          message = []
        }
      }
    }
  })
  socket.on('error', () => undefined)
  socket.on('close', () => {
    if (clients.delete(client)) {
      const verb = verbOf(client.tags)
      noticeAll(
        `${client.name} (Team #1) has ${verb ? `stopped ${verb}` : 'left'} the game. Client(${client.version}), ${pythonList(client.tags)}.`,
      )
    }
    log('connection closed')
  })

  log('connection open')
  client.send([
    {
      cmd: 'RoomInfo',
      password: password !== null,
      games: SLOTS.map((slot) => slot.game),
      tags: [],
      version: VERSION,
      generator_version: VERSION,
      permissions: { release: 2, remaining: 1, collect: 2 },
      hint_cost: 10,
      location_check_points: 1,
      datapackage_checksums: {},
      seed_name: 'fake',
      time: Date.now() / 1000,
    },
  ])
}

function onUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (modes.has('no-websocket') || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.destroy()
    return
  }
  const acceptKey = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
  )
  accept(socket)
}

/** The sends of `/fake_items`: each one logged, then broadcast on the next turn of the loop. */
function fakeItems() {
  const ids = new Map(SLOTS.map((slot, index) => [slot.name, index + 1]))
  for (const [finder, receiver, item, location, flags] of FAKE_ITEMS) {
    log(`(Team #1) ${finder} sent ${item} to ${receiver} (${location})`)
    const player = ids.get(finder)
    const receiving = ids.get(receiver)
    setImmediate(() =>
      broadcast([
        {
          cmd: 'PrintJSON',
          type: 'ItemSend',
          receiving,
          item: { item: 1000 + flags, location: 2000 + player, player, flags, class: 'NetworkItem' },
          data: [{ text: String(player), type: 'player_id' }, { text: ' sent ' }],
        },
      ]),
    )
  }
}

function playersLine() {
  const names = SLOTS.map((slot) =>
    [...clients].some((client) => client.name === slot.name) ? slot.name : `(${slot.name})`,
  )
  return `${clients.size} players of ${SLOTS.length} connected :: Team #1: ${names.join(' ')}`
}

// --- main -----------------------------------------------------------------------------------------

record()
const startup = fixtureLines('server-startup.txt')
const hosting = startup.findIndex((line) => line.startsWith('Hosting game at '))
for (const line of startup.slice(0, hosting + 1))
  log(line.replace(/^(Hosting game at .*):\d+ \(/, `$1:${port} (`))

await sleep(300)
if (modes.has('port-busy')) portInUse()

const server = createServer((_req, res) => {
  res.writeHead(426).end()
})
server.on('upgrade', onUpgrade)
server.on('clientError', (_error, socket) => socket.destroy())
server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') portInUse()
  err(String(error))
  exit(1)
})
server.listen(port, '127.0.0.1', () => log(`server listening on 127.0.0.1:${port}`))

createInterface({ input: process.stdin }).on('line', (line) => {
  const command = line.trim()
  if (command === '') return
  if (command === '/players') print(playersLine())
  else if (command === '/save') {
    save()
    print('Game saved')
    // FAKE_MODE=buffered holds everything until now.
    if (modes.has('buffered')) {
      for (const text of printed.splice(0)) out(text)
      flush()
    }
  } else if (command === '/exit') {
    if (modes.has('ignore-exit')) return
    save()
    quit(0)
  } else if (command === '/fake_items') fakeItems()
  else if (!command.startsWith('/')) noticeAll(`[Server]: ${command}`)
})
