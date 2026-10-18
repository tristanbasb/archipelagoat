// What the catalog tab shows offline, written into a launch's dataRoot before the app starts: a saved
// catalog (dataRoot/catalog/catalog.json, as src/main/core/worlds/catalog.ts reads it back) of a few
// core worlds with a wiki cover link each, and the covers cache (dataRoot/covers/ with its index.json,
// as src/main/core/covers/covers.ts keeps it) already holding the image of each link.
//
// The cover allowlist (static.wikitide.net, upload.wikimedia.org) is never loosened for tests, so the app
// is not pointed at a fake host: the cache is seeded and the download path is left to the unit tests.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { IoniumWorld, WikiPage } from '@main/core/worlds/catalog'

/** A core world of the fake install, as the catalog lists it. */
export interface SeededGame {
  /** The game, as Archipelago names it (the index's `name`). */
  game: string
  /** The world's module (the index file's stem). */
  module: string
  /** The wiki page's title, when it is not the game's name (the wiki writes "Pokémon"). */
  title?: string
  /** The tone of its cover. */
  color: readonly [red: number, green: number, blue: number]
  /** The wiki says a PopTracker pack exists. */
  popTracker?: boolean
  /** The wiki says the game needs a ROM at generation. */
  rom?: boolean
}

/** The core games of the fake install (see FAKE_GAMES in helpers.ts), each with its own cover. */
export const SEEDED_GAMES: readonly SeededGame[] = [
  { game: 'A Link to the Past', module: 'alttp', color: [92, 190, 112], popTracker: true },
  {
    game: 'Pokemon Emerald',
    module: 'pokemon_emerald',
    title: 'Pokémon Emerald',
    color: [38, 164, 130],
    rom: true,
  },
  { game: 'The Witness', module: 'witness', color: [70, 132, 216] },
  { game: 'TUNIC', module: 'tunic', color: [226, 150, 54], popTracker: true },
]

/** The `SAVED_VERSION` of catalog.ts: a catalog saved with another one is ignored. */
const CATALOG_VERSION = 3

const coverUrl = (game: SeededGame): string =>
  `https://static.wikitide.net/archipelagowiki/${game.module.slice(0, 1)}/${game.module.slice(0, 2)}/${game.module}.png`

// --- a small real PNG ----------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

const COVER_WIDTH = 96
const COVER_HEIGHT = 128
const PIXEL = 8

/**
 * A 3:4 box-art stand-in: chunky pixels fading from the game's tone to dark, a lighter diamond in the
 * middle. Deterministic, a few KB, a PNG every decoder opens.
 */
export function coverPng([red, green, blue]: SeededGame['color']): Buffer {
  const rows: Buffer[] = []
  for (let y = 0; y < COVER_HEIGHT; y++) {
    const row = Buffer.alloc(1 + COVER_WIDTH * 3)
    for (let x = 0; x < COVER_WIDTH; x++) {
      const col = Math.floor(x / PIXEL)
      const line = Math.floor(y / PIXEL)
      // From the tone at the top to a dark shade at the bottom, in steps of one pixel row.
      let shade = 1 - (line / (COVER_HEIGHT / PIXEL)) * 0.65
      const dx = Math.abs(col - (COVER_WIDTH / PIXEL - 1) / 2)
      const dy = Math.abs(line - (COVER_HEIGHT / PIXEL - 1) / 2)
      if (dx + dy <= 3) shade = 1.35
      row[1 + x * 3] = Math.min(255, Math.round(red * shade))
      row[2 + x * 3] = Math.min(255, Math.round(green * shade))
      row[3 + x * 3] = Math.min(255, Math.round(blue * shade))
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(COVER_WIDTH, 0)
  header.writeUInt32BE(COVER_HEIGHT, 4)
  // 8 bits per channel, truecolor, the default compression, filter and interlace methods.
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- the files -----------------------------------------------------------------------------------

/** Writes the saved catalog and the covers cache of `games` into `dataRoot` (created as needed). */
export function seedCatalog(dataRoot: string, games: readonly SeededGame[] = SEEDED_GAMES): void {
  const worlds: IoniumWorld[] = games.map((one) => ({
    id: one.module,
    dir: 'index',
    name: one.game,
    displayName: one.game,
    home: null,
    defaultUrl: null,
    defaultVersion: 'latest',
    tags: [],
    // A core world: the catalog tells it by its game, `latest` stays null (nothing to download).
    supported: true,
    disabled: false,
    versions: [],
    releases: [],
    bases: [],
  }))
  const pages: WikiPage[] = games.map((one) => ({
    title: one.title ?? one.game,
    status: 'Core-verified',
    maintainer: null,
    setupUrl: `https://archipelago.gg/tutorial/${encodeURIComponent(one.game)}/setup/en`,
    homepage: null,
    download: null,
    repos: [],
    cover: coverUrl(one),
  }))
  const catalog = join(dataRoot, 'catalog')
  mkdirSync(catalog, { recursive: true })
  writeFileSync(
    join(catalog, 'catalog.json'),
    JSON.stringify({
      version: CATALOG_VERSION,
      // Fresh: the catalog asks the network after an hour only (and there is none).
      fetchedAt: new Date().toISOString(),
      apVersion: '0.6.8',
      ionium: { worlds, lock: [] },
      wiki: {
        pages,
        afterDark: [],
        rom: games.filter((one) => one.rom).map((one) => one.title ?? one.game),
        popTracker: games.filter((one) => one.popTracker).map((one) => one.title ?? one.game),
      },
    }),
  )

  // A cover file is named after the sha256 of its link and the type found in its bytes.
  const covers = join(dataRoot, 'covers')
  mkdirSync(covers, { recursive: true })
  const index: Record<string, { url: string; bytes: number; lastViewed: number; games: string[] }> = {}
  for (const one of games) {
    const url = coverUrl(one)
    const bytes = coverPng(one.color)
    const key = `${createHash('sha256').update(url).digest('hex')}.png`
    writeFileSync(join(covers, key), bytes)
    index[key] = { url, bytes: bytes.length, lastViewed: Date.now(), games: [] }
  }
  writeFileSync(join(covers, 'index.json'), JSON.stringify(index))
}
