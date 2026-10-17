import { screen, waitFor, within } from '@testing-library/react'
import { DOCTOR_CHECK_IDS } from '@shared/codes'
import { AppError } from '@shared/errors'
import type {
  ApInstall,
  BizhawkState,
  DoctorCheck,
  RomRecord,
  SessionSummary,
  WorldInfo,
} from '@shared/types'
import type { GoatHandlers } from './goat-mock'
import { renderApp } from './render-app'

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

function world(id: string, overrides: Partial<WorldInfo> = {}): WorldInfo {
  return {
    id,
    fileName: `${id}.apworld`,
    path: `${AP_ROOT}\\custom_worlds\\${id}.apworld`,
    location: 'custom',
    module: id,
    game: id,
    manifest: null,
    states: ['ok'],
    sizeBytes: 1024,
    ...overrides,
  }
}

const WORLDS: WorldInfo[] = [
  world('celeste'),
  world('hollow_knight'),
  world('pokemon_crystal', { states: ['no-manifest'] }),
  world('alttp', { location: 'core' }),
  // Disabled worlds are not counted.
  world('old_world', { location: 'disabled', states: ['disabled'] }),
]

function rom(name: string, game: string | null): RomRecord {
  return {
    path: `D:\\ROMs\\${name}`,
    size: 1_048_576,
    mtimeMs: 0,
    md5: '0'.repeat(32),
    game,
    label: game,
    settingsKey: game ? 'lttp_options' : null,
  }
}

const ROMS: RomRecord[] = [
  rom('zelda.sfc', 'A Link to the Past'),
  rom('sm.sfc', 'Super Metroid'),
  rom('mystery.bin', null),
]

const BIZHAWK: BizhawkState = {
  installed: true,
  managed: true,
  version: '2.11.1',
  path: 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\emulators\\bizhawk-2.11.1',
  configuredInAp: true,
  prereqs: [{ name: 'vc_redist', ok: true, hint: null }],
}

const ALL_OK: DoctorCheck[] = DOCTOR_CHECK_IDS.map((id) => ({ id, severity: 'ok', params: {}, fix: null }))

function withChecks(changes: Partial<Record<DoctorCheck['id'], Partial<DoctorCheck>>>): DoctorCheck[] {
  return ALL_OK.map((check) => ({ ...check, ...changes[check.id] }))
}

const HANDLERS: GoatHandlers = {
  'ap:detect': () => AP,
  'worlds:list': () => WORLDS,
  'vault:list': () => ROMS,
  'bizhawk:state': () => BIZHAWK,
  'doctor:run': () => ALL_OK,
  'session:list': () => [],
}

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    name: overrides.id,
    status: 'draft',
    playerCount: 3,
    updatedAt: '2026-10-10T20:00:00.000Z',
    hostingMode: null,
    ...overrides,
  }
}

describe('home screen', () => {
  it('shows INSERT COIN when AP is missing and navigates to /install', async () => {
    const { user } = await renderApp({
      handlers: {
        ...HANDLERS,
        'ap:detect': () => null,
        'worlds:list': () => {
          throw new AppError('AP_NOT_INSTALLED')
        },
        // The hero already says it: the banner leaves the ap-installed check out.
        'doctor:run': () =>
          withChecks({ 'ap-installed': { severity: 'error', fix: { kind: 'navigate', to: '/install' } } }),
      },
    })
    const coin = await screen.findByRole('button', { name: /INSERT COIN/ })
    expect(coin).toHaveAccessibleName(/Installer Archipelago 0\.6\.8/)
    expect(
      screen.getByRole('heading', { level: 2, name: 'Archipelago n’est pas encore installé' }),
    ).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Archipelago Absent À installer' })).toBeInTheDocument()
    // Without Archipelago there are no worlds yet: that is no failure.
    expect(await screen.findByRole('button', { name: 'Mondes 0 Aucun monde' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /À vérifier/ })).toBeNull()

    await user.click(coin)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Installer Archipelago' }),
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('#/install')
  })

  it('updates when Archipelago gets installed from elsewhere', async () => {
    let install: ApInstall | null = null
    const { goat } = await renderApp({ handlers: { ...HANDLERS, 'ap:detect': () => install } })
    expect(await screen.findByRole('button', { name: /INSERT COIN/ })).toBeInTheDocument()
    await waitFor(() => expect(goat.inputsOf('doctor:run')).toHaveLength(1))

    install = AP
    goat.emit('ap:installed', AP)
    await waitFor(() => expect(screen.queryByRole('button', { name: /INSERT COIN/ })).toBeNull())
    // What the health check finds changes too.
    await waitFor(() => expect(goat.inputsOf('doctor:run')).toHaveLength(2))
    goat.emit('worlds:changed', null)
    await waitFor(() => expect(goat.inputsOf('doctor:run')).toHaveLength(3))
  })

  it('shows four stat tiles with values', async () => {
    const { user } = await renderApp({ handlers: HANDLERS })
    const stats = await screen.findByRole('region', { name: 'État de ton installation' })
    expect(await within(stats).findByRole('button', { name: 'Archipelago 0.6.8 Prêt' })).toBeInTheDocument()
    expect(await within(stats).findByRole('button', { name: 'Mondes 4 À vérifier : 1' })).toBeInTheDocument()
    expect(await within(stats).findByRole('button', { name: 'ROMs 2 Non reconnues : 1' })).toBeInTheDocument()
    expect(await within(stats).findByRole('button', { name: 'BizHawk 2.11.1 Prêt' })).toBeInTheDocument()
    expect(within(stats).getAllByRole('button')).toHaveLength(4)
    // AP is there: no coin to insert.
    expect(screen.queryByRole('button', { name: /INSERT COIN/ })).toBeNull()

    await user.click(within(stats).getByRole('button', { name: /^Mondes/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Mondes' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/worlds')
  })

  it('tiles say what is missing and which query failed', async () => {
    await renderApp({
      handlers: {
        ...HANDLERS,
        'worlds:list': () => [world('celeste', { states: ['corrupt'] })],
        'vault:list': () => [],
        'bizhawk:state': () => ({
          ...BIZHAWK,
          installed: false,
          version: null,
          path: null,
          configuredInAp: false,
        }),
        'ap:detect': () => {
          throw new AppError('AP_UNKNOWN')
        },
      },
    })
    const stats = await screen.findByRole('region', { name: 'État de ton installation' })
    expect(
      await within(stats).findByRole('button', { name: 'Archipelago ? Indisponible' }),
    ).toBeInTheDocument()
    expect(await within(stats).findByRole('button', { name: 'Mondes 1 Corrompus : 1' })).toBeInTheDocument()
    expect(await within(stats).findByRole('button', { name: 'ROMs 0 Coffre vide' })).toBeInTheDocument()
    expect(
      await within(stats).findByRole('button', { name: 'BizHawk Absent Pour certains jeux seulement' }),
    ).toBeInTheDocument()
  })

  it('player cards open the session wizard and the join screen', async () => {
    const { user } = await renderApp({ handlers: HANDLERS })
    await user.click(await screen.findByRole('button', { name: /PLAYER 1.*Organiser une partie/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Partie' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/session/new')

    await user.click(screen.getByRole('link', { name: 'Accueil' }))
    await user.click(await screen.findByRole('button', { name: /PLAYER 2.*Rejoindre une partie/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Rejoindre' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/join')
  })

  it('shows doctor warnings and errors in the alert banner', async () => {
    const { goat, user } = await renderApp({
      handlers: {
        ...HANDLERS,
        'doctor:run': () =>
          withChecks({
            'worlds-corrupt': { severity: 'error', fix: { kind: 'auto' } },
            'worlds-no-manifest': { severity: 'warning', fix: { kind: 'navigate', to: '/worlds' } },
            'programdata-acl': { severity: 'info' },
          }),
        'doctor:fix': ({ checkId }) =>
          withChecks({
            [checkId]: { severity: 'ok' },
            'worlds-no-manifest': { severity: 'warning', fix: { kind: 'navigate', to: '/worlds' } },
          }),
      },
    })
    const banner = await screen.findByRole('region', { name: 'À vérifier : 2' })
    const items = within(banner).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Mondes corrompus'),
      expect.stringContaining('Mondes sans manifeste'),
    ])
    expect(
      within(banner).getByText('Un monde corrompu empêche Archipelago de démarrer : mets-le de côté.'),
    ).toBeInTheDocument()
    // Info checks stay on the diagnostic screen.
    expect(within(banner).queryByText(/ProgramData/)).toBeNull()

    await user.click(within(banner).getByRole('button', { name: 'Corriger' }))
    await waitFor(() => expect(goat.inputsOf('doctor:fix')).toEqual([{ checkId: 'worlds-corrupt' }]))
    expect(await screen.findByRole('region', { name: 'À vérifier : 1' })).toBeInTheDocument()
    // A fix can change the setup (a world set aside): the tiles read it again.
    await waitFor(() => expect(goat.inputsOf('worlds:list')).toHaveLength(2))

    await user.click(screen.getByRole('link', { name: 'Ouvrir le diagnostic' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Diagnostic' })).toBeInTheDocument()
  })

  it('recent sessions link to their wizard or live screen', async () => {
    await renderApp({
      handlers: {
        ...HANDLERS,
        'session:list': () => [
          session({ id: 'draft', name: 'Brouillon du jeudi', updatedAt: '2026-10-01T10:00:00.000Z' }),
          session({
            id: 'live',
            name: 'Soirée Zelda',
            status: 'hosting',
            hostingMode: 'local',
            updatedAt: '2026-10-16T21:00:00.000Z',
          }),
          session({
            id: 'seed',
            name: 'Seed prête',
            status: 'generated',
            updatedAt: '2026-10-15T10:00:00.000Z',
          }),
          session({
            id: 'web',
            name: 'Async du mois',
            status: 'finished',
            hostingMode: 'web',
            updatedAt: '2026-10-14T10:00:00.000Z',
          }),
          session({
            id: 'old',
            name: 'Vieille partie',
            status: 'finished',
            hostingMode: 'local',
            updatedAt: '2026-10-13T10:00:00.000Z',
          }),
        ],
      },
    })
    const recent = await screen.findByRole('region', { name: 'Parties récentes' })
    const links = await within(recent).findAllByRole('link')
    // Most recent first, each to where the game continues.
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      [expect.stringMatching(/Soirée Zelda.*En cours.*Reprendre/), '#/play/live'],
      [expect.stringMatching(/Seed prête.*Générée.*Héberger/), '#/session/seed?step=5'],
      [expect.stringMatching(/Async du mois.*Terminée.*Rouvrir la room/), '#/play/web'],
      [expect.stringMatching(/Vieille partie.*Terminée.*Héberger/), '#/session/old?step=5'],
      [expect.stringMatching(/Brouillon du jeudi.*Brouillon.*Continuer/), '#/session/draft'],
    ])
    expect(links[0]).toHaveTextContent('Joueurs : 3')
    expect(links[0]).toHaveTextContent('Serveur local')
  })

  it('invites to organize a first game when there is no session', async () => {
    const { user } = await renderApp({ handlers: HANDLERS })
    const recent = await screen.findByRole('region', { name: 'Parties récentes' })
    expect(await within(recent).findByRole('heading', { name: 'Aucune partie pour l’instant' })).toBeVisible()
    await user.click(within(recent).getByRole('button', { name: 'Organiser une partie' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Partie' })).toBeInTheDocument()
  })

  it('speaks English', async () => {
    await renderApp({ handlers: HANDLERS, config: { language: 'en' }, waitForShell: false })
    const stats = await screen.findByRole('region', { name: 'Your setup' })
    expect(await within(stats).findByRole('button', { name: 'Worlds 4 To check: 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /PLAYER 1.*Host a game/ })).toBeInTheDocument()
  })
})
