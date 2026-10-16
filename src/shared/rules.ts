// Server and generator rule presets (spec §3.13, brief §4.3). Values not named by a preset are
// Archipelago 0.6.8's own defaults (settings.py ServerOptions / GeneratorOptions).
import type { Rules } from './types'

const casual: Rules = {
  preset: 'casual',
  spoiler: 3,
  race: false,
  hintCost: 10,
  locationCheckPoints: 1,
  releaseMode: 'auto',
  collectMode: 'auto',
  remainingMode: 'goal',
  countdownMode: 'auto',
  itemCheat: false,
  autoShutdown: 0,
  plando: ['bosses', 'connections', 'texts'],
  compatibility: 2,
}

export const RULE_PRESETS: Record<'casual' | 'async' | 'race', Rules> = {
  casual,
  async: { ...casual, plando: [...casual.plando], preset: 'async', autoShutdown: 0 },
  race: { ...casual, plando: [...casual.plando], preset: 'race', race: true, spoiler: 0, compatibility: 0 },
}

/** A fresh copy of the casual preset. */
export function defaultRules(): Rules {
  return structuredClone(RULE_PRESETS.casual)
}
