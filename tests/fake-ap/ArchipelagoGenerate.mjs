// Fake ArchipelagoGenerate (tests only), driven by FAKE_MODE:
// - success (default): prints the captured output of a real generation, then writes a real
//   AP_<seed>.zip in --outputpath (multidata, spoiler, and a valid .apemerald patch for P1);
// - fail: prints a YAML error on stderr, then waits on stdin like AP's atexit `input()`: EOF (or a
//   line) exits 1, an open stdin that nobody writes to blocks forever;
// - slow: waits between the lines;
// - buffered: holds the whole output until the exit.
import { join, resolve } from 'node:path'
import { makeSeedZip } from '../helpers/make-patch.mjs'
import { argValue, err, exit, fixtureLines, modes, out, prompt, record, sleep } from './common.mjs'

const ARCHIVE_LINE = /^Creating final archive at .*\bAP_(\w+)\.zip$/
const LINE_DELAY_MS = 200
// The players of the captured server session (server-session.txt): Alice has a patch, Bob plays a
// PC game that has none.
const SLOTS = [
  { name: 'Alice', game: 'Pokemon Emerald', patch: '.apemerald' },
  { name: 'Bob', game: 'A Hat in Time' },
]

async function succeed() {
  const outputDir = resolve(argValue('--outputpath') ?? 'output')
  for (const line of fixtureLines('generate-success.txt')) {
    if (modes.has('slow')) await sleep(LINE_DELAY_MS)
    const archive = ARCHIVE_LINE.exec(line)
    if (archive === null) {
      out(line)
      continue
    }
    const seed = archive[1]
    const zip = join(outputDir, `AP_${seed}.zip`)
    await makeSeedZip(zip, { seed, slots: SLOTS })
    out(`Creating final archive at ${zip}`)
  }
  exit(0)
}

function fail() {
  const lines = fixtureLines('generate-yaml-error.txt')
  out(lines[0])
  for (const line of lines.slice(1, -1)) err(line)
  prompt(lines.at(-1))
  process.stdin.once('data', () => exit(1))
  process.stdin.once('end', () => exit(1))
  process.stdin.resume()
}

record()
if (modes.has('fail')) fail()
else await succeed()
