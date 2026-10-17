import { z } from 'zod'
import type { ApInstall, ApRelease, TaskRef } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

// A `TaskRef` output means the work runs as a task: its result arrives with `task:done`.
export const apChannels = {
  'ap:detect': channel(voidInput)<ApInstall | null>(),
  'ap:latestRelease': channel(z.strictObject({ force: z.boolean().optional() }))<ApRelease>(),
  /**
   * Task result: `ApInstall`. `allowUnverified` confirms the install of a release file GitHub gives no
   * SHA-256 for (only its size is checked then): without it, such a file is refused (spec §3.3).
   */
  'ap:install': channel(
    z.strictObject({
      desktopIcons: z.boolean(),
      customDir: nonEmpty.optional(),
      allowUnverified: z.boolean().optional(),
    }),
  )<TaskRef>(),
  /** Task result: `null`. */
  'ap:uninstall': channel(z.strictObject({ purgeUserData: z.boolean() }))<TaskRef>(),
  'ap:setCustomPath': channel(z.strictObject({ path: nonEmpty.nullable() }))<ApInstall | null>(),
  'ap:processes': channel(voidInput)<{ pid: number; name: string }[]>(),
  /** Task result: `{ count: number }`. */
  'ap:regenerateTemplates': channel(voidInput)<TaskRef>(),
}
