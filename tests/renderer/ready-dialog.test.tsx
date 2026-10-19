import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { AppError } from '@shared/errors'
import type {
  AppConfig,
  CatalogEntry,
  CatalogSnapshot,
  EditorDoc,
  GameProfiles,
  ReadyOutcome,
  ReadyPlan,
  WorldInfo,
  WorldInstallPlan,
} from '@shared/types'
import { isDirty, keptDraft } from '@renderer/features/studio/studio-draft'
import { WorldsScreen } from '@renderer/features/worlds/WorldsScreen'
import { installGoatMock, type GoatHandlers } from './goat-mock'
import { renderWithProviders } from './render-app'

// Testing Library reads a non-breaking space as a plain one in the page text, not in accessible
// names: the names looked for keep the U+00A0 of the French typography, the texts use plain spaces.
const NB = '\u00a0'

const COVER = `goat-cover://${'ef'.repeat(32)}.png`
const SETUP = 'https://archipelago.miraheze.org/wiki/Celeste/Setup'
const FROG_PAGE = 'https://github.com/Rooby-Roo/FrogmonsterAPWorld/releases/latest'
const SAVED = 'C:\\Users\\Joueur\\Documents\\Tristan - Celeste.yaml'
const PICKED = 'C:\\Users\\Joueur\\Téléchargements\\frogmonster.apworld'

function wiki(title: string, setupUrl: string | null = null): NonNullable<CatalogEntry['wiki']> {
  return {
    title,
    url: `https://archipelago.miraheze.org/wiki/${title}`,
    status: 'Stable',
    maintainer: 'maintainer',
    setupUrl,
  }
}

function entry(fields: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'game'>): CatalogEntry {
  return {
    source: 'index',
    displayName: fields.game,
    homepage: null,
    tags: [],
    supported: true,
    afterDark: false,
    requiresRomAtGeneration: false,
    hasPopTracker: false,
    cover: null,
    wiki: null,
    latest: {
      version: '1.0.0',
      url: `https://github.com/example/${fields.id}/releases/download/v1.0.0/${fields.id}.apworld`,
      sha256: 'ab'.repeat(32),
    },
    download: null,
    installedVersion: null,
    trust: 'indexed-verified',
    disabledByIndex: false,
    ...fields,
  }
}

const CELESTE = entry({ id: 'celeste', game: 'Celeste', wiki: wiki('Celeste', SETUP), hasPopTracker: true })
const FROGMONSTER = entry({
  id: 'wiki:Frogmonster',
  game: 'Frogmonster',
  source: 'wiki',
  supported: false,
  wiki: wiki('Frogmonster'),
  latest: null,
  download: { kind: 'github-latest', repo: 'rooby-roo/frogmonsterapworld', pageUrl: FROG_PAGE },
  trust: 'wiki-release',
})
const EMERALD = entry({
  id: 'pokemon_emerald',
  game: 'Pokemon Emerald',
  latest: null,
  installedVersion: '0.6.8',
  requiresRomAtGeneration: true,
  trust: 'core',
})
const SHAPEZ = entry({
  id: 'wiki:Shapez 2',
  game: 'Shapez 2',
  source: 'wiki',
  latest: null,
  download: { kind: 'page', url: 'https://github.com/Jaspersa/Archipelago/releases?q=shapez' },
  trust: 'unknown',
})

const SNAPSHOT: CatalogSnapshot = {
  entries: [CELESTE, FROGMONSTER, EMERALD, SHAPEZ],
  hiddenAfterDark: [],
  fetchedAt: '2026-10-18T08:00:00.000Z',
  stale: false,
  errors: [],
}

const PROFILES: GameProfiles = {
  game: 'Celeste',
  measured: true,
  profiles: [
    {
      id: 'discovery',
      changes: [
        { key: 'goal', from: 'golden_strawberry', to: 'summit' },
        { key: 'trap_percentage', from: 20, to: 0 },
      ],
      checks: null,
      range: null,
    },
    { id: 'standard', changes: [{ key: 'death_link', from: true, to: false }], checks: 203, range: null },
    {
      id: 'complete',
      changes: [{ key: 'berries_required', from: 30, to: 175 }],
      checks: 400,
      range: [380, 420],
    },
  ],
}

function plan(fields: Partial<ReadyPlan> = {}): ReadyPlan {
  return {
    planId: 'plan-1',
    entryId: 'celeste',
    game: 'Celeste',
    apInstalled: true,
    installed: false,
    updateAvailable: false,
    trust: 'indexed-verified',
    needsTrustConsent: false,
    profiles: PROFILES,
    sessions: [
      { id: 's1', name: 'Soirée GOAT' },
      { id: 's2', name: 'Run du dimanche' },
    ],
    notes: { romRequired: false, popTracker: false, setupUrl: null, apRunning: false },
    ...fields,
  }
}

const YAML_TEXT =
  'name: Tristan\ndescription: ArchipelaGOAT · Standard\ngame: Celeste\nCeleste:\n  death_link: false\n'

function outcome(fields: Partial<ReadyOutcome> = {}): ReadyOutcome {
  return {
    game: 'Celeste',
    profile: 'standard',
    checks: 203,
    text: YAML_TEXT,
    delivered: { kind: 'session', sessionId: 's1' },
    playerName: '',
    restartNeeded: false,
    refinementFailed: false,
    ...fields,
  }
}

const DOC: EditorDoc = {
  name: 'Tristan',
  description: 'ArchipelaGOAT · Standard',
  game: 'Celeste',
  requiresVersion: null,
  options: { death_link: { mode: 'value', value: false } },
  extraRoot: {},
}

/** Shows where the app went, to check what the dialog's actions lead to. */
function LocationProbe(): React.JSX.Element {
  const { pathname, search } = useLocation()
  return <output data-testid="location">{`${pathname}${search}`}</output>
}

interface OpenOptions {
  config?: Partial<AppConfig>
  /** The card the dialog is opened from. */
  game?: string
  worlds?: WorldInfo[]
}

/** The worlds screen on the catalog, and « Jeu prêt » opened from the card of `game`. */
async function openReady(handlers: GoatHandlers = {}, options: OpenOptions = {}) {
  const game = options.game ?? 'Celeste'
  const goat = installGoatMock(
    {
      'worlds:list': () => options.worlds ?? [],
      'catalog:list': () => SNAPSHOT,
      'ready:prepare': () => plan(),
      'ready:run': () => ({ taskId: 'r1' }),
      'tasks:cancel': () => undefined,
      ...handlers,
    },
    { config: options.config },
  )
  const rendered = await renderWithProviders(
    <>
      <WorldsScreen />
      <LocationProbe />
    </>,
    { route: '/worlds?tab=catalog' },
  )
  const card = await screen.findByRole('article', { name: game })
  await rendered.user.click(within(card).getByRole('button', { name: `Jeu prêt${NB}: ${game}` }))
  const dialog = await screen.findByRole('dialog', { name: `Jeu prêt${NB}: ${game}` })
  // The plan is in: the main button (or the way to Archipelago) shows.
  await within(dialog).findByRole('button', { name: /Préparer|Installer et préparer|Installer Archipelago/ })
  return { goat, dialog, card, ...rendered }
}

const location = (): string => screen.getByTestId('location').textContent ?? ''

describe('« Jeu prêt » dialog', () => {
  it('opens from a catalog card with cover, name, source and trust', async () => {
    const { goat, dialog } = await openReady({
      'covers:get': ({ game }) => ({ url: game === 'Celeste' ? COVER : null }),
    })

    expect(goat.inputsOf('ready:prepare')).toEqual([{ entryId: 'celeste' }])
    expect(within(dialog).getByRole('heading', { name: `Jeu prêt${NB}: Celeste` })).toBeInTheDocument()
    await waitFor(() => expect(dialog.querySelector('.game-cover img')).toHaveAttribute('src', COVER))
    expect(within(dialog).getByText('Index communautaire')).toBeInTheDocument()
    expect(within(dialog).getByText('Index vérifié')).toBeInTheDocument()
    expect(within(dialog).getByText('v1.0.0')).toBeInTheDocument()

    // Installer stays on the card, for an install without YAML; a world to download by hand has no
    // « Jeu prêt », only its download page.
    const celeste = screen.getByRole('article', { name: 'Celeste' })
    expect(within(celeste).getByRole('button', { name: 'Installer Celeste' })).toBeInTheDocument()
    const shapez = screen.getByRole('article', { name: 'Shapez 2' })
    expect(within(shapez).queryByRole('button', { name: /Jeu prêt/ })).toBeNull()
    expect(
      within(shapez).getByRole('button', { name: 'Page de téléchargement de Shapez 2' }),
    ).toBeInTheDocument()
    // A core world comes with Archipelago: ready at once.
    const emerald = screen.getByRole('article', { name: 'Pokemon Emerald' })
    expect(
      within(emerald).getByRole('button', { name: `Jeu prêt${NB}: Pokemon Emerald` }),
    ).toBeInTheDocument()
  })

  it('opens from an installed row whose game the catalog lists', async () => {
    const emerald: WorldInfo = {
      id: 'w-emerald',
      module: 'pokemon_emerald',
      fileName: 'pokemon_emerald',
      path: 'C:\\ProgramData\\Archipelago\\lib\\worlds\\pokemon_emerald',
      location: 'core',
      game: 'Pokemon Emerald',
      manifest: null,
      states: ['ok'],
      sizeBytes: 1_000,
    }
    const unlisted: WorldInfo = {
      ...emerald,
      id: 'w-mine',
      module: 'my_game',
      game: 'My Game',
      location: 'custom',
    }
    const disabled: WorldInfo = { ...unlisted, id: 'w-off', game: 'Celeste', states: ['disabled'] }
    const goat = installGoatMock({
      'worlds:list': () => [emerald, unlisted, disabled],
      'catalog:list': () => SNAPSHOT,
      'ready:prepare': () =>
        plan({ entryId: 'pokemon_emerald', game: 'Pokemon Emerald', installed: true, trust: 'core' }),
    })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds' })

    // The catalog is not fetched for this tab: every world Archipelago loads offers « Jeu prêt »,
    // the catalog is asked on the click.
    const row = await screen.findByRole('article', { name: 'Pokemon Emerald' })
    const mine = screen.getByRole('article', { name: 'My Game' })
    expect(within(mine).getByRole('button', { name: `Jeu prêt${NB}: My Game` })).toBeInTheDocument()
    expect(
      within(screen.getByRole('article', { name: 'Celeste' })).queryByRole('button', { name: /Jeu prêt/ }),
    ).toBeNull()
    expect(goat.inputsOf('catalog:list')).toEqual([])

    // A world the catalog does not list has nothing to prepare from: said, and its button goes.
    await user.click(within(mine).getByRole('button', { name: `Jeu prêt${NB}: My Game` }))
    expect(await screen.findByText(/My Game n’est pas dans le catalogue/)).toBeInTheDocument()
    await waitFor(() => expect(within(mine).queryByRole('button', { name: /Jeu prêt/ })).toBeNull())
    expect(goat.inputsOf('catalog:list')).toHaveLength(1)
    expect(goat.inputsOf('ready:prepare')).toEqual([])

    await user.click(within(row).getByRole('button', { name: `Jeu prêt${NB}: Pokemon Emerald` }))
    expect(await screen.findByRole('dialog', { name: `Jeu prêt${NB}: Pokemon Emerald` })).toBeInTheDocument()
    expect(goat.inputsOf('ready:prepare')).toEqual([{ entryId: 'pokemon_emerald' }])
    expect(goat.inputsOf('catalog:list')).toHaveLength(1)
  })

  it('an indexed-verified world shows one information line and the main button confirms', async () => {
    const { goat, dialog, user } = await openReady()

    expect(within(dialog).getByText(/empreinte vérifiée/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() =>
      expect(goat.inputsOf('ready:run')).toEqual([
        {
          planId: 'plan-1',
          profile: 'standard',
          playerName: '',
          destination: { kind: 'session', sessionId: 's1' },
          update: false,
          trustAccepted: false,
        },
      ]),
    )
  })

  it('a wiki world shows the full warning and keeps the button disabled until the box is ticked', async () => {
    const { goat, dialog, user } = await openReady(
      {
        'ready:prepare': () =>
          plan({
            entryId: 'wiki:Frogmonster',
            game: 'Frogmonster',
            trust: 'wiki-release',
            needsTrustConsent: true,
            // Not installed yet: no schema, no profile so far (Ruling 26).
            profiles: { game: 'Frogmonster', profiles: [], measured: false },
          }),
      },
      { game: 'Frogmonster' },
    )

    expect(within(dialog).getByText('Release du wiki')).toBeInTheDocument()
    expect(within(dialog).getByText('Un APWorld, c’est du code')).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Installer et préparer' })
    expect(confirm).toBeDisabled()

    // The three profiles are offered all the same, their figures known once installed.
    for (const name of ['Découverte', 'Standard', 'Complet']) {
      expect(within(dialog).getByRole('radio', { name })).toBeInTheDocument()
    }
    expect(within(dialog).getByText(/calculés après l’installation/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('checkbox', { name: 'J’ai compris' }))
    expect(confirm).toBeEnabled()
    await user.click(within(dialog).getByRole('radio', { name: 'Découverte' }))
    await user.click(confirm)
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    expect(goat.inputsOf('ready:run')[0]).toMatchObject({ profile: 'discovery', trustAccepted: true })
  })

  it('a trust that changed before the run asks again with the full warning', async () => {
    let prepared = 0
    const { goat, dialog, user } = await openReady({
      'ready:prepare': () => plan({ planId: `plan-${++prepared}` }),
      'ready:run': ({ planId }) => ({ taskId: planId === 'plan-1' ? 'r1' : 'r2' }),
    })
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    goat.emit('task:failed', {
      taskId: 'r1',
      kind: 'ready',
      error: { code: 'INVALID_INPUT', params: { reason: 'trust' } },
    })

    // Not a failure: a new plan, and the consent this time.
    await waitFor(() => expect(goat.inputsOf('ready:prepare')).toHaveLength(2))
    expect(await within(dialog).findByText(/niveau de confiance de ce monde a changé/)).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Installer et préparer' })
    expect(confirm).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox', { name: 'J’ai compris' }))
    await user.click(confirm)
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(2))
    expect(goat.inputsOf('ready:run')[1]).toMatchObject({ planId: 'plan-2', trustAccepted: true })
  })

  it("the profile segment shows each profile's checks and change list", async () => {
    const { goat, dialog, user } = await openReady()

    const discovery = within(dialog).getByRole('radio', { name: /Découverte/ })
    const standard = within(dialog).getByRole('radio', { name: /Standard/ })
    const complete = within(dialog).getByRole('radio', { name: /Complet/ })
    expect(discovery).toHaveTextContent('non mesuré')
    expect(standard).toHaveTextContent('≈ 203 checks')
    expect(complete).toHaveTextContent('380–420 checks')

    // Standard by default, with what it changes.
    expect(standard).toHaveAttribute('aria-checked', 'true')
    const changes = within(dialog).getByRole('list', { name: 'Changements du profil' })
    expect(within(changes).getByText('death_link : true → false')).toBeInTheDocument()

    await user.click(discovery)
    expect(within(changes).getByText('goal : golden_strawberry → summit')).toBeInTheDocument()
    expect(within(changes).getByText('trap_percentage : 20 → 0')).toBeInTheDocument()
    expect(within(changes).queryByText(/death_link/)).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    expect(goat.inputsOf('ready:run')[0]).toMatchObject({ profile: 'discovery' })
  })

  it('offers the update of an installed world, with its installed version only when it is known', async () => {
    const installedAt = (installedVersion: string): CatalogSnapshot => ({
      ...SNAPSHOT,
      entries: [{ ...CELESTE, installedVersion }, FROGMONSTER, EMERALD, SHAPEZ],
    })
    const behind = { 'ready:prepare': () => plan({ installed: true, updateAvailable: true }) }
    const known = await openReady({ ...behind, 'catalog:list': () => installedAt('0.9.0') })
    expect(
      within(known.dialog).getByRole('switch', { name: 'Installer d’abord la version 1.0.0' }),
    ).toHaveAccessibleDescription('Tu as la version 0.9.0.')
    cleanup()

    // A world without a version in its manifest: nothing to tell.
    const { dialog } = await openReady({ ...behind, 'catalog:list': () => installedAt('unknown') })
    const update = within(dialog).getByRole('switch', { name: 'Installer d’abord la version 1.0.0' })
    expect(update).not.toHaveAccessibleDescription()
    expect(within(dialog).queryByText(/Tu as la version/)).toBeNull()
  })

  it('the player name is prefilled from the settings', async () => {
    const { goat, dialog, user } = await openReady({}, { config: { playerName: 'Tristan' } })

    const name = within(dialog).getByRole('textbox', { name: 'Nom du joueur' })
    expect(name).toHaveValue('Tristan')
    expect(name).toHaveAttribute('maxlength', '16')
    await user.clear(name)
    await user.type(name, 'Madeline')
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    expect(goat.inputsOf('ready:run')[0]).toMatchObject({ playerName: 'Madeline' })

    // Remembered once the YAML is delivered.
    expect(goat.inputsOf('app:setConfig')).toEqual([])
    goat.emit('task:done', { taskId: 'r1', kind: 'ready', result: outcome({ playerName: 'Madeline' }) })
    await waitFor(() =>
      expect(goat.inputsOf('app:setConfig')).toEqual([
        { playerName: 'Madeline', readyDestination: 'session' },
      ]),
    )
    // Added under the name asked for: nothing more to say.
    expect(await within(dialog).findByText('Ajouté à la session « Soirée GOAT ».')).toBeInTheDocument()
    expect(within(dialog).queryByText(/Ajouté sous le nom/)).toBeNull()
  })

  it('the destination defaults to the last one; "Nouvelle session" asks for a name', async () => {
    const { goat, dialog, user } = await openReady({}, { config: { readyDestination: 'studio' } })

    expect(within(dialog).getByRole('radio', { name: 'Studio' })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(dialog).getByRole('radio', { name: 'Session' }))
    // The latest session being prepared, else a new one.
    const session = within(dialog).getByRole('combobox', { name: 'Session' })
    expect(session).toHaveValue('s1')
    await user.selectOptions(session, within(session).getByRole('option', { name: 'Nouvelle session…' }))

    const name = within(dialog).getByRole('textbox', { name: 'Nom de la nouvelle session' })
    await user.clear(name)
    const confirm = within(dialog).getByRole('button', { name: 'Installer et préparer' })
    expect(confirm).toBeDisabled()
    await user.type(name, 'Soirée du jeudi')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    expect(goat.inputsOf('ready:run')[0]).toMatchObject({
      destination: { kind: 'new-session', name: 'Soirée du jeudi' },
    })
  })

  it('the file destination asks app:savePath before ready:run', async () => {
    let answer: string | null = null
    const { goat, dialog, user } = await openReady(
      { 'app:savePath': () => answer, 'app:openPath': () => undefined },
      { config: { readyDestination: 'file', playerName: 'Tristan' } },
    )

    expect(within(dialog).getByRole('radio', { name: 'Fichier' })).toHaveAttribute('aria-checked', 'true')
    const confirm = within(dialog).getByRole('button', { name: 'Installer et préparer' })
    // Cancelled: nothing runs.
    await user.click(confirm)
    await waitFor(() => expect(goat.inputsOf('app:savePath')).toHaveLength(1))
    expect(goat.inputsOf('app:savePath')[0]).toEqual({
      defaultName: 'Tristan - Celeste.yaml',
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    })
    await waitFor(() => expect(confirm).toBeEnabled())
    expect(goat.inputsOf('ready:run')).toEqual([])

    answer = SAVED
    await user.click(confirm)
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    expect(goat.inputsOf('ready:run')[0]).toMatchObject({ destination: { kind: 'file', path: SAVED } })
    const order = goat.calls
      .map((call) => call.channel)
      .filter((channel) => channel === 'app:savePath' || channel === 'ready:run')
    expect(order).toEqual(['app:savePath', 'app:savePath', 'ready:run'])

    // Ready: the folder of the file opens, and the file opens in the Studio.
    goat.emit('task:done', {
      taskId: 'r1',
      kind: 'ready',
      result: outcome({ delivered: { kind: 'file', path: SAVED }, playerName: 'Tristan' }),
    })
    expect(await within(dialog).findByText(SAVED)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Ouvrir le dossier' }))
    await waitFor(() =>
      expect(goat.inputsOf('app:openPath')).toEqual([{ path: 'C:\\Users\\Joueur\\Documents' }]),
    )
    await user.click(within(dialog).getByRole('button', { name: 'Ouvrir dans le Studio' }))
    await waitFor(() => expect(location()).toBe(`/studio?${new URLSearchParams({ open: SAVED }).toString()}`))
  })

  it('Arrêter stops the run and gives the choices back', async () => {
    let runs = 0
    const { goat, dialog, user } = await openReady({ 'ready:run': () => ({ taskId: `r${++runs}` }) })
    await user.click(within(dialog).getByRole('radio', { name: /Complet/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Arrêter' }))
    await waitFor(() => expect(goat.inputsOf('tasks:cancel')).toEqual([{ taskId: 'r1' }]))

    goat.emit('task:failed', { taskId: 'r1', kind: 'ready', error: { code: 'TASK_CANCELLED' } })
    const confirm = await within(dialog).findByRole('button', { name: 'Installer et préparer' })
    expect(within(dialog).getByRole('radio', { name: /Complet/ })).toHaveAttribute('aria-checked', 'true')
    // The same plan, which goes on from where it stopped.
    await user.click(confirm)
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(2))
    expect(goat.inputsOf('ready:run')[1]).toMatchObject({ planId: 'plan-1', profile: 'complete' })
  })

  it('progress shows the task stage; the end screen says "Prêt !" with actions and the À savoir notes (ROM requise, PopTracker, guide, redémarrer AP)', async () => {
    const { goat, dialog, user } = await openReady({
      'ready:prepare': () =>
        plan({ notes: { romRequired: true, popTracker: true, setupUrl: SETUP, apRunning: false } }),
      'app:openExternal': () => undefined,
    })
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))

    goat.emit('task:progress', { taskId: 'r1', kind: 'ready', stage: 'templates', percent: null })
    expect(
      await within(dialog).findByRole('progressbar', { name: 'Génération des templates' }),
    ).toBeInTheDocument()
    // Stopped, not closed, while it runs: its end shows here.
    expect(within(dialog).getByRole('button', { name: 'Arrêter' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Fermer la fenêtre' })).toBeNull()

    goat.emit('task:done', { taskId: 'r1', kind: 'ready', result: outcome({ restartNeeded: true }) })
    expect(await within(dialog).findByRole('heading', { name: `Prêt${NB}!` })).toBeInTheDocument()
    expect(within(dialog).getByText('Standard · ≈ 203 checks')).toBeInTheDocument()
    expect(within(dialog).getByText('Ajouté à la session « Soirée GOAT ».')).toBeInTheDocument()

    const notes = within(dialog).getByRole('region', { name: 'À savoir' })
    expect(within(notes).getByText('ROM requise')).toBeInTheDocument()
    expect(within(notes).getByRole('button', { name: 'Ouvrir le coffre' })).toBeInTheDocument()
    expect(within(notes).getByText('PopTracker disponible')).toBeInTheDocument()
    expect(within(notes).getByText('Guide d’installation')).toBeInTheDocument()
    expect(within(notes).getByText('Redémarre Archipelago')).toBeInTheDocument()
    await user.click(within(notes).getByRole('button', { name: 'Ouvrir le guide' }))
    await waitFor(() => expect(goat.inputsOf('app:openExternal')).toEqual([{ url: SETUP }]))

    await user.click(within(dialog).getByRole('button', { name: 'Ouvrir la session' }))
    await waitFor(() => expect(location()).toBe('/session/s1?step=1'))
  })

  it('the profile step shows the measures of the refinement it waits for; one that failed is said on the end screen', async () => {
    const { goat, dialog, user } = await openReady()
    await user.click(within(dialog).getByRole('radio', { name: /Découverte/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toMatchObject([{ profile: 'discovery' }]))

    goat.emit('task:progress', {
      taskId: 'r1',
      kind: 'ready',
      stage: 'profile',
      percent: 40,
      detail: { done: 8, total: 20 },
    })
    const bar = await within(dialog).findByRole('progressbar', {
      name: `Affinage du profil${NB}: 8/20 mesures`,
    })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    // Then the YAML is written and measured.
    goat.emit('task:progress', { taskId: 'r1', kind: 'ready', stage: 'profile', percent: null })
    expect(
      await within(dialog).findByRole('progressbar', { name: 'Écriture du YAML et mesure des checks' }),
    ).toBeInTheDocument()

    goat.emit('task:done', {
      taskId: 'r1',
      kind: 'ready',
      result: outcome({ profile: 'discovery', checks: 8, refinementFailed: true }),
    })
    expect(await within(dialog).findByRole('heading', { name: `Prêt${NB}!` })).toBeInTheDocument()
    const notes = within(dialog).getByRole('region', { name: 'À savoir' })
    expect(within(notes).getByText('Estimation non affinée')).toBeInTheDocument()
    expect(
      within(notes).getByText(
        'Celeste n’a pas pu être mesuré : ce profil Découverte est choisi d’après le seul nom de ses options, sans garantie sur son nombre de checks.',
      ),
    ).toBeInTheDocument()
  })

  it('the end screen says the name the YAML was added as when the session had that player already', async () => {
    const { goat, dialog, user } = await openReady({}, { config: { playerName: 'Tristan' } })
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))

    goat.emit('task:done', { taskId: 'r1', kind: 'ready', result: outcome({ playerName: 'Tristan2' }) })
    expect(await within(dialog).findByRole('heading', { name: `Prêt${NB}!` })).toBeInTheDocument()
    expect(within(dialog).getByText('Ajouté à la session « Soirée GOAT ».')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Ajouté sous le nom « Tristan2 » : « Tristan » était déjà pris dans cette session.',
      ),
    ).toBeInTheDocument()
  })

  it('Studio destination loads the YAML in the Studio draft and navigates to /studio', async () => {
    const { goat, dialog, user } = await openReady(
      { 'studio:parse': () => ({ docs: [DOC], issues: [] }) },
      { config: { readyDestination: 'studio' } },
    )
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    expect(goat.inputsOf('ready:run')[0]).toMatchObject({ destination: { kind: 'studio' } })

    goat.emit('task:done', {
      taskId: 'r1',
      kind: 'ready',
      result: outcome({ delivered: { kind: 'studio' } }),
    })
    await waitFor(() => expect(location()).toBe('/studio'))
    expect(goat.inputsOf('studio:parse')).toEqual([{ text: YAML_TEXT }])
    expect(keptDraft().docs).toEqual([DOC])
    expect(keptDraft().source).toEqual({ kind: 'new' })
    // Saved nowhere yet (Ruling 29): the Studio asks before anything replaces it.
    expect(isDirty(keptDraft())).toBe(true)
  })

  it('a failure shows the translated error and Réessayer runs the same plan again', async () => {
    let runs = 0
    const { goat, dialog, user } = await openReady({ 'ready:run': () => ({ taskId: `r${++runs}` }) })
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))

    goat.emit('task:failed', {
      taskId: 'r1',
      kind: 'ready',
      error: { code: 'AP_YAML_INVALID', detail: 'OPTION_UNKNOWN at Celeste.goal' },
    })
    expect(await within(dialog).findByText('Archipelago refuse un YAML')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(2))
    const [first, second] = goat.inputsOf('ready:run')
    expect(second).toEqual(first)
    expect(goat.inputsOf('ready:prepare')).toHaveLength(1)
    expect(await within(dialog).findByRole('button', { name: 'Arrêter' })).toBeInTheDocument()
  })

  it('keyboard focus stays in the dialog from step to step, and lands on « Prêt ! »', async () => {
    let runs = 0
    const { goat, dialog, user } = await openReady({ 'ready:run': () => ({ taskId: `r${++runs}` }) })
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await within(dialog).findByRole('button', { name: 'Arrêter' })
    // The main button gave way to the run: focus is on its heading, not on the page behind.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('heading', { name: 'Préparation en cours' }),
      ),
    )
    await user.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)

    // A failure: focus on it (an alert), Réessayer reachable from there.
    goat.emit('task:failed', { taskId: 'r1', kind: 'ready', error: { code: 'AP_YAML_INVALID' } })
    const alert = await within(dialog).findByRole('alert')
    await waitFor(() => expect(document.activeElement).toContainElement(alert))
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await user.click(within(dialog).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(2))

    goat.emit('task:done', { taskId: 'r2', kind: 'ready', result: outcome() })
    const ready = await within(dialog).findByRole('heading', { name: `Prêt${NB}!` })
    await waitFor(() => expect(ready).toHaveFocus())
  })

  it('an expired plan is made again and run with the same choices', async () => {
    let prepared = 0
    const { goat, dialog, user } = await openReady({
      'ready:prepare': () => plan({ planId: `plan-${++prepared}` }),
      'ready:run': ({ planId }) => ({ taskId: planId === 'plan-1' ? 'r1' : 'r2' }),
    })
    await user.click(within(dialog).getByRole('radio', { name: /Complet/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))

    // Left open past the hour a plan lives: main no longer knows it.
    goat.emit('task:failed', { taskId: 'r1', kind: 'ready', error: { code: 'NOT_FOUND', detail: 'plan-1' } })
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(2))
    expect(goat.inputsOf('ready:prepare')).toHaveLength(2)
    const [first, second] = goat.inputsOf('ready:run')
    expect(second).toEqual({ ...first, planId: 'plan-2' })
    expect(await within(dialog).findByRole('button', { name: 'Arrêter' })).toBeInTheDocument()
  })

  it('an expired plan whose new one needs a consent not given asks for it', async () => {
    let prepared = 0
    const { goat, dialog, user } = await openReady({
      // The catalog tells another tier by the time the plan is made again.
      'ready:prepare': () =>
        ++prepared === 1
          ? plan({ planId: 'plan-1' })
          : plan({ planId: 'plan-2', trust: 'wiki-release', needsTrustConsent: true }),
    })
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    goat.emit('task:failed', { taskId: 'r1', kind: 'ready', error: { code: 'NOT_FOUND', detail: 'plan-1' } })

    await waitFor(() => expect(goat.inputsOf('ready:prepare')).toHaveLength(2))
    const box = await within(dialog).findByRole('checkbox', { name: 'J’ai compris' })
    const confirm = within(dialog).getByRole('button', { name: 'Installer et préparer' })
    expect(confirm).toBeDisabled()
    expect(goat.inputsOf('ready:run')).toHaveLength(1)
    await user.click(box)
    await user.click(confirm)
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(2))
    expect(goat.inputsOf('ready:run')[1]).toMatchObject({ planId: 'plan-2', trustAccepted: true })
  })

  it('a release the catalog cannot fetch keeps « Ouvrir la page » and « Choisir le fichier »', async () => {
    let prepared = 0
    const installed: WorldInfo = {
      id: 'w-frog',
      module: 'frogmonster',
      fileName: 'frogmonster.apworld',
      path: 'C:\\ProgramData\\Archipelago\\custom_worlds\\frogmonster.apworld',
      location: 'custom',
      game: 'Frogmonster',
      manifest: null,
      states: ['ok'],
      sizeBytes: 1_000,
    }
    const filePlan: WorldInstallPlan = {
      planId: 'install-1',
      source: { kind: 'file', path: PICKED },
      module: 'frogmonster',
      targetFileName: 'frogmonster.apworld',
      manifest: null,
      sha256: 'cd'.repeat(32),
      trust: 'unknown',
      homepage: null,
      origin: null,
      conflicts: [],
      warnings: [],
    }
    const { goat, dialog, user } = await openReady(
      {
        'ready:prepare': () =>
          plan({
            planId: `plan-${++prepared}`,
            entryId: 'wiki:Frogmonster',
            game: 'Frogmonster',
            trust: 'wiki-release',
            needsTrustConsent: true,
            installed: prepared > 1,
          }),
        'ready:run': ({ planId }) => ({ taskId: planId === 'plan-1' ? 'r1' : 'r2' }),
        'app:openExternal': () => undefined,
        'app:pickPaths': () => [PICKED],
        'worlds:prepareInstall': () => ({ taskId: 'w1' }),
        'worlds:confirmInstall': () => ({ world: installed, restartNeeded: false }),
      },
      { game: 'Frogmonster' },
    )
    await user.click(within(dialog).getByRole('checkbox', { name: 'J’ai compris' }))
    await user.click(within(dialog).getByRole('button', { name: 'Installer et préparer' }))
    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(1))
    goat.emit('task:failed', {
      taskId: 'r1',
      kind: 'ready',
      error: { code: 'WORLD_RELEASE_UNAVAILABLE', params: { url: FROG_PAGE } },
    })

    expect(await within(dialog).findByText('Aucune version de ce monde à installer')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Ouvrir la page de téléchargement' }))
    await waitFor(() => expect(goat.inputsOf('app:openExternal')).toEqual([{ url: FROG_PAGE }]))

    // The file downloaded by hand goes through the trust screen, then the same choices run again.
    await user.click(within(dialog).getByRole('button', { name: 'Choisir le fichier .apworld' }))
    await waitFor(() =>
      expect(goat.inputsOf('worlds:prepareInstall')).toEqual([{ source: { kind: 'file', path: PICKED } }]),
    )
    goat.emit('task:done', { taskId: 'w1', kind: 'world-prepare', result: filePlan })
    const trust = await screen.findByRole('dialog', { name: `Installer frogmonster${NB}?` })
    await user.click(within(trust).getByRole('checkbox', { name: 'J’ai compris' }))
    await user.click(within(trust).getByRole('button', { name: 'Installer' }))

    await waitFor(() => expect(goat.inputsOf('ready:run')).toHaveLength(2))
    expect(goat.inputsOf('ready:prepare')).toHaveLength(2)
    expect(goat.inputsOf('ready:run')[1]).toMatchObject({ planId: 'plan-2', profile: 'standard' })
  })

  it('without Archipelago the dialog links to the install screen', async () => {
    const { dialog, user } = await openReady({ 'ready:prepare': () => plan({ apInstalled: false }) })

    expect(within(dialog).getByText('Archipelago n’est pas installé')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Préparer|Installer et préparer/ })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Installer Archipelago' }))
    await waitFor(() => expect(location()).toBe('/install'))
  })

  it('a plan that cannot be made says why', async () => {
    installGoatMock({
      'worlds:list': () => [],
      'catalog:list': () => SNAPSHOT,
      'ready:prepare': () => {
        throw new AppError('NOT_FOUND', undefined, { detail: 'celeste' })
      },
    })
    const { user } = await renderWithProviders(<WorldsScreen />, { route: '/worlds?tab=catalog' })
    const card = await screen.findByRole('article', { name: 'Celeste' })
    await user.click(within(card).getByRole('button', { name: `Jeu prêt${NB}: Celeste` }))
    const dialog = await screen.findByRole('dialog', { name: `Jeu prêt${NB}: Celeste` })
    expect(await within(dialog).findByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})
