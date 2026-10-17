import { screen, waitFor, within } from '@testing-library/react'
import { ROM_TABLE } from '@shared/data/rom-table'
import { AppError } from '@shared/errors'
import type { BizhawkState, RomRecord, VaultApplyResult } from '@shared/types'
import { VaultScreen } from '@renderer/features/vault/VaultScreen'
import { goatError, installGoatMock, type GoatHandlers } from './goat-mock'
import { renderWithProviders } from './render-app'

const EMERALD: RomRecord = {
  path: 'D:\\ROMs\\GBA\\Pokemon - Emerald Version (USA, Europe).gba',
  size: 16_777_216,
  mtimeMs: 1_760_000_000_000,
  md5: '605b89b67018abcea91e693a4dd25be3',
  game: 'Pokemon Emerald',
  label: 'Pokemon Emerald (USA, Europe)',
  settingsKey: 'pokemon_emerald_settings.rom_file',
}

const LTTP: RomRecord = {
  path: 'D:\\ROMs\\SNES\\Zelda no Densetsu - Kamigami no Triforce (Japan).sfc',
  size: 1_048_576,
  mtimeMs: 1_760_000_000_000,
  md5: '03a63945398191337e896e5771f77173',
  game: 'A Link to the Past',
  label: 'A Link to the Past (Japan, v1.0)',
  settingsKey: 'lttp_options.rom_file',
}

const UNKNOWN: RomRecord = {
  path: 'D:\\ROMs\\GBA\\Pokemon - Version Emeraude (France).gba',
  size: 16_777_216,
  mtimeMs: 1_760_000_000_000,
  md5: '9f2d1b4c6e8a0b2c4d6e8f0a1b3c5d7e',
  game: null,
  label: null,
  settingsKey: null,
}

const NO_BIZHAWK: BizhawkState = {
  installed: false,
  managed: false,
  version: null,
  path: null,
  configuredInAp: false,
  prereqs: [{ name: 'vc_redist.x64', ok: true, hint: null }],
}

const LINUX_COMMAND = 'sudo apt install mono-complete lua5.4 libopenal1'

/** The channels the screen reads on mount, with an empty vault and no BizHawk. */
function handlers(overrides: GoatHandlers = {}): GoatHandlers {
  return {
    'vault:list': () => [],
    'vault:table': () => ROM_TABLE,
    'bizhawk:state': () => NO_BIZHAWK,
    ...overrides,
  }
}

describe('VaultScreen', () => {
  it('scan task fills recognised roms list', async () => {
    let stored: RomRecord[] = []
    const goat = installGoatMock(
      handlers({
        'vault:list': () => stored,
        'app:pickPaths': () => ['D:\\ROMs'],
        'vault:scan': () => ({ taskId: 'scan-1' }),
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)

    expect(await screen.findByRole('heading', { name: 'Ton coffre est vide' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Scanner un dossier' }))

    await waitFor(() => expect(goat.inputsOf('vault:scan')).toEqual([{ paths: ['D:\\ROMs'] }]))
    expect(goat.inputsOf('app:pickPaths')).toEqual([
      expect.objectContaining({ mode: 'directory', title: 'Choisis le dossier de tes ROMs' }),
    ])

    goat.emit('task:progress', { taskId: 'scan-1', kind: 'rom-scan', stage: 'hash', percent: 40 })
    const progress = await screen.findByRole('progressbar', { name: 'Recherche de ROMs…' })
    expect(progress).toHaveAttribute('aria-valuenow', '40')

    // The vault keeps what the scan found; the task result is what this scan saw.
    stored = [EMERALD, LTTP, UNKNOWN]
    goat.emit('task:done', { taskId: 'scan-1', kind: 'rom-scan', result: stored })

    const recognised = await screen.findByRole('list', { name: 'ROMs reconnues' })
    const emerald = within(recognised).getByText('Pokemon Emerald').closest('li') as HTMLElement
    expect(within(emerald).getByText('Pokemon Emerald (USA, Europe)')).toBeInTheDocument()
    expect(within(emerald).getByText('MD5 ✓')).toBeInTheDocument()
    expect(within(emerald).getByText('Pokemon - Emerald Version (USA, Europe).gba')).toBeInTheDocument()
    expect(within(emerald).getByText('D:\\ROMs\\GBA')).toBeInTheDocument()
    expect(within(recognised).getByText('A Link to the Past')).toBeInTheDocument()
    expect(within(recognised).getAllByRole('listitem')).toHaveLength(2)

    const unknown = screen.getByRole('list', { name: 'ROMs non reconnues' })
    expect(within(unknown).getByText('Pokemon - Version Emeraude (France).gba')).toBeInTheDocument()
    expect(within(unknown).getByText('MD5 inconnu')).toBeInTheDocument()

    expect(screen.getByText('Scan terminé')).toBeInTheDocument()
    // getByText collapses no-break spaces into plain ones.
    expect(screen.getByText('Reconnues : 2 · non reconnues : 1')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: 'Recherche de ROMs…' })).toBeNull()

    // Hiding the summary hands keyboard focus back to the scan button, not to the page.
    await user.click(screen.getByRole('button', { name: 'Masquer le résumé du scan' }))
    expect(screen.queryByText('Scan terminé')).toBeNull()
    expect(screen.getByRole('button', { name: 'Scanner un dossier' })).toHaveFocus()
  })

  it('apply shows applied and skipped with reasons', async () => {
    const result: VaultApplyResult = {
      applied: [{ game: 'Pokemon Emerald', key: 'pokemon_emerald_settings.rom_file', path: EMERALD.path }],
      skipped: [{ game: 'A Link to the Past', reason: 'SETTINGS_LOCKED' }],
    }
    const goat = installGoatMock(
      handlers({ 'vault:list': () => [EMERALD, LTTP], 'vault:apply': () => result }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)

    expect(await screen.findByText('Prêtes pour Archipelago : 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Appliquer à Archipelago' }))
    await waitFor(() => expect(goat.inputsOf('vault:apply')).toHaveLength(1))

    const applied = await screen.findByRole('list', { name: 'Appliquées\u00a0: 1' })
    expect(within(applied).getByText('Pokemon Emerald')).toBeInTheDocument()
    expect(within(applied).getByText('pokemon_emerald_settings.rom_file')).toBeInTheDocument()
    expect(within(applied).getByText(EMERALD.path)).toBeInTheDocument()

    const skipped = screen.getByRole('list', { name: 'Ignorées\u00a0: 1' })
    expect(within(skipped).getByText('A Link to the Past')).toBeInTheDocument()
    expect(within(skipped).getByText('Les réglages d’Archipelago sont verrouillés')).toBeInTheDocument()
    expect(
      within(skipped).getByText(
        'Un autre programme utilise le fichier de réglages. Ferme Archipelago et réessaie.',
      ),
    ).toBeInTheDocument()

    // Partly applied: the toast says so.
    expect(await screen.findByText('Certaines ROMs ont été ignorées')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Masquer le résultat' }))
    expect(screen.queryByRole('list', { name: 'Appliquées\u00a0: 1' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Appliquer à Archipelago' })).toHaveFocus()
  })

  it('bizhawk card shows missing prereqs with copyable linux command', async () => {
    const state: BizhawkState = {
      installed: true,
      managed: true,
      version: '2.11.1',
      path: '/home/joueur/.local/share/ArchipelaGOAT/emulators/bizhawk-2.11.1',
      configuredInAp: true,
      prereqs: [
        { name: 'mono', ok: false, hint: LINUX_COMMAND },
        { name: 'lua5.4', ok: false, hint: LINUX_COMMAND },
        { name: 'lsb_release', ok: true, hint: null },
        { name: 'libopenal', ok: false, hint: LINUX_COMMAND },
      ],
    }
    installGoatMock(handlers({ 'bizhawk:state': () => state }), { info: { os: 'linux' } })
    const { user } = await renderWithProviders(<VaultScreen />)

    const card = await screen.findByRole('region', { name: 'BizHawk' })
    expect(await within(card).findByText('Prérequis manquants')).toBeInTheDocument()

    const prereqs = within(card).getByRole('list', { name: 'Prérequis' })
    const items = within(prereqs).getAllByRole('listitem')
    expect(items.map((item) => item.querySelector('code')?.textContent)).toEqual([
      'mono',
      'lua5.4',
      'lsb_release',
      'libopenal',
    ])
    expect(within(items[0] as HTMLElement).getByText('Manquant')).toBeInTheDocument()
    expect(
      within(items[0] as HTMLElement).getByText('Mono, qui fait tourner BizHawk sous Linux'),
    ).toBeInTheDocument()
    expect(within(items[2] as HTMLElement).getByText('Présent')).toBeInTheDocument()

    // One command for the three missing packages, shown once.
    const command = within(card).getByRole('group', { name: 'Commande d’installation' })
    expect(within(command).getByText(LINUX_COMMAND)).toBeInTheDocument()
    expect(within(card).getAllByText(LINUX_COMMAND)).toHaveLength(1)
    await user.click(within(command).getByRole('button', { name: 'Copier' }))
    expect(await within(command).findByRole('button', { name: 'Copié' })).toBeInTheDocument()
    await expect(navigator.clipboard.readText()).resolves.toBe(LINUX_COMMAND)

    expect(within(card).getByText('2.11.1')).toBeInTheDocument()
    expect(within(card).getByText('Installé par ArchipelaGOAT')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /Installer BizHawk/ })).toBeNull()
  })

  it('installs BizHawk with a task, then configures Archipelago', async () => {
    const installed: BizhawkState = {
      installed: true,
      managed: true,
      version: '2.11.1',
      path: 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\emulators\\bizhawk-2.11.1',
      configuredInAp: false,
      prereqs: [{ name: 'vc_redist.x64', ok: true, hint: null }],
    }
    const goat = installGoatMock(
      handlers({
        'bizhawk:install': () => ({ taskId: 'bh-1' }),
        'bizhawk:configureAp': () => ({ ...installed, configuredInAp: true }),
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)
    const card = await screen.findByRole('region', { name: 'BizHawk' })
    expect(await within(card).findByText('Pas installé')).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Installer BizHawk 2.11.1' }))
    await waitFor(() => expect(goat.inputsOf('bizhawk:install')).toHaveLength(1))
    goat.emit('task:progress', { taskId: 'bh-1', kind: 'bizhawk-install', stage: 'download', percent: 55 })
    expect(
      await within(card).findByRole('progressbar', { name: 'Installation de BizHawk…' }),
    ).toHaveAttribute('aria-valuenow', '55')

    goat.emit('task:done', { taskId: 'bh-1', kind: 'bizhawk-install', result: installed })
    expect(await screen.findByText('BizHawk 2.11.1 est installé')).toBeInTheDocument()
    expect(await within(card).findByText('À configurer')).toBeInTheDocument()
    expect(within(card).getByText(installed.path as string)).toBeInTheDocument()
    expect(within(card).getByText('Pas encore configuré')).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Configurer Archipelago' }))
    await waitFor(() => expect(goat.inputsOf('bizhawk:configureAp')).toHaveLength(1))
    expect(await within(card).findByText('Prêt')).toBeInTheDocument()
    expect(within(card).getByText('Configuré')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Configurer Archipelago' })).toBeNull()
  })

  it('reports a failed BizHawk install with its translated error', async () => {
    const goat = installGoatMock(
      handlers({
        'bizhawk:install': () => ({ taskId: 'bh-2' }),
        'app:pickPaths': () => ['E:\\BizHawk'],
        'bizhawk:setPath': () => NO_BIZHAWK,
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)
    const card = await screen.findByRole('region', { name: 'BizHawk' })
    await user.click(await within(card).findByRole('button', { name: 'Installer BizHawk 2.11.1' }))
    await waitFor(() => expect(goat.inputsOf('bizhawk:install')).toHaveLength(1))

    goat.emit('task:failed', {
      taskId: 'bh-2',
      kind: 'bizhawk-install',
      error: goatError('DOWNLOAD_HASH_MISMATCH'),
    })
    const alert = await within(card).findByRole('alert')
    expect(within(alert).getByText('Le téléchargement est corrompu')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Installer BizHawk 2.11.1' })).toBeEnabled()

    // The next action replaces the error.
    await user.click(within(card).getByRole('button', { name: 'Choisir un BizHawk existant' }))
    await waitFor(() => expect(goat.inputsOf('bizhawk:setPath')).toEqual([{ path: 'E:\\BizHawk' }]))
    await waitFor(() => expect(within(card).queryByRole('alert')).toBeNull())
  })

  it('uses an existing BizHawk folder and can forget it', async () => {
    const external: BizhawkState = {
      installed: true,
      managed: false,
      version: '2.9.1',
      path: 'E:\\Emulateurs\\BizHawk',
      configuredInAp: true,
      prereqs: [{ name: 'vc_redist.x64', ok: true, hint: null }],
    }
    const goat = installGoatMock(
      handlers({
        'app:pickPaths': () => ['E:\\Emulateurs\\BizHawk'],
        'bizhawk:setPath': ({ path }) => (path ? external : NO_BIZHAWK),
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)
    const card = await screen.findByRole('region', { name: 'BizHawk' })

    await user.click(await within(card).findByRole('button', { name: 'Choisir un BizHawk existant' }))
    await waitFor(() =>
      expect(goat.inputsOf('bizhawk:setPath')).toEqual([{ path: 'E:\\Emulateurs\\BizHawk' }]),
    )
    expect(goat.inputsOf('app:pickPaths')).toEqual([
      expect.objectContaining({ mode: 'directory', title: 'Choisis le dossier de BizHawk' }),
    ])
    expect(await within(card).findByText('Installation existante')).toBeInTheDocument()
    expect(within(card).getByText('2.9.1')).toBeInTheDocument()
    // An older BizHawk can move to the version the app installs.
    expect(within(card).getByRole('button', { name: 'Installer BizHawk 2.11.1' })).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Oublier ce chemin' }))
    await waitFor(() =>
      expect(goat.inputsOf('bizhawk:setPath')).toEqual([{ path: 'E:\\Emulateurs\\BizHawk' }, { path: null }]),
    )
    expect(await within(card).findByText('Pas installé')).toBeInTheDocument()
  })

  it('opens the official page for a prerequisite whose hint is a link', async () => {
    const url = 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist'
    const goat = installGoatMock(
      handlers({
        'bizhawk:state': () => ({
          ...NO_BIZHAWK,
          prereqs: [{ name: 'vc_redist.x64', ok: false, hint: url }],
        }),
        'app:openExternal': () => undefined,
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)
    const card = await screen.findByRole('region', { name: 'BizHawk' })
    expect(await within(card).findByText('Runtime Visual C++ x64 de Microsoft')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Ouvrir la page officielle' }))
    expect(goat.inputsOf('app:openExternal')).toEqual([{ url }])
    expect(within(card).queryByRole('group', { name: 'Commande d’installation' })).toBeNull()
  })

  it('lists the supported games with their vault status, under the legal notice, without any link', async () => {
    installGoatMock(handlers({ 'vault:list': () => [EMERALD, UNKNOWN] }))
    await renderWithProviders(<VaultScreen />)

    expect(screen.getByText('ArchipelaGOAT ne fournit aucune ROM.')).toBeInTheDocument()

    const games = await screen.findByRole('region', { name: 'Jeux pris en charge' })
    const generation = await within(games).findByRole('table', { name: 'Pour générer une partie' })
    const lttp = within(generation).getByText('A Link to the Past').closest('tr') as HTMLElement
    expect(within(lttp).getByText('A Link to the Past (Japan, v1.0)')).toBeInTheDocument()
    expect(within(lttp).getByText('lttp_options.rom_file')).toBeInTheDocument()
    expect(within(lttp).getByText('Absente')).toBeInTheDocument()

    const play = within(games).getByRole('table', { name: 'Pour jouer' })
    const emerald = within(play).getByText('Pokemon Emerald').closest('tr') as HTMLElement
    expect(within(emerald).getByText('Trouvée')).toBeInTheDocument()

    const atGeneration = ROM_TABLE.filter((entry) => entry.requiredAtGeneration).length
    expect(within(generation).getAllByRole('row')).toHaveLength(atGeneration + 1)
    expect(within(play).getAllByRole('row')).toHaveLength(ROM_TABLE.length - atGeneration + 1)
    expect(within(games).getByText(`Dans ton coffre : 1 / ${ROM_TABLE.length}`)).toBeInTheDocument()

    // No ROM is ever offered: the screen has no link at all.
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('adds single files through a ROM file filter', async () => {
    const goat = installGoatMock(
      handlers({
        'app:pickPaths': () => ['D:\\ROMs\\GBA\\emerald.gba', 'D:\\ROMs\\SNES\\lttp.sfc'],
        'vault:scan': () => ({ taskId: 'scan-2' }),
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)
    await user.click(await screen.findByRole('button', { name: 'Ajouter des fichiers' }))
    await waitFor(() =>
      expect(goat.inputsOf('vault:scan')).toEqual([
        { paths: ['D:\\ROMs\\GBA\\emerald.gba', 'D:\\ROMs\\SNES\\lttp.sfc'] },
      ]),
    )
    const [pick] = goat.inputsOf('app:pickPaths')
    expect(pick).toMatchObject({ mode: 'files', title: 'Choisis tes ROMs' })
    expect(pick?.filters?.[0]?.name).toBe('ROMs')
    expect(pick?.filters?.[0]?.extensions).toEqual(expect.arrayContaining(['sfc', 'gba', 'z64']))
  })

  it('does not scan when the folder dialog is cancelled', async () => {
    const goat = installGoatMock(handlers({ 'app:pickPaths': () => [] }))
    const { user } = await renderWithProviders(<VaultScreen />)
    await user.click(await screen.findByRole('button', { name: 'Scanner un dossier' }))
    await waitFor(() => expect(goat.inputsOf('app:pickPaths')).toHaveLength(1))
    expect(goat.inputsOf('vault:scan')).toEqual([])
  })

  it('follows a scan and an install started elsewhere, and can stop them', async () => {
    const goat = installGoatMock(handlers({ 'tasks:cancel': () => undefined }))
    const { user } = await renderWithProviders(<VaultScreen />)
    const card = await screen.findByRole('region', { name: 'BizHawk' })
    await within(card).findByRole('button', { name: 'Installer BizHawk 2.11.1' })

    // Started from the Join screen: this screen never got the TaskRefs.
    goat.emit('task:progress', { taskId: 'join-scan', kind: 'rom-scan', stage: 'hash', percent: 10 })
    goat.emit('task:progress', { taskId: 'join-bh', kind: 'bizhawk-install', stage: 'extract', percent: 80 })

    expect(await screen.findByRole('progressbar', { name: 'Recherche de ROMs…' })).toHaveAttribute(
      'aria-valuenow',
      '10',
    )
    expect(within(card).getByRole('progressbar', { name: 'Installation de BizHawk…' })).toHaveAttribute(
      'aria-valuenow',
      '80',
    )
    expect(within(card).queryByRole('button', { name: 'Installer BizHawk 2.11.1' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Arrêter le scan' }))
    await user.click(within(card).getByRole('button', { name: 'Annuler l’installation' }))
    expect(goat.inputsOf('tasks:cancel')).toEqual([{ taskId: 'join-scan' }, { taskId: 'join-bh' }])

    goat.emit('task:failed', { taskId: 'join-scan', kind: 'rom-scan', error: goatError('TASK_CANCELLED') })
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'Recherche de ROMs…' })).toBeNull())
  })

  it('shows why its scan failed, but not a cancelled scan', async () => {
    let next = 0
    const goat = installGoatMock(
      handlers({
        'app:pickPaths': () => ['D:\\ROMs'],
        'vault:scan': () => ({ taskId: `scan-${++next}` }),
        'tasks:cancel': () => undefined,
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)
    const vault = await screen.findByRole('region', { name: 'Coffre à ROMs' })

    await user.click(within(vault).getByRole('button', { name: 'Scanner un dossier' }))
    await waitFor(() => expect(goat.inputsOf('vault:scan')).toHaveLength(1))
    goat.emit('task:failed', { taskId: 'scan-1', kind: 'rom-scan', error: goatError('PATH_FORBIDDEN') })
    const alert = await within(vault).findByRole('alert')
    expect(within(alert).getByText('Accès refusé à cet emplacement')).toBeInTheDocument()

    await user.click(within(vault).getByRole('button', { name: 'Scanner un dossier' }))
    await waitFor(() => expect(goat.inputsOf('vault:scan')).toHaveLength(2))
    goat.emit('task:progress', { taskId: 'scan-2', kind: 'rom-scan', stage: 'hash', percent: 5 })
    await user.click(await within(vault).findByRole('button', { name: 'Arrêter le scan' }))
    expect(goat.inputsOf('tasks:cancel')).toEqual([{ taskId: 'scan-2' }])
    goat.emit('task:failed', { taskId: 'scan-2', kind: 'rom-scan', error: goatError('TASK_CANCELLED') })
    await waitFor(() => expect(within(vault).queryByRole('progressbar')).toBeNull())
    expect(within(vault).queryByRole('alert')).toBeNull()
  })

  it('removes a ROM reference from the vault', async () => {
    let stored = [EMERALD, UNKNOWN]
    const goat = installGoatMock(
      handlers({
        'vault:list': () => stored,
        'vault:remove': ({ path }) => {
          stored = stored.filter((record) => record.path !== path)
        },
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)
    await user.click(
      await screen.findByRole('button', {
        name: 'Retirer Pokemon - Version Emeraude (France).gba du coffre',
      }),
    )
    await waitFor(() => expect(goat.inputsOf('vault:remove')).toEqual([{ path: UNKNOWN.path }]))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'ROMs non reconnues' })).toBeNull())
    expect(screen.getByRole('list', { name: 'ROMs reconnues' })).toBeInTheDocument()
  })

  it('shows load and apply errors translated, with a retry', async () => {
    let fail = true
    installGoatMock(
      handlers({
        'vault:list': () => {
          if (fail) throw new AppError('PATH_FORBIDDEN')
          return [LTTP]
        },
        'vault:apply': () => {
          throw new AppError('SETTINGS_LOCKED')
        },
      }),
    )
    const { user } = await renderWithProviders(<VaultScreen />)

    const vault = await screen.findByRole('region', { name: 'Coffre à ROMs' })
    const loadError = await within(vault).findByRole('alert')
    expect(within(loadError).getByText('Accès refusé à cet emplacement')).toBeInTheDocument()
    fail = false
    await user.click(within(loadError).getByRole('button', { name: 'Réessayer' }))
    expect(await within(vault).findByText('A Link to the Past')).toBeInTheDocument()

    await user.click(within(vault).getByRole('button', { name: 'Appliquer à Archipelago' }))
    const applyError = await within(vault).findByRole('alert')
    expect(within(applyError).getByText('Les réglages d’Archipelago sont verrouillés')).toBeInTheDocument()
  })

  it('speaks English', async () => {
    installGoatMock(handlers({ 'vault:list': () => [EMERALD] }))
    await renderWithProviders(<VaultScreen />, { lang: 'en' })
    expect(screen.getByText('ArchipelaGOAT does not provide any ROM.')).toBeInTheDocument()
    expect(await screen.findByRole('list', { name: 'Recognised ROMs' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply to Archipelago' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan a folder' })).toBeInTheDocument()
  })
})
