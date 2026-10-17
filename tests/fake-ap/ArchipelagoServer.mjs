// Fake ArchipelagoServer (tests only). Prints the captured startup of a real server up to
// `Hosting game at` (logged before the bind, like MultiServer.py:2852), then 300 ms later really
// listens on --port, on 127.0.0.1 only (no firewall prompt), and prints `server listening on`.
// Console on stdin like MultiServer: /players answers one line, /save writes the save file, /exit
// writes it then exits 0, and EOF is ignored (MultiServer's console thread spins forever).
// FAKE_MODE: port-busy (OSError then exit 1, as when --port is taken), ignore-exit (/exit does
// nothing), buffered (output held until /save or the exit).
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { argValue, argv, err, exit, fixtureLines, flush, modes, out, record, sleep } from './common.mjs'

const port = Number(argValue('--port') ?? 38281)
// AP saves next to the multidata, output/AP_<seed>.zip → output/AP_<seed>.apsave: MultiServer 0.6.8
// parses --savefile but never reads it (MultiServer.py:694-701, 2708), as the real run showed.
const multidata = argv.find((arg) => /\.(?:zip|archipelago)$/i.test(arg))
const savefile = multidata?.replace(/\.[^.\\/]+$/, '.apsave')

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

record()
const startup = fixtureLines('server-startup.txt')
const hosting = startup.findIndex((line) => line.startsWith('Hosting game at '))
for (const line of startup.slice(0, hosting + 1))
  out(line.replace(/^(Hosting game at .*):\d+ \(/, `$1:${port} (`))

await sleep(300)
if (modes.has('port-busy')) portInUse()

const server = createServer((socket) => socket.on('error', () => undefined))
server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') portInUse()
  err(String(error))
  exit(1)
})
server.listen(port, '127.0.0.1', () => out(`server listening on 127.0.0.1:${port}`))

createInterface({ input: process.stdin }).on('line', (line) => {
  const command = line.trim()
  if (command === '/players') out('0 players of 2 connected :: Team #1: (Alice) (Bob)')
  else if (command === '/save') {
    save()
    out('Game saved')
    flush()
  } else if (command === '/exit' && !modes.has('ignore-exit')) {
    save()
    exit(0)
  }
})
