// The rules of a session as entries of its own host.yaml (spec §3.13, brief §4.3): what the generation
// (Task 15) and the server (Task 16) read, written in the session's copy of the settings, never in the
// global file. The values follow the types of Archipelago 0.6.8's settings.py: `race` and `spoiler` are
// IntEnums (an int, not a bool), `disable_item_cheat` a bool, the passwords strings or None.
import { isAbsolute } from 'node:path'
import { SETTINGS_KEYS } from '@main/core/ap/settings'
import { AppError } from '@shared/errors'
import type { Rules } from '@shared/types'

export interface SessionSecrets {
  password: string | null
  serverPassword: string | null
}

/**
 * The host.yaml entries of a session: its generator and server options, its passwords and one
 * `rom_file` per ROM (`romPaths`: settings key, e.g. `lttp_options.rom_file` → absolute path).
 * INVALID_INPUT for a relative ROM path or a malformed key.
 */
export function buildSessionSettingsEntries(
  rules: Rules,
  secrets: SessionSecrets,
  romPaths: Record<string, string>,
): { path: string[]; value: unknown }[] {
  const generator = (key: string, value: unknown): { path: string[]; value: unknown } => ({
    path: ['generator', key],
    value,
  })
  const server = (key: string, value: unknown): { path: string[]; value: unknown } => ({
    path: ['server_options', key],
    value,
  })
  const roms = Object.entries(romPaths).map(([key, file]) => {
    if (!isAbsolute(file)) {
      throw new AppError('INVALID_INPUT', undefined, { detail: `rom path must be absolute: ${key}` })
    }
    return { path: [...SETTINGS_KEYS.romFile(key)], value: file }
  })
  return [
    generator('spoiler', rules.spoiler),
    generator('race', rules.race ? 1 : 0),
    generator('plando_options', rules.plando.join(', ')),
    server('password', secrets.password),
    server('server_password', secrets.serverPassword),
    server('hint_cost', rules.hintCost),
    server('location_check_points', rules.locationCheckPoints),
    server('release_mode', rules.releaseMode),
    server('collect_mode', rules.collectMode),
    server('remaining_mode', rules.remainingMode),
    server('countdown_mode', rules.countdownMode),
    server('auto_shutdown', rules.autoShutdown),
    server('compatibility', rules.compatibility),
    server('disable_item_cheat', !rules.itemCheat),
    ...roms,
  ]
}
