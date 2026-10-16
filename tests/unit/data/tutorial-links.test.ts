import { coreWorldsFor } from '@shared/data/core-worlds'
import { TUTORIAL_LINKS, tutorialUrl } from '@shared/data/tutorial-links'

describe('tutorialUrl', () => {
  it('tutorialUrl special-cases ALttP multiworld/en', () => {
    expect(tutorialUrl('A Link to the Past')).toBe(
      'https://archipelago.gg/tutorial/A%20Link%20to%20the%20Past/multiworld/en',
    )
  })

  it('uses multiworld/en for SM, SMZ3, SoE, TLoZ and FF1 too', () => {
    for (const game of [
      'Super Metroid',
      'SMZ3',
      'Secret of Evermore',
      'The Legend of Zelda',
      'Final Fantasy',
    ]) {
      expect(tutorialUrl(game)).toMatch(/\/multiworld\/en$/)
    }
  })

  it('uses guide/en for Celeste 64, Celeste Open World and Paint', () => {
    expect(tutorialUrl('Celeste 64')).toBe('https://archipelago.gg/tutorial/Celeste%2064/guide/en')
    expect(tutorialUrl('Celeste (Open World)')).toBe(
      'https://archipelago.gg/tutorial/Celeste%20(Open%20World)/guide/en',
    )
    expect(tutorialUrl('Paint')).toBe('https://archipelago.gg/tutorial/Paint/guide/en')
  })

  it('uses the own link of Landstalker, Wargroove and Kingdom Hearts', () => {
    expect(tutorialUrl('Landstalker - The Treasures of King Nole')).toMatch(/\/landstalker_setup\/en$/)
    expect(tutorialUrl('Wargroove')).toBe('https://archipelago.gg/tutorial/Wargroove/wargroove/en')
    expect(tutorialUrl('Kingdom Hearts')).toBe('https://archipelago.gg/tutorial/Kingdom%20Hearts/kh1/en')
  })

  it('falls back to setup/en for every other game', () => {
    expect(tutorialUrl('Pokemon Emerald')).toBe('https://archipelago.gg/tutorial/Pokemon%20Emerald/setup/en')
    expect(tutorialUrl('Kingdom Hearts 2')).toMatch(/\/setup\/en$/)
    expect(tutorialUrl('Some Custom Game')).toMatch(/\/setup\/en$/)
  })

  it('encodes the game name as one path segment', () => {
    expect(tutorialUrl('Mario & Luigi Superstar Saga')).toBe(
      'https://archipelago.gg/tutorial/Mario%20%26%20Luigi%20Superstar%20Saga/setup/en',
    )
    expect(tutorialUrl('Yu-Gi-Oh! 2006')).toBe('https://archipelago.gg/tutorial/Yu-Gi-Oh!%202006/setup/en')
    expect(tutorialUrl('Pokémon/Odd #1?')).toBe(
      'https://archipelago.gg/tutorial/Pok%C3%A9mon%2FOdd%20%231%3F/setup/en',
    )
  })

  it('honours another webhost and ignores a trailing slash on it', () => {
    expect(tutorialUrl('Raft', 'http://localhost:8080')).toBe('http://localhost:8080/tutorial/Raft/setup/en')
    expect(tutorialUrl('Raft', 'https://example.org/')).toBe('https://example.org/tutorial/Raft/setup/en')
  })

  it('builds a valid https URL for every game of the 0.6.8 core table', () => {
    for (const world of coreWorldsFor('0.6.8') ?? []) {
      const url = new URL(tutorialUrl(world.game))
      expect(url.origin).toBe('https://archipelago.gg')
      expect(url.pathname).toMatch(/^\/tutorial\/[^/]+\/[a-z0-9_]+\/en$/)
    }
  })
})

describe('TUTORIAL_LINKS', () => {
  it('only names games the 0.6.8 core table has, or the link would point at a page that does not exist', () => {
    const games = new Set((coreWorldsFor('0.6.8') ?? []).map((world) => world.game))
    for (const game of Object.keys(TUTORIAL_LINKS)) expect(games, game).toContain(game)
  })

  it('never lists a game for the default link', () => {
    for (const link of Object.values(TUTORIAL_LINKS)) expect(link).not.toBe('setup/en')
  })
})
