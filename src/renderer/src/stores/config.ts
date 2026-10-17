// The app config, loaded once and kept in step with config:changed (whoever changed it).
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { ChannelInput } from '@shared/ipc/contract'
import type { AppConfig } from '@shared/types'
import { invoke, sharedSubscription, subscribe } from '../lib/goat'

export type ConfigPatch = NonNullable<ChannelInput<'app:setConfig'>>

export interface ConfigApi extends AppConfig {
  /** False until the main process answered (the fields are the defaults until then). */
  loaded: boolean
  /** Applies the patch at once, saves it, and rolls it back if the main process refuses it. */
  set: (patch: ConfigPatch) => Promise<AppConfig>
}

/** What the main process starts with (main/core/config.ts), used until the real config arrives. */
const FALLBACK_CONFIG: AppConfig = {
  language: 'auto',
  effects: { crt: true, glow: true, animations: true, sounds: false },
  showAfterDark: false,
  apPathOverride: null,
  desktopIcons: true,
  integration: { linuxDesktop: false, winProtocol: false, winAssociations: false },
  allowPlaintextSecrets: false,
  firstRunDone: false,
  webhostUrl: 'https://archipelago.gg',
}

const useConfigStore = create<{ config: AppConfig | null }>(() => ({ config: null }))

const retainConfig = sharedSubscription(() => {
  let live = true
  const off = subscribe('config:changed', (config) => useConfigStore.setState({ config }))
  invoke('app:getConfig', undefined).then(
    (config) => {
      // A config:changed that arrived first is newer than this answer.
      if (live && !useConfigStore.getState().config) useConfigStore.setState({ config })
    },
    () => {
      if (live && !useConfigStore.getState().config) useConfigStore.setState({ config: FALLBACK_CONFIG })
    },
  )
  return () => {
    live = false
    off()
    useConfigStore.setState({ config: null })
  }
})

function merge(config: AppConfig, patch: ConfigPatch): AppConfig {
  const { effects, ...rest } = patch
  return { ...config, ...rest, effects: { ...config.effects, ...effects } }
}

async function setConfig(patch: ConfigPatch): Promise<AppConfig> {
  const before = useConfigStore.getState().config
  if (before) useConfigStore.setState({ config: merge(before, patch) })
  try {
    const saved = await invoke('app:setConfig', patch)
    useConfigStore.setState({ config: saved })
    return saved
  } catch (error) {
    if (before) useConfigStore.setState({ config: before })
    throw error
  }
}

/** The app config and its setter. Loads it on first use; the app shell waits for `loaded`. */
export function useConfig(): ConfigApi {
  useEffect(() => retainConfig(), [])
  const config = useConfigStore((state) => state.config)
  return useMemo(
    () => ({ ...(config ?? FALLBACK_CONFIG), loaded: config !== null, set: setConfig }),
    [config],
  )
}
