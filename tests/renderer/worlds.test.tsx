import { screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { AppError } from '@shared/errors'
import type { CatalogEntry, CatalogSnapshot, WorldInfo, WorldManifest } from '@shared/types'
import { WorldsScreen } from '@renderer/features/worlds/WorldsScreen'
import { installGoatMock } from './goat-mock'
import { renderApp, renderWithProviders } from './render-app'

const CUSTOM_DIR = 'C:\\ProgramData\\Archipelago\\custom_worlds'
const CORE_DIR = 'C:\\ProgramData\\Archipelago\\lib\\worlds'
const DISABLED_DIR = 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\disabled-worlds'
const DOWNLOADED_A = 'C:\\Users\\Joueur\\Téléchargements\\pokemon_crystal.apworld'
const DOWNLOADED_B = 'C:\\Users\\Joueur\\Téléchargements\\celeste & co.apworld'

function manifest(game: string, worldVersion: string | null): WorldManifest {
  return {
    game,
    worldVersion,
    minimumApVersion: '0.6.2',
    maximumApVersion: null,
    authors: ['someone'],
    version: 7,
    compatibleVersion: 7,
  }
}

function world(fields: Partial<WorldInfo> & Pick<WorldInfo, 'id' | 'module'>): WorldInfo {
  return {
    fileName: `${fields.module}.apworld`,
    path: `${CUSTOM_DIR}\\${fields.module}.apworld`,
    location: 'custom',
    game: null,
    manifest: null,
    states: ['ok'],
    sizeBytes: 250_000,
    ...fields,
  }
}

const CRYSTAL = world({
  id: 'w-crystal',
  module: 'pokemon_crystal',
  game: 'Pokemon Crystal',
  manifest: manifest('Pokemon Crystal', '3.1.0'),
  sizeBytes: 1_234_567,
})
const CELESTE = world({
  id: 'w-celeste',
  module: 'celeste',
  game: 'Celeste',
  manifest: manifest('Celeste', '2.0.0'),
  location: 'disabled',
  path: `${DISABLED_DIR}\\celeste.apworld`,
  states: ['disabled'],
})
const ALTTP = world({
  id: 'w-alttp',
  module: 'alttp',
  fileName: 'alttp',
  path: `${CORE_DIR}\\alttp`,
  game: 'A Link to the Past',
  location: 'core',
  states: ['ok', 'core-loose'],
})

const WORLDS: WorldInfo[] = [
  CRYSTAL,
  world({ id: 'w-hk', module: 'hk', game: 'Hollow Knight', states: ['no-manifest'] }),
  world({ id: 'w-broken', module: 'broken_world', states: ['corrupt'] }),
  world({
    id: 'w-sm64-old',
    module: 'sm64ex_old',
    game: 'Super Mario 64',
    manifest: manifest('Super Mario 64', '1.0.0'),
    states: ['shadowed'],
  }),
  CELESTE,
  ALTTP,
]

function entry(fields: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'game'>): CatalogEntry {
  return {
    displayName: fields.game,
    homepage: `https://github.com/example/${fields.id}`,
    tags: [],
    supported: true,
    afterDark: false,
    requiresRomAtGeneration: false,
    hasPopTracker: false,
    wiki: null,
    latest: {
      version: '1.0.0',
      url: `https://github.com/example/${fields.id}/releases/download/v1.0.0/${fields.id}.apworld`,
      sha256: 'ab'.repeat(32),
    },
    installedVersion: null,
    trust: 'indexed-verified',
    ...fields,
  }
}

function wiki(title: string, status: string | null): NonNullable<CatalogEntry['wiki']> {
  return {
    title,
    url: `https://archipelago.miraheze.org/wiki/${title.replaceAll(' ', '_')}`,
    status,
    maintainer: 'maintainer',
    setupUrl: null,
  }
}

const ENTRIES: CatalogEntry[] = [
  entry({
    id: 'celeste',
    game: 'Celeste',
    tags: ['platformer'],
    hasPopTracker: true,
    wiki: wiki('Celeste', 'Stable'),
  }),
  entry({
    id: 'hollow_knight',
    game: 'Hollow Knight',
    tags: ['metroidvania'],
    installedVersion: '0.4.0',
    latest: { version: '0.5.0', url: 'https://github.com/example/hk/releases/download/v0.5.0/hk.apworld', sha256: null },
    wiki: wiki('Hollow Knight', 'Unstable'),
    trust: 'wiki-release',
  }),
  entry({ id: 'pokemon_emerald', game: 'Pokemon Emerald', requiresRomAtGeneration: true, trust: 'core' }),
  entry({ id: 'huniepop', game: 'HuniePop', afterDark: true, tags: ['ad'] }),
]

const SNAPSHOT: CatalogSnapshot = {
  entries: ENTRIES,
  fetchedAt: '2026-10-17T12:00:00.000Z',
  stale: false,
  errors: [],
}

/** Shows the current query string, to check what the screen leaves in the URL. */
function LocationProbe(): React.JSX.Element {
  const { search } = useLocation()
  return <output data-testid="search">{search}</output>
}

async function openCatalog(user: { click: (element: Element) => Promise<void> }): Promise<HTMLElement> {
  await user.click(await screen.findByRole('tab', { name: /^Catalogue/ }))
  return screen.findByRole('list', { name: 'Mondes du catalogue' })
}

describe('WorldsScreen', () => {
  it('shows state badges (no-manifest, corrupt, shadowed) with tooltips', async () => {
    installGoatMock({ 'worlds:list': () => WORLDS })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds' })

    const hk = await screen.findByRole('article', { name: 'Hollow Knight' })
    const noManifest = within(hk).getByText('Sans manifeste')
    await user.hover(noManifest)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Archipelago 0\.7/)
    await user.unhover(noManifest)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())

    // No game name without a manifest: the module names the world.
    const broken = screen.getByRole('article', { name: 'broken_world' })
    const corrupt = within(broken).getByText('Corrompu')
    await user.hover(corrupt)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/refuse de démarrer/)
    await user.unhover(corrupt)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())

    const sm64 = screen.getByRole('article', { name: 'Super Mario 64' })
    const shadowed = within(sm64).getByText('Masqué')
    await user.hover(shadowed)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/ignore ce fichier/)
    await user.unhover(shadowed)

    // The badges are reachable from the keyboard too.
    expect(shadowed.closest('[tabindex="0"]')).not.toBeNull()
    expect(within(screen.getByRole('article', { name: 'Celeste' })).getByText('Désactivé')).toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: 'A Link to the Past' })).getByText('Intégré')).toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: 'Pokemon Crystal' })).getByText('3.1.0')).toBeInTheDocument()

    // A corrupt world blocks Archipelago: the screen says so, and filters on it.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Un monde cassé bloque Archipelago')
    await user.click(within(alert).getByRole('button', { name: 'Voir les mondes corrompus' }))
    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'Ajoutés par toi' })).getAllByRole('article')).toHaveLength(1),
    )
    expect(screen.getByRole('article', { name: 'broken_world' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Filtrer par état' })).toHaveValue('corrupt')
  })

  it('filters the installed worlds by search, state and origin', async () => {
    installGoatMock({ 'worlds:list': () => WORLDS })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds' })
    const list = await screen.findByRole('list', { name: 'Ajoutés par toi' })
    expect(within(list).getAllByRole('article')).toHaveLength(5)
    expect(screen.getByRole('list', { name: 'Livrés avec Archipelago' })).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Rechercher un monde installé' }), 'pokémon')
    await waitFor(() => expect(within(list).getAllByRole('article')).toHaveLength(1))
    expect(within(list).getByRole('article', { name: 'Pokemon Crystal' })).toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: 'Rechercher un monde installé' }))

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrer par état' }), 'no-manifest')
    await waitFor(() => expect(within(list).getAllByRole('article')).toHaveLength(1))
    expect(within(list).getByRole('article', { name: 'Hollow Knight' })).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrer par état' }), 'all')

    await user.click(screen.getByRole('radio', { name: 'Officiels' }))
    expect(screen.queryByRole('list', { name: 'Ajoutés par toi' })).toBeNull()
    expect(screen.getByRole('article', { name: 'A Link to the Past' })).toBeInTheDocument()
  })

  it('opens the folder, disables, re-enables and removes custom worlds', async () => {
    const goat = installGoatMock({
      'worlds:list': () => WORLDS,
      'worlds:setEnabled': ({ worldId, enabled }) => ({
        ...(WORLDS.find((item) => item.id === worldId) as WorldInfo),
        location: enabled ? 'custom' : 'disabled',
      }),
      'worlds:remove': () => undefined,
      'app:openPath': () => undefined,
    })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds' })

    const crystal = await screen.findByRole('article', { name: 'Pokemon Crystal' })
    await user.click(within(crystal).getByRole('button', { name: 'Ouvrir le dossier de Pokemon Crystal' }))
    await waitFor(() => expect(goat.inputsOf('app:openPath')).toEqual([{ path: CUSTOM_DIR }]))

    await user.click(within(crystal).getByRole('button', { name: 'Désactiver Pokemon Crystal' }))
    await waitFor(() =>
      expect(goat.inputsOf('worlds:setEnabled')).toEqual([{ worldId: 'w-crystal', enabled: false }]),
    )
    expect(await screen.findByText('Pokemon Crystal est désactivé')).toBeInTheDocument()

    const celeste = screen.getByRole('article', { name: 'Celeste' })
    await user.click(within(celeste).getByRole('button', { name: 'Réactiver Celeste' }))
    await waitFor(() =>
      expect(goat.inputsOf('worlds:setEnabled')).toEqual([
        { worldId: 'w-crystal', enabled: false },
        { worldId: 'w-celeste', enabled: true },
      ]),
    )

    // Removing asks first.
    await user.click(within(crystal).getByRole('button', { name: 'Supprimer Pokemon Crystal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Supprimer Pokemon Crystal\u00a0?' })
    expect(dialog).toHaveTextContent('pokemon_crystal.apworld')
    expect(goat.inputsOf('worlds:remove')).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Supprimer' }))
    await waitFor(() => expect(goat.inputsOf('worlds:remove')).toEqual([{ worldId: 'w-crystal' }]))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText('Pokemon Crystal est supprimé')).toBeInTheDocument()
    // Each change reloads the list.
    expect(goat.inputsOf('worlds:list').length).toBeGreaterThanOrEqual(4)

    // A world shipped with Archipelago can only be looked at.
    const alttp = screen.getByRole('article', { name: 'A Link to the Past' })
    expect(within(alttp).getByRole('button', { name: 'Ouvrir le dossier de A Link to the Past' })).toBeInTheDocument()
    expect(within(alttp).queryByRole('button', { name: /Désactiver|Supprimer/ })).toBeNull()
  })

  it('offers no folder to open for the core worlds of an AppImage', async () => {
    // Inside an AppImage, Archipelago's folder is the image's mount: the inventory gives no path.
    const mounted = { ...ALTTP, id: 'w-alttp-appimage', path: '' }
    installGoatMock({ 'worlds:list': () => [CRYSTAL, mounted] })
    await renderWithProviders(<WorldsScreen />, { route: '/worlds' })

    const alttp = await screen.findByRole('article', { name: 'A Link to the Past' })
    expect(within(alttp).queryByRole('button')).toBeNull()
    const crystal = screen.getByRole('article', { name: 'Pokemon Crystal' })
    expect(within(crystal).getByRole('button', { name: 'Ouvrir le dossier de Pokemon Crystal' })).toBeInTheDocument()
  })

  it('reloads the worlds when the main process announces a change', async () => {
    let worlds: WorldInfo[] = [CRYSTAL]
    const { goat } = await renderApp({ route: '/worlds', handlers: { 'worlds:list': () => worlds } })
    await screen.findByRole('article', { name: 'Pokemon Crystal' })
    expect(screen.queryByRole('article', { name: 'Celeste' })).toBeNull()

    // A world added outside the app (or by another window): worlds:changed says so.
    worlds = [CRYSTAL, CELESTE]
    goat.emit('worlds:changed', null)
    expect(await screen.findByRole('article', { name: 'Celeste' })).toBeInTheDocument()
  })

  it('shows the error with its fix when the worlds cannot be listed', async () => {
    let calls = 0
    installGoatMock({
      'worlds:list': () => {
        calls += 1
        throw new AppError('AP_NOT_INSTALLED')
      },
    })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds' })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Archipelago n’est pas installé')
    expect(within(alert).getByRole('button', { name: 'Installer Archipelago' })).toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(calls).toBe(2))
  })

  it('offers the catalog when no world was added yet', async () => {
    const goat = installGoatMock({ 'worlds:list': () => [ALTTP], 'catalog:list': () => SNAPSHOT })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds' })
    expect(await screen.findByText('Aucun monde ajouté pour l’instant')).toBeInTheDocument()
    expect(goat.inputsOf('catalog:list')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Parcourir le catalogue' }))
    expect(await screen.findByRole('tab', { name: /^Catalogue/, selected: true })).toBeInTheDocument()
    expect(await screen.findByRole('list', { name: 'Mondes du catalogue' })).toBeInTheDocument()
  })

  it('install from catalog starts useWorldInstall with the catalog source', async () => {
    const goat = installGoatMock({
      'worlds:list': () => WORLDS,
      'catalog:list': () => SNAPSHOT,
      'worlds:prepareInstall': () => ({ taskId: 't1' }),
    })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds' })
    await openCatalog(user)

    // Already installed: an update when the catalog has a newer version.
    const hk = screen.getByRole('article', { name: 'Hollow Knight' })
    expect(within(hk).getByRole('button', { name: 'Mettre à jour Hollow Knight' })).toBeInTheDocument()
    expect(within(hk).getByText('0.4.0 → 0.5.0')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Catalogue pas à jour' })).toBeNull()

    const celeste = screen.getByRole('article', { name: 'Celeste' })
    expect(within(celeste).getByText('Stable')).toBeInTheDocument()
    expect(within(celeste).getByText('Index vérifié')).toBeInTheDocument()
    await user.click(within(celeste).getByRole('button', { name: 'Installer Celeste' }))
    await waitFor(() =>
      expect(goat.inputsOf('worlds:prepareInstall')).toEqual([{ source: { kind: 'catalog', id: 'celeste' } }]),
    )
    expect(await screen.findByRole('dialog')).toHaveTextContent('Analyse du monde…')
  })

  it('?install=<path> starts a file install', async () => {
    let next = 0
    const goat = installGoatMock({
      'worlds:list': () => WORLDS,
      'worlds:prepareInstall': () => ({ taskId: `t${++next}` }),
      'tasks:cancel': () => undefined,
    })
    const query = [DOWNLOADED_A, DOWNLOADED_B].map((path) => `install=${encodeURIComponent(path)}`).join('&')
    const { user } = await renderWithProviders(
      <>
        <WorldsScreen />
        <LocationProbe />
      </>,
      { route: `/worlds?${query}` },
    )

    await waitFor(() =>
      expect(goat.inputsOf('worlds:prepareInstall')).toEqual([{ source: { kind: 'file', path: DOWNLOADED_A } }]),
    )
    expect(await screen.findByText('1 en attente')).toBeInTheDocument()
    expect(screen.getByTestId('search').textContent).toBe(`?${query}`)

    // One after the other: the second file waits for the first.
    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    await waitFor(() =>
      expect(goat.inputsOf('worlds:prepareInstall')).toEqual([
        { source: { kind: 'file', path: DOWNLOADED_A } },
        { source: { kind: 'file', path: DOWNLOADED_B } },
      ]),
    )

    // Both settled: the requests leave the URL, and nothing starts them again.
    await user.click(await screen.findByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(goat.inputsOf('worlds:prepareInstall')).toHaveLength(2)
  })

  it('installs the .apworld files picked from the disk', async () => {
    const goat = installGoatMock({
      'worlds:list': () => WORLDS,
      'app:pickPaths': () => [DOWNLOADED_A],
      'worlds:prepareInstall': () => ({ taskId: 't1' }),
    })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds' })
    await user.click(await screen.findByRole('button', { name: 'Installer un fichier…' }))
    await waitFor(() =>
      expect(goat.inputsOf('worlds:prepareInstall')).toEqual([{ source: { kind: 'file', path: DOWNLOADED_A } }]),
    )
    expect(goat.inputsOf('app:pickPaths')).toEqual([
      { mode: 'files', title: 'Choisir des APWorlds', filters: [{ name: 'APWorld', extensions: ['apworld'] }] },
    ])
  })

  it('filters catalog by search and hides after dark by default', async () => {
    installGoatMock({ 'worlds:list': () => WORLDS, 'catalog:list': () => SNAPSHOT })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds?tab=catalog' })
    const grid = await screen.findByRole('list', { name: 'Mondes du catalogue' })
    expect(within(grid).getAllByRole('article')).toHaveLength(3)
    expect(screen.queryByText('HuniePop')).toBeNull()
    expect(screen.queryByRole('button', { name: '18+' })).toBeNull()
    expect(screen.getByText('3 mondes')).toBeInTheDocument()

    const search = screen.getByRole('searchbox', { name: 'Rechercher dans le catalogue' })
    await user.type(search, 'hollow')
    await waitFor(() => expect(within(grid).getAllByRole('article')).toHaveLength(1))
    expect(within(grid).getByRole('article', { name: 'Hollow Knight' })).toBeInTheDocument()
    expect(screen.getByText('1 monde')).toBeInTheDocument()

    // Nothing left: an empty state that clears the filters.
    await user.type(search, 'zzz')
    expect(await screen.findByText('Aucun monde ne correspond')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Effacer les filtres' }))
    await waitFor(() => expect(within(grid).getAllByRole('article')).toHaveLength(3))
    expect(search).toHaveValue('')

    await user.selectOptions(screen.getByRole('combobox', { name: 'ROM' }), 'needed')
    await waitFor(() => expect(within(grid).getAllByRole('article')).toHaveLength(1))
    expect(within(grid).getByRole('article', { name: 'Pokemon Emerald' })).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'ROM' }), 'any')

    await user.click(screen.getByRole('button', { name: 'Mises à jour' }))
    await waitFor(() => expect(within(grid).getAllByRole('article')).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Mises à jour' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(grid).getByRole('article', { name: 'Hollow Knight' })).toBeInTheDocument()

    // The wiki is credited under its license.
    expect(screen.getByText(/CC BY-NC-SA 4\.0/)).toBeInTheDocument()
  })

  it('shows after dark worlds and their filter once enabled in the settings', async () => {
    installGoatMock(
      { 'worlds:list': () => WORLDS, 'catalog:list': () => SNAPSHOT },
      { config: { showAfterDark: true } },
    )
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds?tab=catalog' })
    const grid = await screen.findByRole('list', { name: 'Mondes du catalogue' })
    await waitFor(() => expect(within(grid).getAllByRole('article')).toHaveLength(4))
    await user.click(screen.getByRole('button', { name: '18+' }))
    await waitFor(() => expect(within(grid).getAllByRole('article')).toHaveLength(1))
    expect(within(grid).getByRole('article', { name: 'HuniePop' })).toBeInTheDocument()
  })

  it('shows stale banner when snapshot stale', async () => {
    const goat = installGoatMock({
      'worlds:list': () => WORLDS,
      'catalog:list': ({ force }) =>
        force
          ? SNAPSHOT
          : { ...SNAPSHOT, stale: true, fetchedAt: '2026-10-15T12:00:00.000Z', errors: ['GITHUB_RATE_LIMITED'] },
    })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds?tab=catalog' })

    const banner = await screen.findByRole('region', { name: 'Catalogue pas à jour' })
    expect(banner).toHaveTextContent('GitHub limite les requêtes')
    expect(banner).toHaveTextContent(/15 oct\. 2026/)
    // The cached copy stays usable.
    expect(within(screen.getByRole('list', { name: 'Mondes du catalogue' })).getAllByRole('article')).toHaveLength(3)

    await user.click(within(banner).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(goat.inputsOf('catalog:list')).toEqual([{}, { force: true }]))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Catalogue pas à jour' })).toBeNull())
  })
})
