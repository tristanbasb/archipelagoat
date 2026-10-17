import { screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { AppError } from '@shared/errors'
import type { Address, Hosting, Rules, ServerEvent, ServerState, Session, Slot, WebRoom } from '@shared/types'
import { LiveGameScreen } from '@renderer/features/host/LiveGameScreen'
import { installGoatMock, type GoatHandlers } from './goat-mock'
import { renderWithProviders } from './render-app'

const WORKSPACE = 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\sessions\\s1'
const ALICE_DIR = `${WORKSPACE}\\output\\slots\\P1_Alice`

const RULES: Rules = {
  preset: 'casual',
  spoiler: 3,
  race: false,
  hintCost: 10,
  locationCheckPoints: 1,
  releaseMode: 'auto',
  collectMode: 'auto',
  remainingMode: 'goal',
  countdownMode: 'auto',
  itemCheat: false,
  autoShutdown: 0,
  plando: [],
  compatibility: 2,
}

const SLOTS: Slot[] = [
  { slot: 1, name: 'Alice', game: 'A Link to the Past', patchFile: `${ALICE_DIR}\\AP_42_P1_Alice.aplttp` },
  {
    slot: 2,
    name: 'Bob',
    game: 'Super Metroid',
    patchFile: `${WORKSPACE}\\output\\slots\\P2_Bob\\AP_42_P2_Bob.apsm`,
  },
  { slot: 3, name: 'Carol', game: 'Clique', patchFile: null },
]

function session(hosting: Hosting | null): Session {
  return {
    id: 's1',
    name: 'Soirée Zelda',
    createdAt: '2026-10-17T18:00:00.000Z',
    updatedAt: '2026-10-17T19:00:00.000Z',
    status: hosting ? 'hosting' : 'generated',
    players: [],
    rules: RULES,
    hasPassword: true,
    hasServerPassword: false,
    generation: {
      seedName: '42',
      zipPath: `${WORKSPACE}\\output\\AP_42.zip`,
      spoilerName: null,
      slots: SLOTS,
      durationS: 12,
      logPath: `${WORKSPACE}\\logs\\generate.txt`,
    },
    hosting,
    workspace: WORKSPACE,
  }
}

const LOCAL = session({ mode: 'local', port: 38281, savefile: `${WORKSPACE}\\output\\AP_42.apsave` })
const WEB = session({
  mode: 'web',
  seedId: 'seed1',
  roomId: 'room1',
  roomUrl: 'https://archipelago.gg/room/room1',
  port: 38281,
})

const ADDRESSES: Address[] = [
  { kind: 'localhost', host: 'localhost', port: 38281 },
  { kind: 'lan', host: '192.168.1.20', port: 38281 },
  { kind: 'public', host: '82.64.1.2', port: 38281 },
]

function serverState(patch: Partial<ServerState> = {}): ServerState {
  return {
    sessionId: 's1',
    status: 'ready',
    port: 38281,
    addresses: ADDRESSES,
    startedAt: '2026-10-17T19:04:00.000Z',
    resumedFromSave: false,
    error: null,
    ...patch,
  }
}

function room(patch: Partial<WebRoom> = {}): WebRoom {
  return {
    roomId: 'room1',
    seedId: 'seed1',
    roomUrl: 'https://archipelago.gg/room/room1',
    host: 'archipelago.gg',
    port: 38281,
    lastActivity: null,
    timeoutS: 7200,
    players: SLOTS.map(({ name, game }) => ({ name, game })),
    downloads: [{ slot: 1, url: 'https://archipelago.gg/dl_patch/room1/1' }],
    trackerUrl: null,
    ...patch,
  }
}

function event(kind: ServerEvent['kind'], fields: Partial<ServerEvent> = {}): ServerEvent {
  return { ts: '2026-10-17T19:10:00.000Z', kind, text: `${kind} line`, ...fields }
}

async function renderLive(handlers: GoatHandlers) {
  const goat = installGoatMock({
    'session:getSecrets': () => ({ password: 'hunter2', serverPassword: null }),
    'server:history': () => ({ events: [], log: [] }),
    ...handlers,
  })
  const view = await renderWithProviders(
    <Routes>
      <Route path="/play/:sessionId" element={<LiveGameScreen />} />
      <Route path="/doctor" element={<p>Écran diagnostic</p>} />
    </Routes>,
    { route: '/play/s1' },
  )
  return { goat, ...view }
}

/** The row of a player in the players panel. */
function playerRow(name: string): HTMLElement {
  const panel = screen.getByRole('region', { name: 'Joueurs' })
  const row = within(panel).getByText(name).closest('li')
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

describe('LiveGameScreen', () => {
  it('local: shows ready state and addresses from server:state event', async () => {
    const { goat } = await renderLive({
      'session:get': () => LOCAL,
      'server:get': () => serverState({ status: 'starting', addresses: [] }),
    })
    expect(await screen.findByText('Démarrage du serveur…')).toBeInTheDocument()
    expect(screen.getByText('Le serveur démarre, les adresses arrivent…')).toBeInTheDocument()
    // Not up yet: no "up since".
    expect(screen.getByText('Soirée Zelda · serveur local')).toBeInTheDocument()

    // Another session's server is none of this screen's business.
    goat.emit('server:state', serverState({ sessionId: 'other', status: 'crashed' }))
    expect(screen.getByText('Démarrage du serveur…')).toBeInTheDocument()

    goat.emit('server:state', serverState())
    expect(await screen.findByText('Serveur prêt')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Réseau local' })).toHaveTextContent('192.168.1.20:38281')
    expect(screen.getByRole('group', { name: 'Internet' })).toHaveTextContent('82.64.1.2:38281')
    expect(screen.getByText(/redirige le port 38281 \(TCP\) vers ce PC/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Sur ce PC' })).toHaveTextContent('localhost:38281')
    expect(goat.inputsOf('server:get')).toEqual([{ sessionId: 's1' }])
  })

  it('local: rebuilds feed from server:history on mount and shows resumed banner', async () => {
    const { goat } = await renderLive({
      'session:get': () => LOCAL,
      'server:get': () => serverState({ resumedFromSave: true }),
      'server:history': () => ({
        events: [
          event('join', { player: 'Alice' }),
          event('join', { player: 'Bob' }),
          event('item', { player: 'Alice', receiver: 'Bob', item: 'Hookshot', location: 'Link’s House' }),
          event('goal', { player: 'Bob' }),
        ],
        log: ['Hosting game at 0.0.0.0:38281 (No password)', 'server listening on 0.0.0.0:38281'],
      }),
    })
    expect(
      await screen.findByText('Partie reprise depuis la sauvegarde : ses options priment'),
    ).toBeInTheDocument()

    const feed = screen.getByRole('log', { name: 'Flux d’objets' })
    await waitFor(() => expect(feed).toHaveTextContent('Alice a envoyé Hookshot à Bob (Link’s House)'))
    expect(feed).toHaveTextContent('Bob a atteint son objectif')
    const console = screen.getByRole('log', { name: 'Console du serveur' })
    expect(console).toHaveTextContent('server listening on 0.0.0.0:38281')
    expect(goat.inputsOf('server:history')).toEqual([{ sessionId: 's1' }])

    expect(playerRow('Alice')).toHaveTextContent('En ligne')
    expect(playerRow('Bob')).toHaveTextContent('But atteint')
    expect(playerRow('Carol')).toHaveTextContent('Absent')
    expect(screen.getByText('2/3 en ligne')).toBeInTheDocument()

    // Then the live events update it.
    goat.emit('server:event', { sessionId: 's1', event: event('leave', { player: 'Alice' }) })
    await waitFor(() => expect(playerRow('Alice')).toHaveTextContent('Absent'))
    expect(feed).toHaveTextContent('Alice a quitté la partie')
    goat.emit('server:log', { sessionId: 's1', line: 'Notice (all): Alice (Team #1) has left the game.' })
    await waitFor(() => expect(console).toHaveTextContent('Alice (Team #1) has left the game.'))
    goat.emit('server:log', { sessionId: 'other', line: 'not ours' })
    expect(console).not.toHaveTextContent('not ours')
  })

  it('feed renders item event with sender, item and receiver', async () => {
    const { goat } = await renderLive({ 'session:get': () => LOCAL, 'server:get': () => serverState() })
    const feed = await screen.findByRole('log', { name: 'Flux d’objets' })
    await within(feed).findByText('En attente des premiers événements…')

    goat.emit('server:event', {
      sessionId: 's1',
      event: event('item', {
        player: 'Alice',
        receiver: 'Bob',
        item: 'Hookshot',
        location: 'Kakariko Well - Top',
        ts: '2026-10-17T19:12:34.000Z',
      }),
    })
    const line = await within(feed).findByText(/Hookshot/)
    expect(line).toHaveTextContent(
      /^\[\d\d:\d\d:\d\d\] Alice a envoyé Hookshot à Bob \(Kakariko Well - Top\)$/,
    )
    // The server log does not say the item class: the line keeps the plain tone.
    expect(line).toHaveAttribute('data-tone', 'default')
    expect(within(feed).queryByText('En attente des premiers événements…')).not.toBeInTheDocument()

    goat.emit('server:event', {
      sessionId: 's1',
      event: event('item', { player: 'Bob', receiver: 'Bob', item: 'Morph Ball', location: 'Brinstar' }),
    })
    await waitFor(() => expect(feed).toHaveTextContent('Bob a trouvé son objet Morph Ball (Brinstar)'))

    // What the host types in the console reaches everyone as [Server]: that is "yourself".
    goat.emit('server:event', {
      sessionId: 's1',
      event: event('chat', { player: '[Server]', text: 'Notice (all): [Server]: on y va' }),
    })
    expect(await within(feed).findByText(/on y va/)).toHaveAttribute('data-tone', 'self')
    expect(feed).toHaveTextContent('[Server] : on y va')
  })

  it('console sends command and keeps history', async () => {
    const { goat, user } = await renderLive({
      'session:get': () => LOCAL,
      'server:get': () => serverState(),
      'server:command': () => undefined,
    })
    const input = await screen.findByRole('textbox', { name: 'Commande du serveur' })
    await user.type(input, '/players{Enter}')
    await waitFor(() =>
      expect(goat.inputsOf('server:command')).toEqual([{ sessionId: 's1', command: '/players' }]),
    )
    const console = screen.getByRole('log', { name: 'Console du serveur' })
    expect(console).toHaveTextContent('› /players')

    await user.click(screen.getByRole('button', { name: '/save' }))
    await waitFor(() => expect(goat.inputsOf('server:command')).toHaveLength(2))
    expect(goat.inputsOf('server:command')[1]).toEqual({ sessionId: 's1', command: '/save' })

    await user.click(input)
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('/save')
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('/players')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(input).toHaveValue('')

    // /release needs a player: a dialog asks which one.
    await user.click(screen.getByRole('button', { name: '/release…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Libérer les objets d’un joueur' })
    const confirm = within(dialog).getByRole('button', { name: 'Libérer' })
    expect(confirm).toBeDisabled()
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Joueur' }), 'Bob')
    await user.click(confirm)
    await waitFor(() =>
      expect(goat.inputsOf('server:command').at(-1)).toEqual({ sessionId: 's1', command: '/release Bob' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('console shows a refused command as an error line', async () => {
    const { user } = await renderLive({
      'session:get': () => LOCAL,
      'server:get': () => serverState(),
      'server:command': () => {
        throw new AppError('NOT_FOUND')
      },
    })
    const input = await screen.findByRole('textbox', { name: 'Commande du serveur' })
    await user.type(input, '/status{Enter}')
    const console = screen.getByRole('log', { name: 'Console du serveur' })
    const line = await within(console).findByText(/Commande refusée/)
    expect(line).toHaveTextContent('Commande refusée : Introuvable')
    expect(line).toHaveAttribute('data-tone', 'error')
  })

  it('stops the server only after confirmation', async () => {
    const { goat, user } = await renderLive({
      'session:get': () => LOCAL,
      'server:get': () => serverState(),
      'server:stop': () => undefined,
    })
    await user.click(await screen.findByRole('button', { name: 'Arrêter le serveur' }))
    let dialog = await screen.findByRole('dialog', { name: 'Arrêter le serveur\u00a0?' })
    await user.click(within(dialog).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(goat.inputsOf('server:stop')).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Arrêter le serveur' }))
    dialog = await screen.findByRole('dialog', { name: 'Arrêter le serveur\u00a0?' })
    // A server that does not answer is stopped by force after 15 s (spec §3.11).
    expect(dialog).toHaveTextContent('Sans réponse sous 15 s, il est arrêté de force')
    await user.click(within(dialog).getByRole('button', { name: 'Arrêter' }))
    await waitFor(() => expect(goat.inputsOf('server:stop')).toEqual([{ sessionId: 's1' }]))
    goat.emit('server:state', serverState({ status: 'stopped' }))
    // A clean stop: no warning about lost progress.
    expect(screen.queryByText(/a été arrêté de force/)).not.toBeInTheDocument()
    expect(await screen.findByText('Le serveur est arrêté')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Relancer depuis l’assistant' })).toBeInTheDocument()
  })

  it('shows a crash with its translated cause and the screen that fixes it', async () => {
    const { user } = await renderLive({
      'session:get': () => LOCAL,
      'server:get': () => serverState({ status: 'crashed', error: { code: 'PORT_IN_USE' } }),
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Le port est déjà utilisé')
    expect(screen.getByText('Serveur planté')).toBeInTheDocument()
    // No orphan server to stop here: only the ways out.
    expect(within(alert).queryByRole('button', { name: 'Arrêter le serveur' })).not.toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Ouvrir le diagnostic' }))
    expect(await screen.findByText('Écran diagnostic')).toBeInTheDocument()
  })

  it('says a server that crashed while running stopped unexpectedly, not that it failed to start', async () => {
    await renderLive({
      'session:get': () => LOCAL,
      'server:get': () =>
        serverState({
          status: 'crashed',
          error: { code: 'SERVER_START_FAILED', params: { phase: 'running' }, detail: 'exit code 1' },
        }),
    })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Le serveur s’est arrêté de façon inattendue')).toBeInTheDocument()
    expect(alert).not.toHaveTextContent('n’a pas pu démarrer')
    expect(within(alert).getByText(/reprend à sa dernière sauvegarde/)).toBeInTheDocument()
    expect(within(alert).getByRole('button', { name: 'Relancer depuis l’assistant' })).toBeInTheDocument()
  })

  it('offers to stop the orphan server a previous run left behind', async () => {
    const { goat, user } = await renderLive({
      'session:get': () => LOCAL,
      'server:get': () =>
        serverState({
          status: 'crashed',
          error: { code: 'SERVER_START_FAILED', params: { orphanPid: 4242, phase: 'orphan' } },
        }),
      'server:stop': () => undefined,
    })
    const alert = await screen.findByRole('alert')
    // It still runs and serves its players: not a failed start, and its addresses stay on screen.
    expect(within(alert).getByText('Le serveur d’une session précédente tourne encore')).toBeInTheDocument()
    expect(alert).not.toHaveTextContent('n’a pas pu démarrer')
    expect(within(alert).queryByRole('button', { name: 'Relancer depuis l’assistant' })).toBeNull()
    expect(screen.getByText('Serveur d’une session précédente')).toBeInTheDocument()
    expect(screen.getByText('192.168.1.20:38281')).toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Arrêter le serveur' }))
    const dialog = await screen.findByRole('dialog', { name: 'Arrêter le serveur\u00a0?' })
    await user.click(within(dialog).getByRole('button', { name: 'Arrêter' }))
    await waitFor(() => expect(goat.inputsOf('server:stop')).toEqual([{ sessionId: 's1' }]))
  })

  it('a stopped server has nobody online, keeps the goals and warns after a forced stop', async () => {
    await renderLive({
      'session:get': () => LOCAL,
      'server:get': () => serverState({ status: 'stopped', error: { code: 'PROCESS_TIMEOUT' } }),
      'server:history': () => ({
        events: [
          event('join', { player: 'Alice' }),
          event('join', { player: 'Bob' }),
          event('goal', { player: 'Bob' }),
        ],
        log: [],
      }),
    })
    expect(await screen.findByText('Le serveur est arrêté')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Le serveur ne répondait plus : il a été arrêté de force et la dernière minute de jeu a pu être perdue.',
      ),
    ).toBeInTheDocument()
    await waitFor(() => expect(playerRow('Bob')).toHaveTextContent('But atteint'))
    expect(playerRow('Alice')).toHaveTextContent('Absent')
    expect(playerRow('Bob')).toHaveTextContent('Absent')
    expect(screen.getByText('0/3 en ligne')).toBeInTheDocument()
    // Not running: no "up since" and nothing to stop.
    expect(screen.queryByText(/en ligne depuis/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Arrêter le serveur' })).not.toBeInTheDocument()
  })

  it('reads the password through session:getSecrets and keeps it masked', async () => {
    const { goat, user } = await renderLive({ 'session:get': () => LOCAL, 'server:get': () => serverState() })
    const field = await screen.findByRole('group', { name: 'Mot de passe de la partie' })
    await waitFor(() => expect(goat.inputsOf('session:getSecrets')).toEqual([{ id: 's1' }]))
    expect(screen.queryByText(/hunter2/)).not.toBeInTheDocument()
    await user.click(within(field).getByRole('button', { name: 'Afficher le mot de passe' }))
    expect(field).toHaveTextContent('hunter2')
  })

  it('copies the share message, with the password only when included', async () => {
    const { user } = await renderLive({ 'session:get': () => LOCAL, 'server:get': () => serverState() })
    const share = await screen.findByRole('region', { name: 'Message à partager' })
    await waitFor(() => expect(share).toHaveTextContent('Adresse (réseau local) : 192.168.1.20:38281'))
    await user.click(within(share).getByRole('button', { name: 'Copier le message' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toContain('192.168.1.20:38281'))
    expect(await navigator.clipboard.readText()).not.toContain('hunter2')

    await user.click(within(share).getByRole('switch', { name: 'Inclure le mot de passe' }))
    // The preview never shows the password itself.
    expect(share).toHaveTextContent('Mot de passe : ••••••••')
    expect(share).not.toHaveTextContent('hunter2')
    await user.click(within(share).getByRole('button', { name: /Copier le message|Copié/ }))
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain('Mot de passe\u00a0: hunter2'),
    )
  })

  it('slot files open the slot folder and copy its path', async () => {
    const { goat, user } = await renderLive({
      'session:get': () => LOCAL,
      'server:get': () => serverState(),
      'app:openPath': () => undefined,
    })
    const files = await screen.findByRole('region', { name: 'Fichiers des joueurs' })
    expect(files).toHaveTextContent('AP_42_P1_Alice.aplttp')
    await user.click(within(files).getByRole('button', { name: 'Ouvrir le dossier du slot Alice' }))
    await waitFor(() => expect(goat.inputsOf('app:openPath')).toEqual([{ path: ALICE_DIR }]))
    await user.click(within(files).getByRole('button', { name: 'Copier le chemin du slot Alice' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(ALICE_DIR))
    // Carol's game connects without a file.
    expect(within(files).queryByRole('button', { name: /slot Carol/ })).not.toBeInTheDocument()
  })

  it('sends a session that is not hosted back to the wizard', async () => {
    await renderLive({ 'session:get': () => session(null) })
    expect(await screen.findByText('Cette partie n’est pas hébergée')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ouvrir l’assistant' })).toBeInTheDocument()
  })

  it('shows why the game cannot be read', async () => {
    await renderLive({
      'session:get': () => {
        throw new AppError('NOT_FOUND')
      },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Introuvable')
    expect(screen.getByRole('heading', { level: 1, name: 'Partie en cours' })).toBeInTheDocument()
  })

  it('web: wake updates port display', async () => {
    // Idle for longer than its timeout: archipelago.gg put the room to sleep, its last port kept.
    const idle = new Date(Date.now() - 3 * 3600_000).toISOString()
    const { goat, user } = await renderLive({
      'session:get': () => WEB,
      'webhost:room': () => room({ port: 38281, lastActivity: idle, timeoutS: 7200 }),
      'webhost:wake': () => room({ port: 52011, lastActivity: new Date().toISOString() }),
      'webhost:log': () => ({ text: '', nextByte: 0 }),
    })
    const address = await screen.findByRole('group', { name: 'Adresse du serveur' })
    await waitFor(() => expect(address).toHaveTextContent('archipelago.gg:38281'))
    expect(screen.getByRole('group', { name: 'Lien de la room' })).toHaveTextContent(
      'https://archipelago.gg/room/room1',
    )
    expect(screen.getByText('Room endormie')).toBeInTheDocument()
    expect(screen.getByText(/réveille-la avant de jouer, son port peut changer/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Réveiller la room' }))
    await waitFor(() => expect(address).toHaveTextContent('archipelago.gg:52011'))
    expect(goat.inputsOf('webhost:wake')).toEqual([{ roomId: 'room1' }])
    expect(screen.getByText('Room éveillée')).toBeInTheDocument()
    expect(screen.queryByText(/son port peut changer/)).not.toBeInTheDocument()
  })

  it('web: archipelago.gg out of reach keeps what the session knows', async () => {
    await renderLive({
      'session:get': () => WEB,
      'webhost:room': () => {
        throw new AppError('WEBHOST_UNAVAILABLE')
      },
      'webhost:log': () => ({ text: '', nextByte: 0 }),
    })
    expect(
      await screen.findByText('L’état de la room est indisponible : archipelago.gg est indisponible'),
    ).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Adresse du serveur' })).toHaveTextContent(
      'archipelago.gg:38281',
    )
    // Whether the room is awake, only archipelago.gg can say.
    expect(screen.queryByText(/Room (éveillée|endormie)/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Réveiller la room' })).toBeEnabled()
  })

  it('web: follows the room log, sends remote commands and opens the room as owner', async () => {
    const { goat, user } = await renderLive({
      'session:get': () => WEB,
      'webhost:room': () => room(),
      'webhost:log': ({ fromByte }) =>
        fromByte === 0
          ? { text: 'Hosting game at archipelago.gg:38281\nNotice (all): Alice', nextByte: 50 }
          : { text: '', nextByte: fromByte },
      'webhost:command': () => undefined,
      'webhost:openAsOwner': () => undefined,
    })
    const console = await screen.findByRole('log', { name: 'Console de la room' })
    await waitFor(() => expect(console).toHaveTextContent('Hosting game at archipelago.gg:38281'))
    expect(goat.inputsOf('webhost:log')[0]).toEqual({ roomId: 'room1', fromByte: 0 })

    await user.type(screen.getByRole('textbox', { name: 'Commande du serveur' }), '/players{Enter}')
    await waitFor(() =>
      expect(goat.inputsOf('webhost:command')).toEqual([{ roomId: 'room1', command: '/players' }]),
    )

    await user.click(screen.getByRole('button', { name: 'Ouvrir en tant que propriétaire' }))
    await waitFor(() => expect(goat.inputsOf('webhost:openAsOwner')).toEqual([{ roomId: 'room1' }]))

    // The download link of each slot's patch can be shared.
    const files = screen.getByRole('region', { name: 'Fichiers des joueurs' })
    await user.click(
      within(files).getByRole('button', { name: 'Copier le lien de téléchargement du slot Alice' }),
    )
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('https://archipelago.gg/dl_patch/room1/1'),
    )
  })
})
