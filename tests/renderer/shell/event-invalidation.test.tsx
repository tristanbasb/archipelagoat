import { screen, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import type { ApInstall } from '@shared/types'
import { renderApp } from '../render-app'

const AP_ROOT = 'C:\\ProgramData\\Archipelago'

const AP: ApInstall = {
  kind: 'windows-installer',
  version: '0.6.8',
  root: AP_ROOT,
  appImagePath: null,
  paths: {
    localPath: AP_ROOT,
    userPath: AP_ROOT,
    customWorlds: `${AP_ROOT}\\custom_worlds`,
    coreWorlds: `${AP_ROOT}\\lib\\worlds`,
    players: `${AP_ROOT}\\Players`,
    templates: `${AP_ROOT}\\Players\\Templates`,
    output: `${AP_ROOT}\\output`,
    logs: `${AP_ROOT}\\logs`,
    cache: `${AP_ROOT}\\cache`,
    settingsFile: `${AP_ROOT}\\host.yaml`,
  },
}

/** The channels invalidated from now on, one entry per invalidateQueries call. */
function recordInvalidations(queryClient: QueryClient): string[] {
  const channels: string[] = []
  const original = queryClient.invalidateQueries.bind(queryClient)
  vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((filters, options) => {
    channels.push(String(filters?.queryKey?.[0]))
    return original(filters, options)
  })
  return channels
}

describe('query invalidation on main-process events', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ap:installed refreshes the install, the release, the worlds, the health check, the studio games and BizHawk once each', async () => {
    let install: ApInstall | null = null
    const { goat, queryClient } = await renderApp({
      handlers: { 'ap:detect': () => install, 'doctor:run': () => [] },
    })
    await screen.findByRole('button', { name: /INSERT COIN/ })
    const invalidated = recordInvalidations(queryClient)

    install = AP
    goat.emit('ap:installed', AP)
    await waitFor(() => expect(screen.queryByRole('button', { name: /INSERT COIN/ })).toBeNull())
    expect(invalidated.sort()).toEqual(
      ['ap:detect', 'ap:latestRelease', 'bizhawk:state', 'doctor:run', 'studio:games', 'worlds:list'].sort(),
    )
  })

  it('worlds:changed refreshes the worlds, the health check, the studio games and the catalog once each', async () => {
    // Away from the home: the shell does it whatever the screen.
    const { goat, queryClient } = await renderApp({
      route: '/settings',
      handlers: { 'ap:detect': () => AP, 'doctor:run': () => [] },
    })
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    const invalidated = recordInvalidations(queryClient)

    goat.emit('worlds:changed', null)
    expect(invalidated.sort()).toEqual(['catalog:list', 'doctor:run', 'studio:games', 'worlds:list'].sort())
  })

  it('ap:installed is handled the same on any screen', async () => {
    const { goat, queryClient } = await renderApp({ route: '/settings', handlers: { 'ap:detect': () => AP } })
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    const invalidated = recordInvalidations(queryClient)

    goat.emit('ap:installed', AP)
    expect(invalidated.sort()).toEqual(
      ['ap:detect', 'ap:latestRelease', 'bizhawk:state', 'doctor:run', 'studio:games', 'worlds:list'].sort(),
    )
  })
})
