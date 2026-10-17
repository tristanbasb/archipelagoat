import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { AppError } from '@shared/errors'
import { RULE_PRESETS, defaultRules } from '@shared/rules'
import type {
  EditorDoc,
  Generation,
  PlayerDoc,
  PlayerFile,
  Session,
  SessionValidation,
  WebRoom,
} from '@shared/types'
import { goatError } from './goat-mock'
import { renderApp, type RenderAppOptions } from './render-app'

const NOW = '2026-10-17T18:00:00.000Z'
const WORKSPACE = 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\sessions\\s1'
const NO_FX = { effects: { crt: false, glow: false, animations: false, sounds: false } }

function doc(index: number, name: string, game: string, issues: PlayerDoc['issues'] = []): PlayerDoc {
  return { index, name, games: [{ game, weight: 1 }], issues }
}

function playerFile(id: string, originalName: string, docs: PlayerDoc[]): PlayerFile {
  return { id, originalName, storedName: originalName, docs, addedAt: NOW }
}

const LINK = playerFile('f1', 'Link.yaml', [doc(0, 'Link', 'A Link to the Past')])
const MADELINE = playerFile('f2', 'Madeline.yaml', [doc(0, 'Madeline', 'Celeste')])

const GENERATION: Generation = {
  seedName: '48213977',
  zipPath: `${WORKSPACE}\\output\\AP_48213977.zip`,
  spoilerName: 'AP_48213977_Spoiler.txt',
  slots: [
    {
      slot: 1,
      name: 'Link',
      game: 'A Link to the Past',
      patchFile: `${WORKSPACE}\\output\\slots\\P1_Link\\AP_48213977_P1_Link.aplttp`,
    },
    { slot: 2, name: 'Madeline', game: 'Celeste', patchFile: null },
  ],
  durationS: 72,
  logPath: `${WORKSPACE}\\logs\\generate-1.txt`,
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'Soirée GOAT',
    createdAt: NOW,
    updatedAt: NOW,
    status: 'draft',
    players: [LINK, MADELINE],
    rules: defaultRules(),
    hasPassword: false,
    hasServerPassword: false,
    generation: null,
    hosting: null,
    workspace: WORKSPACE,
    ...overrides,
  }
}

const READY: SessionValidation = {
  files: [
    { fileId: 'f1', docs: LINK.docs },
    { fileId: 'f2', docs: MADELINE.docs },
  ],
  sessionIssues: [],
  missingWorlds: [],
  romNeeds: [],
  blocking: false,
}

function editorDoc(name: string, game: string): EditorDoc {
  return { name, description: '', game, requiresVersion: '0.6.8', options: {}, extraRoot: {} }
}

const fileFrom = (name: string, path: string): File => Object.assign(new File(['x'], name), { path })

/** Moves the hash router, as a link elsewhere in the app would. */
function navigateTo(route: string): void {
  act(() => {
    window.history.pushState(null, '', `#${route}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

async function openWizard(route: string, options: Omit<RenderAppOptions, 'route'> = {}) {
  const rendered = await renderApp({ route, config: NO_FX, ...options })
  return rendered
}

describe('session wizard', () => {
  it('creates a named session from /session/new and opens step 1', async () => {
    const created = session({ players: [] })
    const { goat, user } = await openWizard('/session/new', {
      handlers: {
        'session:list': () => [],
        'session:create': () => created,
        'session:get': () => created,
      },
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Partie' })).toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'Nom de la partie' })
    await user.clear(name)
    await user.type(name, 'Soirée GOAT')
    await user.click(screen.getByRole('button', { name: 'Créer la partie' }))

    await waitFor(() => expect(goat.inputsOf('session:create')).toEqual([{ name: 'Soirée GOAT' }]))
    await waitFor(() => expect(window.location.hash).toBe('#/session/s1?step=1'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Soirée GOAT' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Dépose les YAML des joueurs ici' })).toBeInTheDocument()
  })

  it('step 1 lists dropped files and ignored ones', async () => {
    let current = session({ players: [] })
    const { goat } = await openWizard('/session/s1?step=1', {
      handlers: {
        'session:get': () => current,
        'session:addFiles': ({ paths }) => {
          current = { ...current, players: [LINK] }
          return { session: current, ignored: paths.filter((path) => path.endsWith('.txt')) }
        },
      },
    })
    expect(await screen.findByText('Aucun joueur pour l’instant')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Suivant' })).toBeDisabled()

    const zone = screen.getByRole('group', { name: 'Dépose les YAML des joueurs ici' })
    fireEvent.drop(zone, {
      dataTransfer: {
        types: ['Files'],
        files: [
          fileFrom('Link.yaml', 'C:\\yamls\\Link.yaml'),
          fileFrom('notes.txt', 'C:\\yamls\\notes.txt'),
          fileFrom('cover.png', 'C:\\yamls\\cover.png'),
        ],
      },
    })

    await waitFor(() =>
      expect(goat.inputsOf('session:addFiles')).toEqual([
        { id: 's1', paths: ['C:\\yamls\\Link.yaml', 'C:\\yamls\\notes.txt'] },
      ]),
    )
    const players = await screen.findByRole('list', { name: 'Fichiers des joueurs' })
    expect(await within(players).findByText('Link.yaml')).toBeInTheDocument()
    expect(within(players).getByText('Link')).toBeInTheDocument()
    expect(within(players).getByText('A Link to the Past')).toBeInTheDocument()

    const ignored = screen.getByRole('region', { name: 'Fichiers ignorés' })
    expect(within(ignored).getByText('notes.txt')).toBeInTheDocument()
    expect(within(ignored).getByText('cover.png')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Suivant' })).toBeEnabled()
  })

  it('step 2 blocks next while validation is blocking and shows actions', async () => {
    const blocking: SessionValidation = {
      files: [
        {
          fileId: 'f1',
          docs: [doc(0, 'Link', 'A Link to the Past', [{ severity: 'error', code: 'name-duplicate' }])],
        },
        {
          fileId: 'f2',
          docs: [
            doc(0, 'Madeline', 'Celeste', [
              { severity: 'error', code: 'game-not-installed' },
              { severity: 'warning', code: 'option-unknown', path: 'Celeste.dash_mode' },
            ]),
          ],
        },
      ],
      sessionIssues: [],
      missingWorlds: [
        { game: 'Celeste', catalogId: 'celeste' },
        { game: 'Custom Quest', catalogId: null },
      ],
      romNeeds: [
        {
          game: 'A Link to the Past',
          settingsKey: 'lttp_options.rom_file',
          status: 'missing',
          path: null,
          vaultPath: null,
        },
        {
          game: 'Super Metroid',
          settingsKey: 'sm_options.rom_file',
          status: 'ok',
          path: 'D:\\ROMs\\Super Metroid.sfc',
          vaultPath: 'D:\\ROMs\\Super Metroid.sfc',
        },
      ],
      blocking: true,
    }
    const { goat, user } = await openWizard('/session/s1?step=2', {
      handlers: {
        'session:get': () => session(),
        'session:validate': () => blocking,
        'worlds:prepareInstall': () => ({ taskId: 'w1' }),
        // The world that is not in the catalog asks for its file; the user cancels that dialog.
        'app:pickPaths': () => [],
      },
    })

    const next = await screen.findByRole('button', { name: 'Suivant' })
    expect(
      await screen.findByText(/1 erreur à corriger, 2 mondes à installer, 1 ROM à fournir/),
    ).toBeInTheDocument()
    expect(next).toBeDisabled()

    const link = screen.getByRole('region', { name: 'Link.yaml' })
    expect(within(link).getByText('Un autre joueur porte déjà ce nom.')).toBeInTheDocument()
    expect(within(link).getByRole('button', { name: 'Renommer Link' })).toBeInTheDocument()
    expect(within(link).getByRole('button', { name: 'Corriger dans le Studio' })).toBeInTheDocument()
    const madeline = screen.getByRole('region', { name: 'Madeline.yaml' })
    expect(within(madeline).getByText('Celeste.dash_mode')).toBeInTheDocument()

    const worlds = screen.getByRole('region', { name: 'Mondes manquants' })
    expect(within(worlds).getByText('Custom Quest')).toBeInTheDocument()
    expect(
      within(worlds).getByRole('button', { name: 'Choisir le fichier .apworld de Custom Quest' }),
    ).toBeInTheDocument()

    const roms = screen.getByRole('region', { name: 'ROMs' })
    expect(within(roms).getByText('ROM manquante')).toBeInTheDocument()
    expect(within(roms).getByRole('button', { name: 'Ouvrir le coffre à ROMs' })).toBeInTheDocument()
    expect(within(roms).getByText('ROM trouvée dans le coffre')).toBeInTheDocument()

    await user.click(within(worlds).getByRole('button', { name: 'Installer les mondes manquants' }))
    await waitFor(() =>
      expect(goat.inputsOf('worlds:prepareInstall')).toEqual([
        { source: { kind: 'catalog', id: 'celeste' } },
      ]),
    )
    expect(goat.inputsOf('app:pickPaths')).toEqual([
      {
        mode: 'file',
        title: 'APWorld pour Custom Quest',
        filters: [{ name: 'APWorld', extensions: ['apworld'] }],
      },
    ])
    expect(await screen.findByRole('dialog', { name: 'Nouveau monde' })).toBeInTheDocument()
  })

  it('step 2 rename action replaces the file with the new name and revalidates', async () => {
    const twoPlayers = playerFile('f1', 'Duo.yaml', [
      doc(0, 'Link', 'A Link to the Past'),
      doc(1, 'TheVeryLongPlayerName', 'Celeste', [{ severity: 'error', code: 'name-too-long' }]),
    ])
    let renamed = false
    const { goat, user } = await openWizard('/session/s1?step=2', {
      handlers: {
        'session:get': () => session({ players: [twoPlayers] }),
        'session:validate': () =>
          renamed
            ? {
                ...READY,
                files: [
                  { fileId: 'f1', docs: [doc(0, 'Link', 'A Link to the Past'), doc(1, 'Zelda', 'Celeste')] },
                ],
              }
            : { ...READY, files: [{ fileId: 'f1', docs: twoPlayers.docs }], blocking: true },
        'session:readFile': () => ({ text: 'name: Link\n---\nname: TheVeryLongPlayerName\n' }),
        'studio:parse': () => ({
          docs: [editorDoc('Link', 'A Link to the Past'), editorDoc('TheVeryLongPlayerName', 'Celeste')],
          issues: [],
        }),
        'studio:render': ({ doc: rendered }) => ({
          text: `name: ${rendered.name}\ngame: ${rendered.game}\n`,
          issues: [],
        }),
        'session:replaceFile': () => {
          renamed = true
          return session({ players: [twoPlayers] })
        },
      },
    })

    const file = await screen.findByRole('region', { name: 'Duo.yaml' })
    expect(screen.getByRole('button', { name: 'Suivant' })).toBeDisabled()
    await user.click(within(file).getByRole('button', { name: 'Renommer TheVeryLongPlayerName' }))

    const dialog = await screen.findByRole('dialog', { name: 'Renommer TheVeryLongPlayerName' })
    const field = within(dialog).getByRole('textbox', { name: 'Nouveau nom' })
    await user.clear(field)
    await user.type(field, 'Zelda')
    await user.click(within(dialog).getByRole('button', { name: 'Renommer' }))

    await waitFor(() =>
      expect(goat.inputsOf('session:replaceFile')).toEqual([
        {
          id: 's1',
          fileId: 'f1',
          text: 'name: Link\ngame: A Link to the Past\n\n---\nname: Zelda\ngame: Celeste\n',
        },
      ]),
    )
    expect(goat.inputsOf('session:readFile')).toEqual([{ id: 's1', fileId: 'f1' }])
    expect(goat.inputsOf('studio:parse')).toEqual([
      { text: 'name: Link\n---\nname: TheVeryLongPlayerName\n' },
    ])
    expect(goat.inputsOf('studio:render').map(({ doc: rendered }) => rendered.name)).toEqual([
      'Link',
      'Zelda',
    ])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Suivant' })).toBeEnabled())
    expect(goat.inputsOf('session:validate').length).toBeGreaterThanOrEqual(2)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Text queries collapse the non-breaking space of French punctuation into a plain one.
    expect(screen.getByText('Joueur renommé : Zelda')).toBeInTheDocument()
  })

  it('step 2 rename finds the player by name when the parsed documents are numbered differently', async () => {
    // The file starts with an empty document: the check counts it, the Studio parser does not.
    const shifted = playerFile('f1', 'Duo.yaml', [
      doc(1, 'Link', 'A Link to the Past'),
      doc(2, 'TheVeryLongPlayerName', 'Celeste', [{ severity: 'error', code: 'name-too-long' }]),
    ])
    const { goat, user } = await openWizard('/session/s1?step=2', {
      handlers: {
        'session:get': () => session({ players: [shifted] }),
        'session:validate': () => ({
          ...READY,
          files: [{ fileId: 'f1', docs: shifted.docs }],
          blocking: true,
        }),
        'session:readFile': () => ({ text: '---\nname: Link\n---\nname: TheVeryLongPlayerName\n' }),
        'studio:parse': () => ({
          docs: [editorDoc('Link', 'A Link to the Past'), editorDoc('TheVeryLongPlayerName', 'Celeste')],
          issues: [],
        }),
        'studio:render': ({ doc: rendered }) => ({ text: `name: ${rendered.name}\n`, issues: [] }),
        'session:replaceFile': () => session({ players: [shifted] }),
      },
    })

    const file = await screen.findByRole('region', { name: 'Duo.yaml' })
    await user.click(within(file).getByRole('button', { name: 'Renommer TheVeryLongPlayerName' }))
    const dialog = await screen.findByRole('dialog', { name: 'Renommer TheVeryLongPlayerName' })
    const field = within(dialog).getByRole('textbox', { name: 'Nouveau nom' })
    await user.clear(field)
    await user.type(field, 'Zelda')
    await user.click(within(dialog).getByRole('button', { name: 'Renommer' }))

    await waitFor(() =>
      expect(goat.inputsOf('session:replaceFile')).toEqual([
        { id: 's1', fileId: 'f1', text: 'name: Link\n\n---\nname: Zelda\n' },
      ]),
    )
  })

  it('step 2 rename refuses a file whose documents do not match the check', async () => {
    const duo = playerFile('f1', 'Duo.yaml', [
      doc(0, 'Link', 'A Link to the Past'),
      doc(1, 'TheVeryLongPlayerName', 'Celeste', [{ severity: 'error', code: 'name-too-long' }]),
    ])
    const { goat, user } = await openWizard('/session/s1?step=2', {
      handlers: {
        'session:get': () => session({ players: [duo] }),
        'session:validate': () => ({ ...READY, files: [{ fileId: 'f1', docs: duo.docs }], blocking: true }),
        // Edited in the meantime: that player is not in the file any more.
        'session:readFile': () => ({ text: 'name: Link\n---\nname: Somebody\n' }),
        'studio:parse': () => ({
          docs: [editorDoc('Link', 'A Link to the Past'), editorDoc('Somebody', 'Celeste')],
          issues: [],
        }),
        'studio:render': ({ doc: rendered }) => ({ text: `name: ${rendered.name}\n`, issues: [] }),
        'session:replaceFile': () => session({ players: [duo] }),
      },
    })

    const file = await screen.findByRole('region', { name: 'Duo.yaml' })
    await user.click(within(file).getByRole('button', { name: 'Renommer TheVeryLongPlayerName' }))
    const dialog = await screen.findByRole('dialog', { name: 'Renommer TheVeryLongPlayerName' })
    await user.clear(within(dialog).getByRole('textbox', { name: 'Nouveau nom' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Nouveau nom' }), 'Zelda')
    await user.click(within(dialog).getByRole('button', { name: 'Renommer' }))

    const alert = await within(dialog).findByRole('alert')
    expect(within(alert).getByRole('button', { name: 'Corriger dans le Studio' })).toBeInTheDocument()
    expect(goat.inputsOf('session:replaceFile')).toEqual([])
  })

  it('step 2 fix-in-studio navigates with session and file params', async () => {
    const broken = playerFile('f1', 'Link.yaml', [
      doc(0, 'Link', 'A Link to the Past', [
        { severity: 'error', code: 'option-invalid-value', path: 'A Link to the Past.goal' },
      ]),
    ])
    const { user } = await openWizard('/session/s1?step=2', {
      handlers: {
        'session:get': () => session({ players: [broken] }),
        'session:validate': () => ({
          ...READY,
          files: [{ fileId: 'f1', docs: broken.docs }],
          blocking: true,
        }),
      },
    })
    const file = await screen.findByRole('region', { name: 'Link.yaml' })
    await user.click(within(file).getByRole('button', { name: 'Corriger dans le Studio' }))
    await waitFor(() => expect(window.location.hash).toBe('#/studio?session=s1&file=f1'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Studio YAML' })).toBeInTheDocument()
  })

  it('step 3 applies race preset values', async () => {
    const { goat, user } = await openWizard('/session/s1?step=3', {
      handlers: {
        'session:get': () => session(),
        'session:update': ({ rules }) => session({ rules: rules ?? defaultRules() }),
      },
    })
    const casual = await screen.findByRole('radio', { name: /Détente/ })
    expect(casual).toBeChecked()
    await user.click(screen.getByRole('radio', { name: /Course/ }))
    expect(screen.getByRole('radio', { name: /Course/ })).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Réglages avancés' }))
    expect(screen.getByRole('switch', { name: 'Mode course' })).toBeChecked()
    const spoiler = screen.getByRole('radiogroup', { name: 'Fichier spoiler' })
    expect(within(spoiler).getByRole('radio', { name: 'Aucun' })).toBeChecked()
    const compatibility = screen.getByRole('radiogroup', { name: 'Versions des clients' })
    expect(within(compatibility).getByRole('radio', { name: 'Version identique' })).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Suivant' }))
    await waitFor(() =>
      expect(goat.inputsOf('session:update')).toEqual([{ id: 's1', rules: RULE_PRESETS.race }]),
    )
    await waitFor(() => expect(window.location.hash).toBe('#/session/s1?step=4'))
    expect(goat.inputsOf('session:setSecrets')).toEqual([])
  })

  it('step 3 saves passwords with session:setSecrets and switches to custom on an advanced change', async () => {
    const { goat, user } = await openWizard('/session/s1?step=3', {
      handlers: {
        'session:get': () => session(),
        'session:update': ({ rules }) => session({ rules: rules ?? defaultRules() }),
        'session:setSecrets': () => undefined,
      },
    })
    await user.type(await screen.findByLabelText('Mot de passe des joueurs'), 'chevre')
    await user.click(screen.getByRole('button', { name: 'Réglages avancés' }))
    await user.click(screen.getByRole('switch', { name: 'Autoriser !getitem' }))
    expect(screen.getByRole('radio', { name: /Détente/ })).not.toBeChecked()
    expect(screen.getByText('Personnalisé')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Suivant' }))
    await waitFor(() =>
      expect(goat.inputsOf('session:setSecrets')).toEqual([{ id: 's1', password: 'chevre' }]),
    )
    expect(goat.inputsOf('session:update')).toEqual([
      { id: 's1', rules: { ...defaultRules(), preset: 'custom', itemCheat: true } },
    ])
    // Saved once: leaving the step after the save does not send it again.
    await screen.findByRole('button', { name: 'Lancer la génération' })
    expect(goat.inputsOf('session:setSecrets')).toHaveLength(1)
    expect(goat.inputsOf('session:update')).toHaveLength(1)
  })

  it('step 3 still saves its changes when the user leaves the wizard another way', async () => {
    const { goat, user } = await openWizard('/session/s1?step=3', {
      handlers: {
        'session:get': () => session(),
        'session:update': ({ rules }) => session({ rules: rules ?? defaultRules() }),
        'session:setSecrets': () => undefined,
      },
    })
    await user.click(await screen.findByRole('radio', { name: /Course/ }))
    await user.type(screen.getByLabelText('Mot de passe d’administration'), 'bouc')

    navigateTo('/')
    await waitFor(() =>
      expect(goat.inputsOf('session:update')).toEqual([{ id: 's1', rules: RULE_PRESETS.race }]),
    )
    await waitFor(() =>
      expect(goat.inputsOf('session:setSecrets')).toEqual([{ id: 's1', serverPassword: 'bouc' }]),
    )
  })

  it('step 4 shows stage progress and friendly error with log link', async () => {
    const { goat, user } = await openWizard('/session/s1?step=4', {
      handlers: {
        'session:get': () => session(),
        'session:generate': () => ({ taskId: 'g1' }),
        'tasks:cancel': () => undefined,
        'app:openPath': () => undefined,
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Lancer la génération' }))
    await waitFor(() => expect(goat.inputsOf('session:generate')).toEqual([{ id: 's1' }]))

    goat.emit('task:progress', { taskId: 'g1', kind: 'generate', stage: 'fill', percent: 62 })
    goat.emit('task:log', { taskId: 'g1', stream: 'stdout', line: 'Filling the multiworld with 312 items.' })
    const bar = await screen.findByRole('progressbar', { name: 'Placement des objets' })
    expect(bar).toHaveAttribute('aria-valuenow', '62')

    await user.click(screen.getByText(/Log de la génération/))
    expect(screen.getByText('Filling the multiworld with 312 items.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Annuler la génération' }))
    await waitFor(() => expect(goat.inputsOf('tasks:cancel')).toEqual([{ taskId: 'g1' }]))

    goat.emit('task:failed', {
      taskId: 'g1',
      kind: 'generate',
      error: goatError('AP_FILL_UNBEATABLE', undefined, {
        detail: 'FillError: No more spots to place Progressive Sword',
        logPath: `${WORKSPACE}\\logs\\generate-1.txt`,
      }),
    })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Partie impossible à terminer')).toBeInTheDocument()
    expect(within(alert).getByText(/Relance, ou assouplis les options/)).toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Ouvrir le log' }))
    await waitFor(() =>
      expect(goat.inputsOf('app:openPath')).toEqual([{ path: `${WORKSPACE}\\logs\\generate-1.txt` }]),
    )
    expect(within(alert).getByRole('button', { name: 'Relancer la génération' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Suivant' })).toBeDisabled()
  })

  it('step 4 sends to the live screen to stop the local server before generating again', async () => {
    const { goat, user } = await openWizard('/session/s1?step=4', {
      handlers: {
        'session:get': () => session(),
        'session:generate': () => ({ taskId: 'g1' }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Lancer la génération' }))
    await waitFor(() => expect(goat.inputsOf('session:generate')).toHaveLength(1))
    goat.emit('task:failed', {
      taskId: 'g1',
      kind: 'generate',
      error: goatError('GENERATION_PREFLIGHT', { reason: 'hosting' }),
    })

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Le serveur local de la partie tourne')).toBeInTheDocument()
    expect(
      within(alert).getByText(/Arrête le serveur local depuis l’écran de la partie en cours/),
    ).toBeInTheDocument()
    // Nothing to fix at the check step.
    expect(within(alert).queryByRole('button', { name: 'Revenir à la vérification' })).toBeNull()
    await user.click(within(alert).getByRole('button', { name: 'Voir la partie en cours' }))
    await waitFor(() => expect(window.location.hash).toBe('#/play/s1'))
  })

  it('step 4 keeps the way back to the check for the check failures', async () => {
    const { goat, user } = await openWizard('/session/s1?step=4', {
      handlers: {
        'session:get': () => session(),
        'session:generate': () => ({ taskId: 'g1' }),
        'session:validate': () => READY,
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Lancer la génération' }))
    await waitFor(() => expect(goat.inputsOf('session:generate')).toHaveLength(1))
    goat.emit('task:failed', {
      taskId: 'g1',
      kind: 'generate',
      error: goatError('GENERATION_PREFLIGHT', { errors: 2 }),
    })

    const alert = await screen.findByRole('alert')
    expect(within(alert).queryByRole('button', { name: 'Voir la partie en cours' })).toBeNull()
    await user.click(within(alert).getByRole('button', { name: 'Revenir à la vérification' }))
    await waitFor(() => expect(window.location.hash).toBe('#/session/s1?step=2'))
  })

  it('step 4 shows a calm hint while a generation makes no progress, until it moves again', async () => {
    const { goat, user } = await openWizard('/session/s1?step=4', {
      handlers: {
        'session:get': () => session(),
        'session:generate': () => ({ taskId: 'g1' }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Lancer la génération' }))
    await waitFor(() => expect(goat.inputsOf('session:generate')).toHaveLength(1))
    // The matchers read a no-break space as a space.
    const hint = /Aucun progrès depuis 10\sminutes/

    goat.emit('task:progress', { taskId: 'g1', kind: 'generate', stage: 'fill', percent: 62 })
    expect(await screen.findByRole('progressbar', { name: 'Placement des objets' })).toBeInTheDocument()
    expect(screen.queryByText(hint)).toBeNull()

    goat.emit('task:progress', {
      taskId: 'g1',
      kind: 'generate',
      stage: 'fill',
      percent: 62,
      detail: { done: 1000, total: 1442, stalled: 1 },
    })
    const shown = await screen.findByText(hint)
    expect(shown).toHaveTextContent(/les grosses seeds peuvent prendre du temps\s; tu peux annuler\.$/)
    // The generation keeps running: it can still be cancelled.
    expect(screen.getByRole('button', { name: 'Annuler la génération' })).toBeEnabled()

    goat.emit('task:progress', { taskId: 'g1', kind: 'generate', stage: 'balancing', percent: 80 })
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull())
  })

  it('step 4 celebrates a success with pixel confetti, lists the slots and unlocks next', async () => {
    let current = session()
    const { goat } = await renderApp({
      route: '/session/s1?step=4',
      handlers: {
        'session:get': () => current,
        'session:generate': () => ({ taskId: 'g1' }),
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Lancer la génération' }))
    await waitFor(() => expect(goat.inputsOf('session:generate')).toHaveLength(1))
    current = session({ status: 'generated', generation: GENERATION })
    goat.emit('task:done', { taskId: 'g1', kind: 'generate', result: GENERATION })

    expect(await screen.findByText('Partie générée')).toBeInTheDocument()
    const slots = screen.getByRole('table', { name: 'Slots de la partie' })
    expect(within(slots).getByText('Madeline')).toBeInTheDocument()
    expect(within(slots).getByText('AP_48213977_P1_Link.aplttp')).toBeInTheDocument()
    expect(document.querySelector('.pixel-confetti')).not.toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Suivant' })).toBeEnabled())
  })

  it('step 4 throws no confetti when animations are off', async () => {
    const { goat } = await openWizard('/session/s1?step=4', {
      handlers: {
        'session:get': () => session(),
        'session:generate': () => ({ taskId: 'g1' }),
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Lancer la génération' }))
    await waitFor(() => expect(goat.inputsOf('session:generate')).toHaveLength(1))
    goat.emit('task:done', { taskId: 'g1', kind: 'generate', result: GENERATION })
    expect(await screen.findByText('Partie générée')).toBeInTheDocument()
    expect(document.querySelector('.pixel-confetti')).toBeNull()
  })

  it('step 4 keeps following a running generation after leaving the wizard', async () => {
    const { goat, user } = await openWizard('/session/s1?step=4', {
      handlers: {
        'session:get': () => session(),
        'session:generate': () => ({ taskId: 'g1' }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Lancer la génération' }))
    await waitFor(() => expect(goat.inputsOf('session:generate')).toHaveLength(1))
    goat.emit('task:progress', { taskId: 'g1', kind: 'generate', stage: 'fill', percent: 62 })
    expect(await screen.findByRole('progressbar', { name: 'Placement des objets' })).toBeInTheDocument()

    navigateTo('/')
    await waitFor(() =>
      expect(screen.queryByRole('progressbar', { name: 'Placement des objets' })).toBeNull(),
    )
    goat.emit('task:progress', { taskId: 'g1', kind: 'generate', stage: 'balancing', percent: 80 })
    navigateTo('/session/s1?step=4')

    const bar = await screen.findByRole('progressbar', { name: 'Équilibrage de la progression' })
    expect(bar).toHaveAttribute('aria-valuenow', '80')
    expect(screen.queryByRole('button', { name: 'Lancer la génération' })).toBeNull()
    expect(goat.inputsOf('session:generate')).toHaveLength(1)
  })

  it('step 5 requires consent before web hosting and navigates to live screen', async () => {
    const room: WebRoom = {
      roomId: 'r1',
      seedId: 'seed1',
      roomUrl: 'https://archipelago.gg/room/r1',
      host: 'archipelago.gg',
      port: 38281,
      lastActivity: null,
      timeoutS: 7200,
      players: [],
      downloads: [],
      trackerUrl: null,
    }
    const { goat, user } = await openWizard('/session/s1?step=5', {
      handlers: {
        'session:get': () => session({ status: 'generated', generation: GENERATION, hasPassword: true }),
        'webhost:host': () => ({ taskId: 'h1' }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Héberger sur archipelago.gg' }))

    const dialog = await screen.findByRole('dialog', { name: 'Héberger sur archipelago.gg\u00a0?' })
    expect(within(dialog).getByText(/mots de passe de la partie, en clair/)).toBeInTheDocument()
    expect(within(dialog).getByText(/quiconque a le lien/)).toBeInTheDocument()
    const send = within(dialog).getByRole('button', { name: 'Envoyer et héberger' })
    expect(send).toBeDisabled()
    await user.click(send)
    expect(goat.inputsOf('webhost:host')).toEqual([])

    await user.click(within(dialog).getByRole('checkbox', { name: 'J’ai compris' }))
    await user.click(send)
    await waitFor(() => expect(goat.inputsOf('webhost:host')).toEqual([{ sessionId: 's1', consent: true }]))

    goat.emit('task:progress', { taskId: 'h1', kind: 'webhost-host', stage: 'upload', percent: 40 })
    expect(await screen.findByRole('progressbar', { name: 'Envoi sur archipelago.gg…' })).toBeInTheDocument()
    goat.emit('task:progress', { taskId: 'h1', kind: 'webhost-host', stage: 'room', percent: 60 })
    expect(await screen.findByRole('progressbar', { name: 'Création de la room…' })).toBeInTheDocument()
    goat.emit('task:progress', { taskId: 'h1', kind: 'webhost-host', stage: 'port', percent: 90 })
    expect(
      await screen.findByRole('progressbar', { name: 'Attente du port de la room…' }),
    ).toBeInTheDocument()
    goat.emit('task:done', { taskId: 'h1', kind: 'webhost-host', result: room })
    await waitFor(() => expect(window.location.hash).toBe('#/play/s1'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Partie en cours' })).toBeInTheDocument()

    // Coming back to the step later does not bounce to the live screen again.
    navigateTo('/session/s1?step=5')
    expect(await screen.findByRole('button', { name: 'Héberger sur archipelago.gg' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/session/s1?step=5')
  })

  it('step 5 starts the local server and opens the live screen', async () => {
    const { goat, user } = await openWizard('/session/s1?step=5', {
      handlers: {
        'session:get': () => session({ status: 'generated', generation: GENERATION }),
        'server:start': ({ sessionId }) => ({
          sessionId,
          status: 'ready',
          port: 38281,
          addresses: [{ kind: 'localhost', host: '127.0.0.1', port: 38281 }],
          startedAt: NOW,
          resumedFromSave: false,
          error: null,
        }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Lancer le serveur local' }))
    await waitFor(() => expect(goat.inputsOf('server:start')).toEqual([{ sessionId: 's1' }]))
    await waitFor(() => expect(window.location.hash).toBe('#/play/s1'))
    expect(goat.inputsOf('webhost:host')).toEqual([])
  })

  it('step 5 shows a local server error with its fix', async () => {
    const { user } = await openWizard('/session/s1?step=5', {
      handlers: {
        'session:get': () => session({ status: 'generated', generation: GENERATION }),
        'server:start': () => {
          throw new AppError('PORT_IN_USE', { port: 38281 })
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Lancer le serveur local' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('button', { name: 'Ouvrir le diagnostic' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/session/s1?step=5')
  })

  it.each([
    [
      'a running local server',
      goatError('AP_RUNNING', { reason: 'local-server' }),
      'Le serveur local de la partie tourne',
      /^Arrête d’abord le serveur local/,
    ],
    [
      'a seed too big for the site',
      goatError('WEBHOST_UPLOAD_FAILED', { reason: 'too-large' }, { detail: 'status 413' }),
      'Partie trop lourde pour archipelago.gg',
      /héberge-la en local/,
    ],
    [
      'a file the site refused with its message',
      goatError(
        'WEBHOST_UPLOAD_FAILED',
        { message: 'Uploaded data contained a rom file.' },
        { detail: 'Uploaded data contained a rom file.' },
      ),
      'L’envoi vers archipelago.gg a échoué',
      /«\sUploaded data contained a rom file\.\s»/,
    ],
  ])('step 5 explains a web hosting refused for %s', async (_, error, title, body) => {
    const { goat, user } = await openWizard('/session/s1?step=5', {
      handlers: {
        'session:get': () => session({ status: 'generated', generation: GENERATION }),
        'webhost:host': () => ({ taskId: 'h1' }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Héberger sur archipelago.gg' }))
    const dialog = await screen.findByRole('dialog', { name: 'Héberger sur archipelago.gg\u00a0?' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'J’ai compris' }))
    await user.click(within(dialog).getByRole('button', { name: 'Envoyer et héberger' }))
    await waitFor(() => expect(goat.inputsOf('webhost:host')).toHaveLength(1))

    goat.emit('task:failed', { taskId: 'h1', kind: 'webhost-host', error })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(title)).toBeInTheDocument()
    expect(within(alert).getByText(body)).toBeInTheDocument()
  })

  it('shows a not-found state for an unknown session', async () => {
    await openWizard('/session/nope', {
      handlers: {
        'session:get': () => {
          throw new AppError('NOT_FOUND')
        },
      },
    })
    expect(await screen.findByText('Partie introuvable')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Partie' })).toBeInTheDocument()
  })
})
