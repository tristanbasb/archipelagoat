import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { SessionSummary } from '@shared/types'
import { renderApp } from '../render-app'

function fxRoot(): Element {
  const root = document.querySelector('[data-fx-root]')
  if (!root) throw new Error('no fx root')
  return root
}

const SESSIONS: SessionSummary[] = [
  {
    id: 's1',
    name: 'Soirée Zelda',
    status: 'hosting',
    playerCount: 4,
    updatedAt: '2026-10-16T20:00:00.000Z',
    hostingMode: 'local',
  },
]

describe('app shell', () => {
  it('renders each route with its screen heading (stub title) inside the layout', async () => {
    const routes: [route: string, heading: string | RegExp][] = [
      ['/', 'Accueil'],
      ['/doctor', 'Diagnostic'],
      ['/install', 'Installer Archipelago'],
      ['/worlds', 'Mondes'],
      ['/studio', 'Studio YAML'],
      ['/session/new', 'Partie'],
      ['/session/abc?step=3', 'Partie'],
      ['/play/abc', 'Partie en cours'],
      ['/join', 'Rejoindre'],
      ['/vault', 'Émulateurs et ROMs'],
      ['/settings', 'Réglages'],
      ['/dev/gallery', /Arcade néon/],
    ]
    for (const [route, heading] of routes) {
      await renderApp({ route })
      expect(await screen.findByRole('heading', { level: 1, name: heading }), route).toBeInTheDocument()
      const main = screen.getByRole('main')
      expect(within(main).getByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
      expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument()
      expect(screen.getByRole('contentinfo', { name: 'Barre d’état' })).toBeInTheDocument()
      cleanup()
    }
  })

  it('marks the current rail entry and names its shortcut', async () => {
    await renderApp({ route: '/play/abc' })
    const rail = screen.getByRole('navigation', { name: 'Navigation principale' })
    const links = within(rail).getAllByRole('link')
    expect(links).toHaveLength(7)
    const game = within(rail).getByRole('link', { name: 'Partie' })
    expect(game).toHaveAttribute('aria-current', 'page')
    expect(game).toHaveAttribute('aria-keyshortcuts', 'Control+2')
    expect(within(rail).getByRole('link', { name: 'Accueil' })).not.toHaveAttribute('aria-current')
  })

  it('hides /dev/gallery in packaged builds', async () => {
    await renderApp({ route: '/dev/gallery', info: { isPackaged: true } })
    expect(await screen.findByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument()
  })

  it('animations off in config puts fx-no-anim on the fx root', async () => {
    const { goat } = await renderApp({
      config: { effects: { crt: true, glow: true, animations: false, sounds: false } },
    })
    expect(fxRoot()).toHaveClass('fx-no-anim')
    expect(fxRoot()).not.toHaveClass('fx-off')
    expect(fxRoot()).not.toHaveClass('fx-no-crt')

    // A config change from elsewhere (the settings screen) applies at once.
    goat.emit('config:changed', {
      ...goat.config(),
      effects: { crt: false, glow: false, animations: false, sounds: false },
    })
    expect(fxRoot()).toHaveClass('fx-off', 'fx-no-crt', 'fx-no-glow', 'fx-no-anim')
  })

  it('Ctrl+3 navigates to /join', async () => {
    const { user } = await renderApp()
    await user.keyboard('{Control>}3{/Control}')
    expect(await screen.findByRole('heading', { level: 1, name: 'Rejoindre' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/join')

    // An AZERTY keyboard sends "é" for the 2 key: the shortcut follows the physical key.
    fireEvent.keyDown(window, { key: 'é', code: 'Digit2', ctrlKey: true })
    expect(await screen.findByRole('heading', { level: 1, name: 'Partie' })).toBeInTheDocument()
  })

  it('boot screen shows once then sets firstRunDone', async () => {
    const { goat, user } = await renderApp({ config: { firstRunDone: false } })
    const boot = screen.getByRole('dialog', { name: 'Démarrage d’ArchipelaGOAT' })
    expect(within(boot).getByText('Compagnon non officiel pour Archipelago')).toBeInTheDocument()
    expect(within(boot).getByText('PRESS START')).toBeInTheDocument()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(goat.inputsOf('app:setConfig')).toEqual([{ firstRunDone: true }])
    expect(goat.config().firstRunDone).toBe(true)

    cleanup()
    await renderApp({ config: goat.config() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cold-start uri from app:pendingOpenRequests routes to /join?input=', async () => {
    const uri = 'archipelago://Goat:secret@archipelago.gg:38281'
    await renderApp({ handlers: { 'app:pendingOpenRequests': () => [{ kind: 'uri', value: uri }] } })
    expect(await screen.findByRole('heading', { level: 1, name: 'Rejoindre' })).toBeInTheDocument()
    expect(window.location.hash).toBe(`#/join?input=${encodeURIComponent(uri)}`)
  })

  it('routes a file opened from the system while running', async () => {
    const { goat } = await renderApp()
    goat.emit('app:openRequest', { kind: 'file', value: 'C:\\Téléchargements\\celeste.apworld' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Mondes' })).toBeInTheDocument()
    expect(window.location.hash).toBe(
      `#/worlds?install=${encodeURIComponent('C:\\Téléchargements\\celeste.apworld')}`,
    )
  })

  it('asks what to do with an opened zip', async () => {
    const { goat, user } = await renderApp()
    goat.emit('app:openRequest', { kind: 'file', value: 'C:\\seeds\\AP_Factorio_P1.zip' })
    const dialog = await screen.findByRole('dialog', { name: 'Que faire de cette archive ?' })
    await user.click(within(dialog).getByRole('button', { name: 'Rejoindre une partie avec ce fichier' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Rejoindre' })).toBeInTheDocument()
    expect(window.location.hash).toBe(`#/join?input=${encodeURIComponent('C:\\seeds\\AP_Factorio_P1.zip')}`)
  })

  it('imports a yaml dropped on an open session', async () => {
    const { goat } = await renderApp({
      route: '/session/s1',
      handlers: {
        'session:addFiles': ({ paths }) => ({
          session: {} as never,
          ignored: paths.filter((path) => path.includes('broken')),
        }),
      },
    })
    const file = Object.assign(new File(['name: Goat'], 'Goat.yaml'), { path: 'C:\\yamls\\Goat.yaml' })
    fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(await screen.findByText('Dépose ici')).toBeInTheDocument()
    fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [file] } })
    await waitFor(() =>
      expect(goat.inputsOf('session:addFiles')).toEqual([{ id: 's1', paths: ['C:\\yamls\\Goat.yaml'] }]),
    )
    expect(await screen.findByText('Ajouté à la partie : Goat.yaml')).toBeInTheDocument()
    expect(screen.queryByText('Dépose ici')).toBeNull()
  })

  it('QuitConfirm answers app:confirmQuit', async () => {
    const { goat, user } = await renderApp({ handlers: { 'session:list': () => SESSIONS } })
    goat.emit('app:quitRequested', { requestId: 'q1', runningServers: ['s1'], runningTasks: ['generate'] })
    const dialog = await screen.findByRole('dialog', { name: 'Quitter ArchipelaGOAT ?' })
    expect(await within(dialog).findByText('Soirée Zelda')).toBeInTheDocument()
    expect(within(dialog).getByText('Génération de la partie')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Rester' }))
    expect(goat.inputsOf('app:confirmQuit')).toEqual([{ requestId: 'q1', confirm: false }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    goat.emit('app:quitRequested', { requestId: 'q2', runningServers: [], runningTasks: ['ap-install'] })
    const again = await screen.findByRole('dialog', { name: 'Quitter ArchipelaGOAT ?' })
    await user.click(within(again).getByRole('button', { name: 'Quitter quand même' }))
    expect(goat.inputsOf('app:confirmQuit')).toEqual([
      { requestId: 'q1', confirm: false },
      { requestId: 'q2', confirm: true },
    ])
  })

  it('status bar shows the Archipelago version, the server and the running tasks', async () => {
    const { goat } = await renderApp({
      handlers: {
        'ap:detect': () => ({
          kind: 'windows-installer',
          version: '0.6.8',
          root: 'C:\\ProgramData\\Archipelago',
          appImagePath: null,
          paths: {} as never,
        }),
      },
    })
    const bar = screen.getByRole('contentinfo', { name: 'Barre d’état' })
    expect(await within(bar).findByText('AP 0.6.8')).toBeInTheDocument()
    expect(within(bar).getByText('Serveur arrêté')).toBeInTheDocument()

    goat.emit('server:state', {
      sessionId: 's1',
      status: 'ready',
      port: 38281,
      addresses: [],
      startedAt: '2026-10-16T20:00:00.000Z',
      resumedFromSave: false,
      error: null,
    })
    expect(within(bar).getByText('Serveur local :38281')).toBeInTheDocument()

    goat.emit('task:progress', { taskId: 't1', kind: 'generate', stage: 'fill', percent: 42 })
    expect(within(bar).getByText('Génération de la partie')).toBeInTheDocument()
    expect(within(bar).getByText('Placement des objets')).toBeInTheDocument()
    expect(within(bar).getByText('42 %')).toBeInTheDocument()
    goat.emit('task:done', { taskId: 't1', kind: 'generate', result: null })
    expect(within(bar).queryByText('Génération de la partie')).toBeNull()
  })

  it('names the stage of the running task in the status bar, never its raw code', async () => {
    const { goat, user } = await renderApp()
    const bar = screen.getByRole('contentinfo', { name: 'Barre d’état' })

    goat.emit('task:progress', { taskId: 'w1', kind: 'world-prepare', stage: 'download', percent: 10 })
    expect(within(bar).getByText('Analyse d’un monde')).toBeInTheDocument()
    expect(within(bar).getByText('Téléchargement')).toBeInTheDocument()
    goat.emit('task:progress', { taskId: 'w1', kind: 'world-prepare', stage: 'inspect', percent: null })
    expect(within(bar).getByText('Analyse du fichier')).toBeInTheDocument()
    goat.emit('task:done', { taskId: 'w1', kind: 'world-prepare', result: null })

    goat.emit('task:progress', { taskId: 'a1', kind: 'ap-install', stage: 'quarantine', percent: 30 })
    expect(within(bar).getByText('Installation d’Archipelago')).toBeInTheDocument()
    expect(within(bar).getByText('Mise de côté des mondes corrompus')).toBeInTheDocument()
    // A stage without a label shows the task alone.
    goat.emit('task:progress', { taskId: 'a1', kind: 'ap-install', stage: 'mystery-stage', percent: 40 })
    expect(within(bar).queryByText('Mise de côté des mondes corrompus')).toBeNull()
    expect(bar).not.toHaveTextContent('mystery-stage')

    goat.emit('task:progress', { taskId: 'a1', kind: 'ap-install', stage: 'verify', percent: 50 })
    await user.click(within(bar).getByRole('button', { name: 'Langue : français' }))
    expect(await within(bar).findByText('Installing Archipelago')).toBeInTheDocument()
    expect(within(bar).getByText('Checking the checksum')).toBeInTheDocument()
  })

  it('switches the language from the status bar', async () => {
    const { user, goat } = await renderApp()
    const bar = screen.getByRole('contentinfo', { name: 'Barre d’état' })
    await user.click(within(bar).getByRole('button', { name: 'Langue : français' }))
    expect(goat.inputsOf('app:setConfig')).toEqual([{ language: 'en' }])
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('en')
  })
})
