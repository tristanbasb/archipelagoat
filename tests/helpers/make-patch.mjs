// The one builder of test zips shaped like Archipelago's output: a player's patch container, a zip
// with an `archipelago.json` manifest (worlds/Files.py), and the AP_<seed>.zip of a generation
// (Main.py:384-389). The fake ArchipelagoGenerate uses it, and so do the tests that read patches.
import { createWriteStream, mkdirSync } from 'node:fs'
import { EOL } from 'node:os'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { pickleMultidata } from './make-pickle.mjs'

/** MD5 of the Pokemon Emerald ROM (worlds/pokemon_emerald/rom.py:100). */
export const EMERALD_MD5 = '605b89b67018abcea91e693a4dd25be3'

/**
 * A valid manifest, as PokemonEmeraldProcedurePatch writes it (keys in the order AP adds them), with
 * `fields` over it.
 */
export function patchManifest(fields = {}) {
  return {
    compatible_version: 6,
    version: 7,
    server: '',
    player: 1,
    player_name: 'Alice',
    game: 'Pokemon Emerald',
    patch_file_ending: '.apemerald',
    procedure: [
      ['apply_bsdiff4', ['base_patch.bsdiff4']],
      ['apply_tokens', ['token_data.bin']],
    ],
    base_checksum: EMERALD_MD5,
    result_file_ending: '.gba',
    ...fields,
  }
}

function fillZip(entries) {
  const zip = new ZipFile()
  for (const [name, data] of entries) zip.addBuffer(Buffer.from(data), name)
  zip.end()
  return zip
}

async function zipBuffer(entries) {
  const chunks = []
  for await (const chunk of fillZip(entries).outputStream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function writeZip(dest, entries) {
  mkdirSync(dirname(dest), { recursive: true })
  await pipeline(fillZip(entries).outputStream, createWriteStream(dest))
  return dest
}

/** `manifest`: an object (written as JSON), raw text (e.g. invalid JSON), or null for no manifest. */
function patchEntries(manifest, extraEntries) {
  const entries = []
  if (manifest !== null) {
    entries.push(['archipelago.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest)])
  }
  return [...entries, ...Object.entries(extraEntries)]
}

/** Writes a patch container at `dest` and returns `dest`. */
export function makePatchZip(dest, manifest, extraEntries = {}) {
  return writeZip(dest, patchEntries(manifest, extraEntries))
}

/** Python's `utf-8-sig` encoding starts the file with it. */
const BOM = String.fromCodePoint(0xfeff)

/** `Utils.get_file_safe_name`, then spaces to `_` (BaseClasses.py:404-409). */
const fileSafe = (name) => name.replace(/[<>:"/\\|?*]/g, '').replaceAll(' ', '_')

/** How many locations a slot has when the test does not say. */
const DEFAULT_CHECKS = 100
const checksOf = (slot) => slot.checks ?? DEFAULT_CHECKS

/**
 * The spoiler header (BaseClasses.py:1869-1892): UTF-8 with a BOM, the platform's line ends, and a
 * `Player <n>: <name>` line only when there are several players.
 */
function spoiler(seed, slots) {
  const field = (label, value) => `${`${label}:`.padEnd(33)}${value}`
  const lines = [
    `Archipelago Version 0.6.8  -  Seed: ${seed}`,
    '',
    field('Filling Algorithm', 'balanced'),
    field('Players', slots.length),
  ]
  if (slots.length > 1) {
    lines.push(
      field(
        'Total Location Count',
        slots.reduce((sum, slot) => sum + checksOf(slot), 0),
      ),
    )
  }
  lines.push(field('Plando Options', 'connections, texts, bosses'))
  slots.forEach((slot, i) => {
    if (slots.length > 1) lines.push('', `Player ${i + 1}: ${slot.name}`)
    lines.push(field('Game', slot.game), field('Location Count', checksOf(slot)))
  })
  return `${BOM}${lines.join(EOL)}${EOL}`
}

/**
 * Writes the AP_<seed>.zip of a generation at `dest` and returns `dest`: the multidata (a pickle with
 * `slot.checks` locations for each slot, 100 by default), the spoiler, and `AP_<seed>_P<n>_<name><patch>`
 * for each slot that has a `patch` extension. A slot's manifest is `patchManifest` with its player, name,
 * game and extension, then `slot.manifest`.
 */
export async function makeSeedZip(dest, { seed, slots }) {
  const base = `AP_${seed}`
  const multidata = pickleMultidata({
    slots: slots.map((slot) => ({ name: slot.name, game: slot.game, checks: checksOf(slot) })),
  })
  const entries = [
    [`${base}.archipelago`, multidata],
    [`${base}_Spoiler.txt`, spoiler(seed, slots)],
  ]
  for (const [i, slot] of slots.entries()) {
    if (!slot.patch) continue
    const manifest = patchManifest({
      player: i + 1,
      player_name: slot.name,
      game: slot.game,
      patch_file_ending: slot.patch,
      ...slot.manifest,
    })
    entries.push([
      `${base}_P${i + 1}_${fileSafe(slot.name)}${slot.patch}`,
      await zipBuffer(patchEntries(manifest, {})),
    ])
  }
  return writeZip(dest, entries)
}
