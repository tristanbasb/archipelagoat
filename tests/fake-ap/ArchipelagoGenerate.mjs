// Fake ArchipelagoGenerate (tests only), driven by FAKE_MODE:
// - success (default): prints the captured output of a real generation, then writes a real
//   AP_<seed>.zip in --outputpath (multidata, spoiler, and a valid .apemerald patch for P1);
// - fail: prints a YAML error on stderr, then waits on stdin like AP's atexit `input()`: EOF (or a
//   line) exits 1, an open stdin that nobody writes to blocks forever;
// - slow: waits between the lines;
// - buffered: holds the whole output until the exit.
// A test generation of the checks measure (`--spoiler 0` and `--skip_prog_balancing`) succeeds at
// once instead: one slot per player document of --player_files_path, each with the checks FAKE_CHECKS
// (`{ "<game>": <count> }`, JSON) gives its game, 100 by default. A document whose `game:` is weighted
// plays the game the seed picks among those of non-zero weight.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'
import { makeSeedZip } from '../helpers/make-patch.mjs'
import { argv, argValue, err, exit, fixtureLines, modes, out, prompt, record, sleep } from './common.mjs'

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

/** The game a document plays: its `game:`, or the seed's pick among its weighted games. */
function gameOf(doc, seed) {
  if (typeof doc.game === 'string') return doc.game
  const games = Object.entries(doc.game ?? {})
    .filter(([, weight]) => Number(weight) > 0)
    .map(([game]) => game)
    .sort()
  return games[seed % games.length] ?? 'Unknown'
}

async function measure() {
  const playersDir = resolve(argValue('--player_files_path') ?? 'Players')
  const outputDir = resolve(argValue('--outputpath') ?? 'output')
  const seed = Number(argValue('--seed') ?? '0')
  const checks = JSON.parse(process.env.FAKE_CHECKS ?? '{}')
  const slots = []
  for (const file of readdirSync(playersDir).sort()) {
    if (!/\.ya?ml$/i.test(file)) continue
    for (const parsed of parseAllDocuments(readFileSync(join(playersDir, file), 'utf8'))) {
      const doc = parsed.toJS()
      if (doc === null || typeof doc !== 'object') continue
      const game = gameOf(doc, seed)
      slots.push({ name: String(doc.name ?? file), game, checks: checks[game] ?? 100 })
    }
  }
  out(`Generating for ${slots.length} player(s), seed ${seed}.`)
  const zip = join(outputDir, `AP_${seed}.zip`)
  await makeSeedZip(zip, { seed: String(seed), slots })
  out(`Creating final archive at ${zip}`)
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
const measuring = argValue('--spoiler') === '0' && argv.includes('--skip_prog_balancing')
if (modes.has('fail')) fail()
else if (measuring) await measure()
else await succeed()
