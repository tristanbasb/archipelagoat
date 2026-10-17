import { screen, waitFor, within } from '@testing-library/react'
import { AppError } from '@shared/errors'
import type {
  BizhawkState,
  CatalogEntry,
  CheckItem,
  JoinPlan,
  JoinTarget,
  WorldInfo,
  WorldInstallPlan,
} from '@shared/types'
import { JoinScreen } from '@renderer/features/join/JoinScreen'
import { withoutPassword } from '@renderer/features/join/room-history'
import { installGoatMock, type GoatHandlers, type GoatMock } from './goat-mock'
import { renderWithProviders } from './render-app'

const ROOM_ID = 'aBcDeFgHiJkLmNoPqRsTuV'
const ROOM_URL = `https://archipelago.gg/room/${ROOM_ID}`
const ROOM: JoinTarget = { kind: 'room', roomId: ROOM_ID }
const PATCH_PATH = 'C:\\Users\\Joueur\\Téléchargements\\AP_7731_P1_Goat.apemerald'
const PATCH: JoinTarget = { kind: 'patch', path: PATCH_PATH }
const HISTORY_KEY = 'archipelagoat.join.history'

const check = (status: CheckItem['status'], code: string): CheckItem => ({ status, code })

function plan(overrides: Partial<JoinPlan> = {}): JoinPlan {
  return {
    planId: 'plan-1',
    target: PATCH,
    slots: [],
    slot: { name: 'Goat', game: 'Pokemon Emerald' },
    patchPath: PATCH_PATH,
    manifest: null,
    route: { suffix: '.apemerald', client: 'bizhawk', exe: 'ArchipelagoBizHawkClient', tier: 'full' },
    connect: { host: 'archipelago.gg', port: 38281, slot: 'Goat', hasPassword: false },
    tutorialUrl: 'https://archipelago.gg/tutorial/Pokemon%20Emerald/setup/en',
    checklist: {
      ap: check('ok', 'ap-ok'),
      world: check('ok', 'world-ok'),
      rom: check('ok', 'rom-ok'),
      emulator: check('ok', 'emulator-ok'),
    },
    warnings: [],
    ready: true,
    ...overrides,
  }
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'pokemon_emerald',
    game: 'Pokemon Emerald',
    displayName: 'Pokémon Emerald',
    homepage: null,
    tags: [],
    supported: true,
    afterDark: false,
    requiresRomAtGeneration: false,
    hasPopTracker: false,
    wiki: null,
    latest: { version: '2.4.1', url: 'https://example.invalid/pokemon_emerald.apworld', sha256: null },
    installedVersion: null,
    trust: 'indexed-verified',
    ...overrides,
  }
}

const BIZHAWK: BizhawkState = {
  installed: true,
  managed: true,
  version: '2.11.1',
  path: 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\bizhawk\\EmuHawk.exe',
  configuredInAp: false,
  prereqs: [],
}

/** Opens the screen on a patch file (no slot to pick) and answers its preparation with `prepared`. */
async function openPlan(
  prepared: JoinPlan,
  handlers: GoatHandlers = {},
): Promise<{ goat: GoatMock; user: Awaited<ReturnType<typeof renderWithProviders>>['user'] }> {
  const goat = installGoatMock({
    'join:resolve': () => PATCH,
    'join:prepare': () => ({ taskId: 'prep-1' }),
    ...handlers,
  })
  const { user } = await renderWithProviders(<JoinScreen />, {
    route: `/join?input=${encodeURIComponent(PATCH_PATH)}`,
  })
  await waitFor(() => expect(goat.inputsOf('join:prepare')).toEqual([{ target: PATCH }]))
  goat.emit('task:done', { taskId: 'prep-1', kind: 'join-prepare', result: prepared })
  await screen.findByRole('region', { name: 'Prêt à jouer\u00a0?' })
  return { goat, user }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('join screen', () => {
  it('room url resolves then shows slot picker from plan.slots', async () => {
    let prepared = 0
    const goat = installGoatMock({
      'join:resolve': () => ROOM,
      'join:prepare': () => ({ taskId: `prep-${++prepared}` }),
    })
    const { user } = await renderWithProviders(<JoinScreen />, { route: '/join' })

    await user.type(
      screen.getByRole('textbox', { name: 'Lien de room, adresse archipelago:// ou hôte:port' }),
      `${ROOM_URL}{Enter}`,
    )
    await waitFor(() => expect(goat.inputsOf('join:resolve')).toEqual([{ input: ROOM_URL }]))
    await waitFor(() => expect(goat.inputsOf('join:prepare')).toEqual([{ target: ROOM }]))
    expect(await screen.findByText('Préparation de la partie…')).toBeInTheDocument()

    goat.emit('task:done', {
      taskId: 'prep-1',
      kind: 'join-prepare',
      result: plan({
        target: ROOM,
        slots: [
          { name: 'Goat', game: 'Pokemon Emerald' },
          { name: 'Zelda', game: 'A Link to the Past' },
          { name: 'Rocket', game: 'Factorio' },
        ],
        slot: null,
        patchPath: null,
        ready: false,
      }),
    })

    const picker = await screen.findByRole('region', { name: 'Choisis ton slot' })
    const slots = within(picker).getAllByRole('button')
    expect(slots.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Goat'),
      expect.stringContaining('Zelda'),
      expect.stringContaining('Rocket'),
    ])
    expect(within(picker).getByText('A Link to the Past')).toBeInTheDocument()

    await user.click(within(picker).getByRole('button', { name: /Zelda/ }))
    await waitFor(() =>
      expect(goat.inputsOf('join:prepare')).toEqual([{ target: ROOM }, { target: ROOM, slotName: 'Zelda' }]),
    )
    goat.emit('task:done', {
      taskId: 'prep-2',
      kind: 'join-prepare',
      result: plan({
        planId: 'plan-2',
        target: ROOM,
        slot: { name: 'Zelda', game: 'A Link to the Past' },
        connect: { host: 'archipelago.gg', port: 38281, slot: 'Zelda', hasPassword: false },
      }),
    })
    expect(await screen.findByRole('region', { name: 'Prêt à jouer\u00a0?' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Choisis ton slot' })).toBeNull()

    // The slot can still be changed: back to the picker, without a new request.
    await user.click(screen.getByRole('button', { name: 'Changer de slot' }))
    expect(await screen.findByRole('region', { name: 'Choisis ton slot' })).toBeInTheDocument()
    expect(goat.inputsOf('join:prepare')).toHaveLength(2)
  })

  it('keeps the keyboard focus on each step, from the link to the checklist', async () => {
    let prepared = 0
    const goat = installGoatMock({
      'join:resolve': () => ROOM,
      'join:prepare': () => ({ taskId: `prep-${++prepared}` }),
    })
    const { user } = await renderWithProviders(<JoinScreen />, { route: '/join' })

    // Nothing else holds the focus: the link field takes it, ready for a paste.
    const field = screen.getByRole('textbox', { name: 'Lien de room, adresse archipelago:// ou hôte:port' })
    expect(field).toHaveFocus()
    await user.keyboard(`${ROOM_URL}{Enter}`)

    // Each step replaces the one that had the focus: the new one takes it.
    const preparing = await screen.findByRole('region', { name: 'Préparation de la partie…' })
    await waitFor(() => expect(preparing).toHaveFocus())
    await waitFor(() => expect(goat.inputsOf('join:prepare')).toHaveLength(1))
    goat.emit('task:done', {
      taskId: 'prep-1',
      kind: 'join-prepare',
      result: plan({
        target: ROOM,
        slots: [{ name: 'Goat', game: 'Pokemon Emerald' }],
        slot: null,
        ready: false,
      }),
    })
    const picker = await screen.findByRole('region', { name: 'Choisis ton slot' })
    await waitFor(() => expect(picker).toHaveFocus())

    await user.tab()
    expect(within(picker).getByRole('button', { name: /Goat/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(goat.inputsOf('join:prepare')).toHaveLength(2))
    goat.emit('task:done', { taskId: 'prep-2', kind: 'join-prepare', result: plan({ target: ROOM }) })
    const checklist = await screen.findByRole('region', { name: 'Prêt à jouer ?' })
    await waitFor(() => expect(checklist).toHaveFocus())
  })

  it('?input= param pre-fills and resolves on mount', async () => {
    const uri = 'archipelago://Goat@localhost:38281?game=Pokemon%20Emerald'
    const goat = installGoatMock({
      'join:resolve': () => {
        throw new AppError('JOIN_BAD_INPUT')
      },
    })
    await renderWithProviders(<JoinScreen />, { route: `/join?input=${encodeURIComponent(uri)}` })

    await waitFor(() => expect(goat.inputsOf('join:resolve')).toEqual([{ input: uri }]))
    expect(
      screen.getByRole('textbox', { name: 'Lien de room, adresse archipelago:// ou hôte:port' }),
    ).toHaveValue(uri)
    // A refused link is explained under the field.
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Lien ou adresse non reconnu')).toBeInTheDocument()
    expect(goat.inputsOf('join:prepare')).toEqual([])
  })

  it('shows patch-server-stale warning with the current address', async () => {
    await openPlan(
      plan({
        connect: { host: 'archipelago.gg', port: 51234, slot: 'Goat', hasPassword: false },
        warnings: [{ severity: 'warning', code: 'patch-server-stale' }],
      }),
    )
    const warnings = screen.getByRole('region', { name: 'Points d’attention' })
    expect(
      within(warnings).getByText('L’adresse de la room a changé depuis la création du patch.'),
    ).toBeInTheDocument()
    expect(within(warnings).getByText('archipelago.gg:51234')).toBeInTheDocument()
  })

  it('checklist shows actions for missing rom and emulator; JOUER disabled until ready', async () => {
    const notReady = plan({
      checklist: {
        ap: check('ok', 'ap-ok'),
        world: check('ok', 'world-ok'),
        rom: check('missing', 'rom-missing'),
        emulator: check('missing', 'emulator-missing'),
      },
      ready: false,
    })
    const romFound = plan({ ...notReady, checklist: { ...notReady.checklist, rom: check('ok', 'rom-ok') } })
    const refreshed = [romFound, plan()]
    const { goat, user } = await openPlan(notReady, {
      'app:pickPaths': () => ['D:\\ROMs'],
      'vault:scan': () => ({ taskId: 'scan-1' }),
      'bizhawk:install': () => ({ taskId: 'bh-1' }),
      'bizhawk:configureAp': () => ({ ...BIZHAWK, configuredInAp: true }),
      'join:refresh': () => refreshed.shift() ?? plan(),
    })

    const checklist = screen.getByRole('region', { name: 'Prêt à jouer\u00a0?' })
    expect(within(checklist).getByText('ROM manquante')).toBeInTheDocument()
    expect(within(checklist).getByText('Émulateur manquant')).toBeInTheDocument()
    const play = screen.getByRole('button', { name: 'JOUER' })
    expect(play).toBeDisabled()
    expect(play).toHaveAccessibleDescription('Règle les points de la liste pour débloquer JOUER.')

    // The ROM: pick a folder, scan it, then check again.
    await user.click(within(checklist).getByRole('button', { name: 'Scanner des ROMs' }))
    await waitFor(() => expect(goat.inputsOf('vault:scan')).toEqual([{ paths: ['D:\\ROMs'] }]))
    expect(goat.inputsOf('app:pickPaths')[0]).toMatchObject({ mode: 'directory' })
    goat.emit('task:done', { taskId: 'scan-1', kind: 'rom-scan', result: [] })
    await waitFor(() => expect(goat.inputsOf('join:refresh')).toEqual([{ planId: 'plan-1' }]))
    await waitFor(() => expect(within(checklist).queryByText('ROM manquante')).toBeNull())
    expect(within(checklist).getByText('ROM trouvée')).toBeInTheDocument()
    expect(play).toBeDisabled()

    // The emulator: install BizHawk, then point Archipelago at it.
    await user.click(within(checklist).getByRole('button', { name: 'Installer BizHawk' }))
    await waitFor(() => expect(goat.inputsOf('bizhawk:install')).toHaveLength(1))
    goat.emit('task:done', { taskId: 'bh-1', kind: 'bizhawk-install', result: BIZHAWK })
    await waitFor(() => expect(goat.inputsOf('bizhawk:configureAp')).toHaveLength(1))
    await waitFor(() => expect(goat.inputsOf('join:refresh')).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'JOUER' })).toBeEnabled())
    expect(within(checklist).getByText('Émulateur prêt')).toBeInTheDocument()
  })

  it('installs a missing world from the catalog, then checks again', async () => {
    const missingWorld = plan({
      checklist: { ...plan().checklist, world: check('missing', 'world-missing') },
      ready: false,
    })
    const installPlan = {
      planId: 'w-plan',
      source: { kind: 'catalog', id: 'pokemon_emerald' },
      module: 'pokemon_emerald',
      targetFileName: 'pokemon_emerald.apworld',
      manifest: null,
      sha256: 'a'.repeat(64),
      trust: 'core',
      homepage: null,
      conflicts: [],
      warnings: [],
    } satisfies WorldInstallPlan
    const { goat, user } = await openPlan(missingWorld, {
      'catalog:list': () => ({ entries: [catalogEntry()], fetchedAt: null, stale: false, errors: [] }),
      'worlds:prepareInstall': () => ({ taskId: 'world-1' }),
      'worlds:confirmInstall': () => ({
        world: { game: 'Pokemon Emerald' } as WorldInfo,
        restartNeeded: false,
      }),
      'join:refresh': () => plan(),
    })

    const checklist = screen.getByRole('region', { name: 'Prêt à jouer ?' })
    await user.click(within(checklist).getByRole('button', { name: 'Installer le monde' }))
    await waitFor(() =>
      expect(goat.inputsOf('worlds:prepareInstall')).toEqual([
        { source: { kind: 'catalog', id: 'pokemon_emerald' } },
      ]),
    )
    goat.emit('task:done', { taskId: 'world-1', kind: 'world-prepare', result: installPlan })
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('checkbox', { name: 'J’ai compris' }))
    await user.click(within(dialog).getByRole('button', { name: 'Installer' }))

    await waitFor(() => expect(goat.inputsOf('join:refresh')).toEqual([{ planId: 'plan-1' }]))
    await waitFor(() => expect(screen.getByRole('button', { name: 'JOUER' })).toBeEnabled())
  })

  it('asks for the .apworld file when the catalog has no release of the game', async () => {
    const worldFile = 'D:\\Mondes\\pokemon_emerald.apworld'
    const { goat, user } = await openPlan(
      plan({ checklist: { ...plan().checklist, world: check('missing', 'world-missing') }, ready: false }),
      {
        'catalog:list': () => ({
          entries: [catalogEntry({ latest: null })],
          fetchedAt: null,
          stale: false,
          errors: [],
        }),
        'app:pickPaths': () => [worldFile],
        'worlds:prepareInstall': () => ({ taskId: 'world-1' }),
      },
    )

    const checklist = screen.getByRole('region', { name: 'Prêt à jouer ?' })
    await user.click(within(checklist).getByRole('button', { name: 'Installer le monde' }))
    expect(await screen.findByText(/Pokemon Emerald n’est pas dans le catalogue/)).toBeInTheDocument()
    await waitFor(() =>
      expect(goat.inputsOf('worlds:prepareInstall')).toEqual([{ source: { kind: 'file', path: worldFile } }]),
    )
    expect(goat.inputsOf('app:pickPaths')).toEqual([
      expect.objectContaining({
        mode: 'file',
        filters: [{ name: 'Mondes Archipelago', extensions: ['apworld'] }],
      }),
    ])
  })

  it('cancels the preparation when the player gives up', async () => {
    const goat = installGoatMock({
      'join:resolve': () => ROOM,
      'join:prepare': () => ({ taskId: 'prep-1' }),
      'tasks:cancel': () => undefined,
    })
    const { user } = await renderWithProviders(<JoinScreen />, {
      route: `/join?input=${encodeURIComponent(ROOM_URL)}`,
    })
    const preparing = await screen.findByRole('region', { name: 'Préparation de la partie…' })
    await waitFor(() => expect(goat.inputsOf('join:prepare')).toHaveLength(1))

    await user.click(within(preparing).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(goat.inputsOf('tasks:cancel')).toEqual([{ taskId: 'prep-1' }]))
    // Back to the link, which is kept for another try.
    expect(
      screen.getByRole('textbox', { name: 'Lien de room, adresse archipelago:// ou hôte:port' }),
    ).toHaveValue(ROOM_URL)
    // A late answer of the abandoned task changes nothing.
    goat.emit('task:done', { taskId: 'prep-1', kind: 'join-prepare', result: plan({ target: ROOM }) })
    expect(screen.queryByRole('region', { name: 'Prêt à jouer ?' })).toBeNull()
  })

  it('shows a ROM found in the vault as ready, without an action', async () => {
    await openPlan(
      plan({
        checklist: {
          ap: check('ok', 'ap-ok'),
          world: check('ok', 'world-ok'),
          rom: check('missing', 'rom-apply-from-vault'),
          emulator: check('ok', 'emulator-ok'),
        },
        ready: true,
      }),
    )
    const checklist = screen.getByRole('region', { name: 'Prêt à jouer\u00a0?' })
    expect(
      within(checklist).getByText('ROM trouvée dans le coffre, elle sera configurée au lancement'),
    ).toBeInTheDocument()
    expect(within(checklist).queryByRole('button', { name: 'Scanner des ROMs' })).toBeNull()
    expect(screen.getByRole('button', { name: 'JOUER' })).toBeEnabled()
  })

  it('ready plan enables JOUER and calls join:play', async () => {
    const { goat, user } = await openPlan(plan(), { 'join:play': () => ({ pid: 4242 }) })
    const play = screen.getByRole('button', { name: 'JOUER' })
    expect(play).toBeEnabled()
    expect(play).toHaveAccessibleDescription('Lance BizHawk Client avec ton patch.')

    await user.click(play)
    await waitFor(() => expect(goat.inputsOf('join:play')).toEqual([{ planId: 'plan-1' }]))
    // Text matching turns the no-break space of French punctuation into a plain one.
    expect(await screen.findByText('BizHawk Client est lancé. Bon jeu !')).toBeInTheDocument()
  })

  it('explains a launch that failed', async () => {
    const { user } = await openPlan(plan(), {
      'join:play': () => {
        throw new AppError('SETTINGS_LOCKED')
      },
    })
    await user.click(screen.getByRole('button', { name: 'JOUER' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Les réglages d’Archipelago sont verrouillés')).toBeInTheDocument()
  })

  it('guided tier shows tutorial link', async () => {
    const url = 'https://archipelago.gg/tutorial/Factorio/setup/en'
    const { goat, user } = await openPlan(
      plan({
        slot: { name: 'Rocket', game: 'Factorio' },
        patchPath: null,
        route: { suffix: '', client: 'none', exe: null, tier: 'guided' },
        connect: { host: 'archipelago.gg', port: 51234, slot: 'Rocket', hasPassword: false },
        tutorialUrl: url,
      }),
      { 'app:openExternal': () => undefined, 'join:textClient': () => ({ pid: 77 }) },
    )

    const guide = screen.getByRole('region', { name: 'Les étapes' })
    expect(within(guide).getByText('Lancement guidé')).toBeInTheDocument()
    expect(within(guide).getByText(/connecte-toi à archipelago\.gg:51234/)).toBeInTheDocument()
    await user.click(within(guide).getByRole('button', { name: 'Ouvrir le tutoriel officiel' }))
    await waitFor(() => expect(goat.inputsOf('app:openExternal')).toEqual([{ url }]))

    // Nothing to launch for a PC game: no JOUER, but the Text Client is there.
    expect(screen.queryByRole('button', { name: 'JOUER' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Text Client' }))
    await waitFor(() =>
      expect(goat.inputsOf('join:textClient')).toEqual([
        { host: 'archipelago.gg', port: 51234, slot: 'Rocket' },
      ]),
    )
  })

  it('remembers joined rooms without their password and rejoins from the history', async () => {
    const uri = 'archipelago://Goat:hunter2@archipelago.gg:38281'
    const target: JoinTarget = {
      kind: 'address',
      host: 'archipelago.gg',
      port: 38281,
      slot: 'Goat',
      password: 'hunter2',
      game: null,
    }
    const goat = installGoatMock({
      'join:resolve': () => target,
      'join:prepare': () => ({ taskId: 'prep-1' }),
    })
    const { unmount } = await renderWithProviders(<JoinScreen />, {
      route: `/join?input=${encodeURIComponent(uri)}`,
    })
    await waitFor(() => expect(goat.inputsOf('join:prepare')).toHaveLength(1))
    goat.emit('task:done', { taskId: 'prep-1', kind: 'join-prepare', result: plan({ target }) })
    await screen.findByRole('region', { name: 'Prêt à jouer\u00a0?' })

    const stored = window.localStorage.getItem(HISTORY_KEY) ?? ''
    expect(stored).toContain('archipelago://Goat@archipelago.gg:38281')
    expect(stored).not.toContain('hunter2')
    unmount()

    const again = installGoatMock({ 'join:resolve': () => target, 'join:prepare': () => ({ taskId: 'p' }) })
    const { user } = await renderWithProviders(<JoinScreen />, { route: '/join' })
    const history = screen.getByRole('region', { name: 'Récemment rejoint' })
    expect(within(history).getByText('Pokemon Emerald')).toBeInTheDocument()
    await user.click(within(history).getByRole('button', { name: /^archipelago\.gg:38281/ }))
    await waitFor(() =>
      expect(again.inputsOf('join:resolve')).toEqual([{ input: 'archipelago://Goat@archipelago.gg:38281' }]),
    )
  })

  it('reads a broken history as empty', async () => {
    window.localStorage.setItem(HISTORY_KEY, '{not json')
    installGoatMock()
    await renderWithProviders(<JoinScreen />, { route: '/join' })
    const history = screen.getByRole('region', { name: 'Récemment rejoint' })
    expect(within(history).getByText('Aucune partie récente')).toBeInTheDocument()
  })
})

describe('withoutPassword', () => {
  it.each([
    ['archipelago://Goat:hunter2@archipelago.gg:38281', 'archipelago://Goat@archipelago.gg:38281'],
    // The host starts after the last @, as in a URL: a password may hold one.
    [
      'archipelago://Goat:p@ss:w0rd@localhost:38281?game=Factorio',
      'archipelago://Goat@localhost:38281?game=Factorio',
    ],
    ['ARCHIPELAGO://Goat:x@host:1', 'ARCHIPELAGO://Goat@host:1'],
    ['archipelago://Goat@archipelago.gg:38281', 'archipelago://Goat@archipelago.gg:38281'],
    ['archipelago://archipelago.gg:38281', 'archipelago://archipelago.gg:38281'],
    [
      'https://archipelago.gg/room/aBcDeFgHiJkLmNoPqRsTuV',
      'https://archipelago.gg/room/aBcDeFgHiJkLmNoPqRsTuV',
    ],
  ])('%s', (input, expected) => {
    expect(withoutPassword(input)).toBe(expected)
  })
})
