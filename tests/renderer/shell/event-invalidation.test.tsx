import { act, screen, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import type { ApInstall, CatalogSnapshot, WorldInfo } from '@shared/types'
import { invoke } from '@renderer/lib/goat'
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

const COVER = `goat-cover://${'ab'.repeat(32)}.png`
const CRYSTAL: WorldInfo = {
  id: 'w-crystal',
  module: 'pokemon_crystal',
  fileName: 'pokemon_crystal.apworld',
  path: `${AP_ROOT}\\custom_worlds\\pokemon_crystal.apworld`,
  location: 'custom',
  game: 'Pokemon Crystal',
  manifest: null,
  states: ['ok'],
  sizeBytes: 1_000,
}
const CATALOG: CatalogSnapshot = { entries: [], fetchedAt: null, stale: false, errors: [] }

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

  it('checks:changed refreshes the estimates of the cards and the profiles of the games', async () => {
    const { goat, queryClient } = await renderApp({ route: '/settings', handlers: { 'ap:detect': () => AP } })
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    const invalidated = recordInvalidations(queryClient)

    goat.emit('checks:changed', null)
    expect(invalidated).toEqual(['checks:estimate', 'profiles:get'])
  })

  it('a finished generation or measure refreshes the last checks of the sessions, whatever the screen', async () => {
    const { goat, queryClient } = await renderApp({ route: '/settings', handlers: { 'ap:detect': () => AP } })
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    const invalidated = recordInvalidations(queryClient)

    // A generation read the counts from its multidata; a measure, which the check step may have been
    // left during, wrote them.
    goat.emit('task:done', { taskId: 'g1', kind: 'generate', result: null })
    expect(invalidated).toEqual(['checks:lastSession'])
    goat.emit('task:done', { taskId: 'm1', kind: 'measure', result: null })
    expect(invalidated).toEqual(['checks:lastSession', 'checks:lastSession'])

    // Any other task ending leaves them as they are.
    goat.emit('task:done', { taskId: 'i1', kind: 'ap-install', result: null })
    expect(invalidated).toEqual(['checks:lastSession', 'checks:lastSession'])
  })

  it('server:state refreshes the sessions: a server that starts or ends makes its game live or over', async () => {
    const { goat, queryClient } = await renderApp({ route: '/settings', handlers: { 'ap:detect': () => AP } })
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    const invalidated = recordInvalidations(queryClient)

    goat.emit('server:state', {
      sessionId: 's1',
      status: 'stopped',
      port: 38281,
      addresses: [],
      startedAt: '2026-10-17T18:00:00.000Z',
      resumedFromSave: false,
      error: null,
    })
    expect(invalidated.sort()).toEqual(['session:get', 'session:list'])
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

describe('covers made stale by what main answers them from', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The Worlds screen, whose installed row asks for its cover: main answers null until `ready()`. */
  async function openWorldsWithoutCover() {
    let available = false
    const rendered = await renderApp({
      route: '/worlds',
      handlers: {
        'ap:detect': () => AP,
        'worlds:list': () => [CRYSTAL],
        'covers:get': () => ({ url: available ? COVER : null }),
      },
    })
    const row = await screen.findByRole('article', { name: 'Pokemon Crystal' })
    await waitFor(() => expect(rendered.goat.inputsOf('covers:get')).toHaveLength(1))
    expect(row.querySelector('img')).toBeNull()
    return { ...rendered, row, ready: () => (available = true) }
  }

  it('a catalog that resolves makes the games ask for their cover again', async () => {
    const { queryClient, row, ready } = await openWorldsWithoutCover()

    ready()
    act(() => {
      queryClient.setQueryData(['catalog:list', {}], CATALOG)
    })
    await waitFor(() => expect(row.querySelector('.game-cover img')).toHaveAttribute('src', COVER))
  })

  it('a catalog that fails to load does not', async () => {
    const { goat, queryClient } = await openWorldsWithoutCover()
    const invalidated = recordInvalidations(queryClient)

    await expect(
      queryClient.fetchQuery({ queryKey: ['catalog:list', {}], queryFn: () => invoke('catalog:list', {}) }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    expect(invalidated).toEqual([])
    expect(goat.inputsOf('covers:get')).toHaveLength(1)
  })

  it('After Dark switched on makes the games ask for their cover again', async () => {
    const { goat, row, ready } = await openWorldsWithoutCover()

    ready()
    goat.emit('config:changed', { ...goat.config(), showAfterDark: true })
    await waitFor(() => expect(row.querySelector('.game-cover img')).toHaveAttribute('src', COVER))
    expect(goat.inputsOf('covers:get')).toHaveLength(2)
  })

  it('another setting changing does not', async () => {
    const { goat, queryClient } = await openWorldsWithoutCover()
    const invalidated = recordInvalidations(queryClient)

    goat.emit('config:changed', { ...goat.config(), desktopIcons: false })
    await act(async () => {})
    expect(invalidated).toEqual([])
    expect(goat.inputsOf('covers:get')).toHaveLength(1)
  })
})
