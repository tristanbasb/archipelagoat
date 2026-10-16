import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { coreWorldsFor } from '@shared/data/core-worlds'
import { ROM_TABLE } from '@shared/data/rom-table'

const AP_SRC = process.env.AP_SRC
const SCRIPT = fileURLToPath(new URL('../../../scripts/gen-core-worlds.mjs', import.meta.url))
const JSON_FILE = fileURLToPath(new URL('../../../resources/core-worlds-0.6.8.json', import.meta.url))

describe('coreWorldsFor', () => {
  it('core worlds for 0.6.8 include A Link to the Past (loose) and exclude DKC3', () => {
    const worlds = coreWorldsFor('0.6.8')
    expect(worlds).not.toBeNull()
    expect(worlds).toContainEqual({ module: 'alttp', game: 'A Link to the Past', loose: true })
    expect(worlds?.some((world) => /donkey|dkc/i.test(`${world.game} ${world.module}`))).toBe(false)
    expect(worlds?.some((world) => /minecraft/i.test(world.game))).toBe(false)
  })

  it('knows the Gauntlet Legends world 0.6.8 added', () => {
    expect(coreWorldsFor('0.6.8')).toContainEqual({ module: 'gl', game: 'Gauntlet Legends', loose: false })
  })

  it('returns null for a version it has no table for', () => {
    expect(coreWorldsFor('0.6.7')).toBeNull()
    expect(coreWorldsFor('')).toBeNull()
    expect(coreWorldsFor('not a version')).toBeNull()
  })

  it('accepts a leading v and surrounding spaces', () => {
    expect(coreWorldsFor(' v0.6.8 ')).toEqual(coreWorldsFor('0.6.8'))
  })

  it('hands out copies, so a caller cannot corrupt the table', () => {
    const first = coreWorldsFor('0.6.8')
    first?.splice(0, first.length)
    expect(coreWorldsFor('0.6.8')?.length).toBeGreaterThan(70)
    const alttp = coreWorldsFor('0.6.8')?.find((world) => world.module === 'alttp')
    if (alttp) alttp.loose = false
    expect(coreWorldsFor('0.6.8')?.find((world) => world.module === 'alttp')?.loose).toBe(true)
  })
})

describe('resources/core-worlds-0.6.8.json', () => {
  const file = JSON.parse(readFileSync(JSON_FILE, 'utf8')) as {
    apVersion: string
    worlds: { module: string; game: string; loose: boolean }[]
  }

  it('has the documented shape', () => {
    expect(file.apVersion).toBe('0.6.8')
    expect(file.worlds.length).toBeGreaterThan(70)
    for (const world of file.worlds) {
      expect(Object.keys(world).sort()).toEqual(['game', 'loose', 'module'])
      expect(world.module).toMatch(/^[a-z0-9_]+$/)
      expect(world.game.length).toBeGreaterThan(0)
    }
  })

  it('has unique games and is sorted by module, so regenerating gives no churn', () => {
    const games = file.worlds.map((world) => world.game)
    expect(new Set(games).size).toBe(games.length)
    const modules = file.worlds.map((world) => world.module)
    expect([...modules].sort()).toEqual(modules)
  })

  it('marks exactly the 11 folders the frozen build keeps loose (research brief 1.10)', () => {
    expect(file.worlds.filter((world) => world.loose).map((world) => world.module)).toEqual([
      'adventure',
      'alttp',
      'generic',
      'lufia2ac',
      'meritous',
      'oot',
      'overcooked2',
      'raft',
      'sm64ex',
      'v6',
      'wargroove',
    ])
  })

  it('has every game of the ROM table, so a ROM game is never reported as a missing world', () => {
    const games = new Set(file.worlds.map((world) => world.game))
    for (const entry of ROM_TABLE) expect(games, `ROM table game ${entry.game}`).toContain(entry.game)
  })

  it.runIf(AP_SRC)('is exactly what scripts/gen-core-worlds.mjs reads from AP_SRC', () => {
    // Throws (non-zero exit) when the committed JSON differs from the Archipelago source.
    const out = execFileSync(process.execPath, [SCRIPT, '--check'], {
      env: { ...process.env, AP_SRC },
      encoding: 'utf8',
    })
    expect(out).toMatch(/up to date/)
  })
})
