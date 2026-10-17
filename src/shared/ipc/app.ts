import { z } from 'zod'
import type { AppConfig, AppInfo, OpenRequest } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

export const EffectsSchema = z.strictObject({
  crt: z.boolean(),
  glow: z.boolean(),
  animations: z.boolean(),
  sounds: z.boolean(),
})

/**
 * What the renderer may change through `app:setConfig`. The other fields are main-only:
 * `apPathOverride` goes through `ap:setCustomPath` (which validates the folder), `integration` through
 * `system:setIntegration`, and `webhostUrl` is not settable over IPC at all.
 */
export const AppConfigPatch = z
  .strictObject({
    language: z.enum(['fr', 'en', 'auto']),
    effects: EffectsSchema.partial(),
    showAfterDark: z.boolean(),
    desktopIcons: z.boolean(),
    allowPlaintextSecrets: z.boolean(),
    firstRunDone: z.boolean(),
    firstLocalHostDone: z.boolean(),
  })
  .partial()

const DialogFilter = z.strictObject({ name: z.string(), extensions: z.array(z.string()) })

export const appChannels = {
  'app:getInfo': channel(voidInput)<AppInfo>(),
  'app:getConfig': channel(voidInput)<AppConfig>(),
  'app:setConfig': channel(AppConfigPatch)<AppConfig>(),
  /** Opens a folder or a text file inside the allowed roots (`ctx.paths`); anything else is refused. */
  'app:openPath': channel(z.strictObject({ path: nonEmpty }))<void>(),
  /** Opens https links to the allow-listed hosts only; anything else is PATH_FORBIDDEN. */
  'app:openExternal': channel(z.strictObject({ url: nonEmpty }))<void>(),
  'app:pickPaths': channel(
    z.strictObject({
      mode: z.enum(['file', 'files', 'directory']),
      title: z.string().optional(),
      filters: z.array(DialogFilter).optional(),
    }),
  )<string[]>(),
  'app:savePath': channel(
    z.strictObject({ defaultName: nonEmpty, filters: z.array(DialogFilter).optional() }),
  )<string | null>(),
  /** Implemented by Task 21. */
  'app:pendingOpenRequests': channel(voidInput)<OpenRequest[]>(),
  'app:confirmQuit': channel(z.strictObject({ requestId: nonEmpty, confirm: z.boolean() }))<void>(),
  'app:setGithubToken': channel(z.strictObject({ token: nonEmpty.nullable() }))<{ hasToken: boolean }>(),
  'app:secretsStatus': channel(voidInput)<{ canEncrypt: boolean; hasGithubToken: boolean }>(),
  'app:clearData': channel(
    z.strictObject({ targets: z.array(z.enum(['downloads', 'catalog', 'logs'])) }),
  )<void>(),
}
