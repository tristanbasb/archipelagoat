// Where the English setup guide of a game lives on the webhost. A guide is
// `<base>/tutorial/<Game name>/<link>`, and `<link>` is the `link` of the world's first English
// `Tutorial`: `setup/en` for almost every world (brief 1.11). These are the worlds of 0.6.8 whose
// English guide has another link, read from their `Tutorial(...)` declarations in worlds/*.
import { WEBHOST_DEFAULT } from './ap-constants'

export const TUTORIAL_LINKS: Readonly<Record<string, string>> = {
  'A Link to the Past': 'multiworld/en', // worlds/alttp/__init__.py:48
  'Super Metroid': 'multiworld/en', // worlds/sm/__init__.py:78
  SMZ3: 'multiworld/en', // worlds/smz3/__init__.py:58
  'Secret of Evermore': 'multiworld/en', // worlds/soe/__init__.py:155
  'The Legend of Zelda': 'multiworld/en', // worlds/tloz/__init__.py:53
  'Final Fantasy': 'multiworld/en', // worlds/ff1/__init__.py:24
  'Celeste 64': 'guide/en', // worlds/celeste64/__init__.py:23
  'Celeste (Open World)': 'guide/en', // worlds/celeste_open_world/__init__.py:25
  Paint: 'guide/en', // worlds/paint/__init__.py:19
  'Kingdom Hearts': 'kh1/en', // worlds/kh1/__init__.py:37
  'Landstalker - The Treasures of King Nole': 'landstalker_setup/en', // worlds/landstalker/__init__.py:21
  Wargroove: 'wargroove/en', // worlds/wargroove/__init__.py:56
}

const LINK_OF_GAME = new Map(Object.entries(TUTORIAL_LINKS))

/** URL of the English setup guide of `game` on the webhost `base` (archipelago.gg by default). */
export function tutorialUrl(game: string, base: string = WEBHOST_DEFAULT): string {
  const link = LINK_OF_GAME.get(game) ?? 'setup/en'
  return `${base.replace(/\/+$/, '')}/tutorial/${encodeURIComponent(game)}/${link}`
}
