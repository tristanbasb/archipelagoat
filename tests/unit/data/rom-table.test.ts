import { coreWorldsFor } from '@shared/data/core-worlds'
import { findRomByMd5, findRomsByMd5, ROM_TABLE } from '@shared/data/rom-table'
import type { RomTableEntry } from '@shared/types'
import {
  loadWorld,
  needsRomAtGeneration,
  romSettings,
  settingsKeyOf,
  worldFolders,
  type WorldSource,
} from '../../helpers/ap-source'

const AP_SRC = process.env.AP_SRC

const entryFor = (game: string, settingsKey?: string): RomTableEntry => {
  const entry = ROM_TABLE.find(
    (e) => e.game === game && (settingsKey === undefined || e.settingsKey === settingsKey),
  )
  if (!entry) throw new Error(`no ROM table entry for ${game}`)
  return entry
}

describe('findRomByMd5', () => {
  it('finds Pokemon Emerald by md5', () => {
    expect(findRomByMd5('605b89b67018abcea91e693a4dd25be3')?.settingsKey).toBe(
      'pokemon_emerald_settings.rom_file',
    )
  })

  it('ignores the case of the md5 and surrounding spaces', () => {
    expect(findRomByMd5('605B89B67018ABCEA91E693A4DD25BE3')?.game).toBe('Pokemon Emerald')
    expect(findRomByMd5('  605b89b67018abcea91e693a4dd25be3 ')?.game).toBe('Pokemon Emerald')
  })

  it('tells Pokemon Red from Pokemon Blue, which share a game and a settings group', () => {
    expect(findRomByMd5('3d45c1ee9abd5738df46d2bdda8b57dc')?.settingsKey).toBe(
      'pokemon_rb_options.red_rom_file',
    )
    expect(findRomByMd5('50927e843568814f7ed45ec4f944bd8b')?.settingsKey).toBe(
      'pokemon_rb_options.blue_rom_file',
    )
  })

  it('finds every alternate hash of a game (Kirby JP and US, Mega Man 2 cartridge, VC and LC)', () => {
    expect(findRomByMd5('201e7658f6194458a3869dde36bf8ec2')?.game).toBe("Kirby's Dream Land 3")
    expect(findRomByMd5('b2f2d004ea640c3db66df958fce122b2')?.game).toBe("Kirby's Dream Land 3")
    for (const md5 of [
      '0527a0ee512f69e08b8db6dc97964632',
      '0c78dfe8e90fb8f3eed022ff01126ad3',
      '37f2c36ce7592f1e16b3434b3985c497',
    ]) {
      expect(findRomByMd5(md5)?.game).toBe('Mega Man 2')
    }
  })

  it('returns undefined for a hash it does not know, and for text that is not a hash', () => {
    expect(findRomByMd5('0'.repeat(32))).toBeUndefined()
    expect(findRomByMd5('')).toBeUndefined()
    expect(findRomByMd5('not a hash')).toBeUndefined()
  })

  it('finds both Mega Man games for the Proteus hash, which AP accepts for either', () => {
    const proteus = 'b69fff40212b80c94f19e786d1efbf61'
    expect(findRomsByMd5(proteus).map((e) => e.game)).toEqual(['Mega Man 2', 'Mega Man 3'])
    expect(findRomByMd5(proteus)?.game).toBe('Mega Man 2')
    expect(findRomsByMd5('0'.repeat(32))).toEqual([])
  })

  it('has no other hash shared between two entries', () => {
    const owners = new Map<string, string[]>()
    for (const entry of ROM_TABLE) {
      for (const md5 of entry.md5s) owners.set(md5, [...(owners.get(md5) ?? []), entry.settingsKey])
    }
    const shared = [...owners].filter(([, keys]) => keys.length > 1).map(([md5]) => md5)
    expect(shared).toEqual(['b69fff40212b80c94f19e786d1efbf61'])
  })
})

describe('ROM_TABLE', () => {
  it('marks ALttP required at generation with snes header rule', () => {
    expect(entryFor('A Link to the Past')).toMatchObject({
      md5s: ['03a63945398191337e896e5771f77173'],
      header: 'snes',
      settingsKey: 'lttp_options.rom_file',
      requiredAtGeneration: true,
    })
  })

  it('requires a ROM at generation for exactly the 8 games of the brief', () => {
    const required = ROM_TABLE.filter((e) => e.requiredAtGeneration).map((e) => e.game)
    expect(required.sort()).toEqual(
      [
        'A Link to the Past',
        'Lufia II Ancient Cave',
        'MegaMan Battle Network 3',
        'Ocarina of Time',
        'Secret of Evermore',
        'Super Mario World',
        'The Legend of Zelda',
        "Yoshi's Island",
      ].sort(),
    )
  })

  it('covers the 9 BizHawk worlds of the brief, none of them required at generation', () => {
    const bizhawkGames = [
      'Pokemon Red and Blue',
      'Pokemon Emerald',
      'Mario & Luigi Superstar Saga',
      'Castlevania 64',
      'Castlevania - Circle of the Moon',
      'Mega Man 2',
      'Mega Man 3',
      'Super Mario Land 2',
      'Yu-Gi-Oh! 2006',
    ]
    for (const game of bizhawkGames) expect(entryFor(game).requiredAtGeneration, game).toBe(false)
    expect(ROM_TABLE.filter((e) => e.game === 'Pokemon Red and Blue').map((e) => e.settingsKey)).toEqual([
      'pokemon_rb_options.red_rom_file',
      'pokemon_rb_options.blue_rom_file',
    ])
  })

  it('uses the header rule of the settings class: snes for SNESRomPath, ines for Mega Man, none otherwise', () => {
    const byHeader = (header: RomTableEntry['header']) =>
      ROM_TABLE.filter((e) => e.header === header)
        .map((e) => e.game)
        .sort()
    expect(byHeader('snes')).toEqual(
      [
        'A Link to the Past',
        "Kirby's Dream Land 3",
        'EarthBound',
        'Lufia II Ancient Cave',
        'Secret of Evermore',
        'Super Metroid',
        'Super Mario World',
        "Yoshi's Island",
      ].sort(),
    )
    expect(byHeader('ines')).toEqual(['Mega Man 2', 'Mega Man 3'])
    expect(byHeader('none')).toContain('Pokemon Emerald')
    expect(byHeader('none')).toContain('Ocarina of Time')
  })

  it('keeps the three Ocarina of Time forms (normal, byte-swapped, decompressed) under one key', () => {
    expect(entryFor('Ocarina of Time')).toMatchObject({
      settingsKey: 'oot_options.rom_file',
      md5s: [
        '5bd1fe107bf8106b2ab6650abecd54d6',
        '6697768a7a7df2dd27a692a2638ea90b',
        '05f0f3ebacbc8df9243b6148ffe4792f',
      ],
    })
  })

  it('has well formed entries', () => {
    const keys = ROM_TABLE.map((e) => e.settingsKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of ROM_TABLE) {
      expect(entry.settingsKey, entry.game).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/)
      expect(entry.label.length, entry.game).toBeGreaterThan(0)
      expect(entry.md5s.length, entry.game).toBeGreaterThan(0)
      for (const md5 of entry.md5s) expect(md5, entry.game).toMatch(/^[0-9a-f]{32}$/)
      expect(new Set(entry.md5s).size, entry.game).toBe(entry.md5s.length)
      expect(entry.extensions.length, entry.game).toBeGreaterThan(0)
      for (const ext of entry.extensions) expect(ext, entry.game).toMatch(/^\.[a-z0-9]+$/)
    }
  })

  it('lets the SNES copier header extension through for SNES games', () => {
    for (const entry of ROM_TABLE.filter((e) => e.header === 'snes')) {
      expect(entry.extensions, entry.game).toEqual(expect.arrayContaining(['.sfc', '.smc']))
    }
  })

  it('never carries a game that only needs an executable instead of a ROM', () => {
    const games = ROM_TABLE.map((e) => e.game)
    for (const game of ['The Messenger', 'Saving Princess', 'TUNIC', 'SMZ3'])
      expect(games).not.toContain(game)
  })
})

describe.runIf(AP_SRC)('ROM_TABLE against the Archipelago source (AP_SRC)', () => {
  const apSrc = AP_SRC ?? ''
  // The worlds whose md5s name a game executable, not a ROM.
  const NOT_ROMS = new Set(['messenger', 'saving_princess'])

  const worlds = new Map<string, WorldSource>()
  const folderOfGroup = new Map<string, string>()
  if (AP_SRC) {
    for (const folder of worldFolders(apSrc)) {
      const world = loadWorld(apSrc, folder)
      worlds.set(folder, world)
      folderOfGroup.set(settingsKeyOf(world), folder)
    }
  }
  const split = (settingsKey: string): [string, string] => {
    const [group = '', attr = ''] = settingsKey.split('.')
    return [group, attr]
  }

  it('every ROM_TABLE md5 appears in AP source', () => {
    for (const entry of ROM_TABLE) {
      const folder = folderOfGroup.get(split(entry.settingsKey)[0])
      const world = folder === undefined ? undefined : worlds.get(folder)
      expect(world, `${entry.settingsKey}: settings group not found`).toBeDefined()
      const text = (world?.sources ?? []).join('\n').toLowerCase()
      for (const md5 of entry.md5s) expect(text, `${entry.game} ${md5}`).toContain(md5)
    }
  })

  it('every settings key is the attribute of a settings class that validates against md5s', () => {
    for (const entry of ROM_TABLE) {
      const [group, attr] = split(entry.settingsKey)
      const folder = folderOfGroup.get(group) ?? ''
      const setting = romSettings(worlds.get(folder) as WorldSource).find((s) => s.attr === attr)
      expect(setting, `${entry.settingsKey} in worlds/${folder}`).toBeDefined()
    }
  })

  it('has exactly the hashes the settings class of each entry accepts', () => {
    for (const entry of ROM_TABLE) {
      const [group, attr] = split(entry.settingsKey)
      const folder = folderOfGroup.get(group) ?? ''
      const setting = romSettings(worlds.get(folder) as WorldSource).find((s) => s.attr === attr)
      expect([...entry.md5s].sort(), entry.settingsKey).toEqual([...(setting?.md5s ?? [])].sort())
    }
  })

  it('has an entry for every ROM setting of AP, bar the game executables', () => {
    const inSource = [...worlds.values()]
      .filter((world) => !NOT_ROMS.has(world.folder))
      .flatMap((world) => romSettings(world).map((s) => `${settingsKeyOf(world)}.${s.attr}`))
    expect(inSource.length).toBeGreaterThan(20)
    expect(ROM_TABLE.map((e) => e.settingsKey).sort()).toEqual(inSource.sort())
  })

  it('has the header rule of the settings class', () => {
    for (const entry of ROM_TABLE) {
      const [group, attr] = split(entry.settingsKey)
      const world = worlds.get(folderOfGroup.get(group) ?? '') as WorldSource
      const setting = romSettings(world).find((s) => s.attr === attr)
      const strips512 = setting?.base.endsWith('SNESRomPath') === true
      const skipsInes = world.initSource.includes('NES\\x1A')
      const expected = strips512 ? 'snes' : skipsInes ? 'ines' : 'none'
      expect(entry.header, entry.settingsKey).toBe(expected)
    }
  })

  it('asks for a ROM at generation exactly for the worlds whose stage_assert_generate looks for one', () => {
    const inSource = [...worlds.values()].filter(needsRomAtGeneration).map((world) => settingsKeyOf(world))
    const inTable = ROM_TABLE.filter((e) => e.requiredAtGeneration).map((e) => split(e.settingsKey)[0])
    expect(inTable.sort()).toEqual(inSource.sort())
  })

  it('has the game of the world that owns its settings group', () => {
    const table = coreWorldsFor('0.6.8') ?? []
    for (const entry of ROM_TABLE) {
      const folder = folderOfGroup.get(split(entry.settingsKey)[0])
      expect(table.find((w) => w.module === folder)?.game, entry.settingsKey).toBe(entry.game)
    }
  })
})
