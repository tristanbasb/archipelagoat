// How option values and profile checks read on screen, the same in every place that lists a change
// (the Studio's profile chips, the Checks panel's proposals, the « Jeu prêt » dialog).
import type { TFunction } from 'i18next'
import type { GameProfile } from '@shared/types'

/** An option's value as the YAML writes it: text as it is, numbers and booleans plainly, else JSON. */
export function optionValueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // JSON.stringify gives nothing for undefined (an option the schema has no default for).
  return JSON.stringify(value) ?? String(value)
}

/** A profile's checks: "≈ 203 checks", a range "180–230 checks" for a YAML that rolls dice, or not measured. */
export function profileChecksText(profile: GameProfile, t: TFunction): string {
  if (profile.checks === null) return t('profiles.notMeasured')
  if (profile.range !== null) return t('profiles.range', { min: profile.range[0], max: profile.range[1] })
  return t('profiles.checks', { count: profile.checks })
}
