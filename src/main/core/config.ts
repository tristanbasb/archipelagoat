// The app settings (userData/config.json): deep-merged updates, atomic writes, config:changed events.
import { z } from 'zod'
import { AppError } from '@shared/errors'
import { AppConfigPatch } from '@shared/ipc/app'
import { describeZodError } from '@shared/ipc/contract'
import type { AppConfig, OS } from '@shared/types'
import type { EventBus } from './events'
import { readJsonSync, writeJsonAtomicSync } from './json-file'

export interface ConfigStore {
  get(): AppConfig
  /** What the renderer may change (`app:setConfig`). Throws INVALID_INPUT for anything else. */
  update(patch: z.input<typeof AppConfigPatch>): AppConfig
  /** Main process only: may also change `apPathOverride` and `integration` (Tasks 6 and 21). */
  updateInternal(patch: Partial<AppConfig>): AppConfig
}

export interface ConfigStoreOptions {
  bus?: EventBus
  /** GOAT_WEBHOST_URL, when the test environment is allowed: applied at runtime, never saved. */
  webhostUrlOverride?: string | null
}

export function defaultConfig(os: OS): AppConfig {
  return {
    language: 'auto',
    effects: { crt: true, glow: true, animations: true, sounds: false },
    showAfterDark: false,
    apPathOverride: null,
    // Archipelago's own installer ticks "desktop icons" by default.
    desktopIcons: true,
    integration: { linuxDesktop: os === 'linux', winProtocol: false, winAssociations: false },
    allowPlaintextSecrets: false,
    firstRunDone: false,
    webhostUrl: 'https://archipelago.gg',
  }
}

// Each stored field is checked on its own: an invalid or unknown value falls back to its default.
const flag = z.boolean().optional().catch(undefined)
const StoredConfig = z.object({
  language: z.enum(['fr', 'en', 'auto']).optional().catch(undefined),
  effects: z.object({ crt: flag, glow: flag, animations: flag, sounds: flag }).optional().catch(undefined),
  showAfterDark: flag,
  apPathOverride: z.string().min(1).nullable().optional().catch(undefined),
  desktopIcons: flag,
  integration: z
    .object({ linuxDesktop: flag, winProtocol: flag, winAssociations: flag })
    .optional()
    .catch(undefined),
  allowPlaintextSecrets: flag,
  firstRunDone: flag,
  webhostUrl: z.string().min(1).optional().catch(undefined),
})

type ConfigPatch = {
  [K in keyof AppConfig]?: AppConfig[K] extends object ? Partial<AppConfig[K]> : AppConfig[K]
}

function defined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

function merge(base: AppConfig, patch: ConfigPatch): AppConfig {
  const { effects, integration, ...rest } = patch
  return {
    ...base,
    ...defined(rest),
    effects: { ...base.effects, ...defined(effects) },
    integration: { ...base.integration, ...defined(integration) },
  }
}

function load(file: string, os: OS): AppConfig {
  const parsed = StoredConfig.safeParse(readJsonSync(file))
  return merge(defaultConfig(os), parsed.success ? parsed.data : {})
}

export function createConfigStore(file: string, os: OS, opts: ConfigStoreOptions = {}): ConfigStore {
  let stored = load(file, os)

  const view = (): AppConfig => {
    const config = structuredClone(stored)
    if (opts.webhostUrlOverride) config.webhostUrl = opts.webhostUrlOverride
    return config
  }

  const commit = (next: AppConfig): AppConfig => {
    writeJsonAtomicSync(file, next)
    stored = next
    const config = view()
    opts.bus?.emit('config:changed', config)
    return config
  }

  return {
    get: view,
    update(patch) {
      const parsed = AppConfigPatch.safeParse(patch)
      if (!parsed.success)
        throw new AppError('INVALID_INPUT', undefined, { detail: describeZodError(parsed.error) })
      return commit(merge(stored, parsed.data))
    },
    updateInternal(patch) {
      return commit(merge(stored, patch))
    },
  }
}
