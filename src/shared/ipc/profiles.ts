import { z } from 'zod'
import type { GameProfiles } from '../types'
import { channel, nonEmpty } from './contract'

export const profilesChannels = {
  /**
   * The Découverte, Standard and Complet profiles of a game, at once: measured when they were refined
   * for its installed world and option schema (`measured`), else built from its options alone, and
   * then refined in the background for an installed game (a `profiles` task; `checks:changed` once
   * done). CHECKS_NO_SCHEMA for a game without an option schema.
   */
  'profiles:get': channel(z.strictObject({ game: nonEmpty }))<GameProfiles>(),
}
