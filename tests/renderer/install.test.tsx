import { screen, waitFor, within } from '@testing-library/react'
import { AppError } from '@shared/errors'
import type { ApInstall, ApPaths, ApRelease } from '@shared/types'
import { InstallScreen } from '@renderer/features/install/InstallScreen'
import { goatError, installGoatMock, type GoatHandlers, type GoatMockOptions } from './goat-mock'
import { renderWithProviders } from './render-app'

const ROOT = 'C:\\ProgramData\\Archipelago'

function pathsOf(root: string): ApPaths {
  return {
    localPath: root,
    userPath: root,
    customWorlds: `${root}\\custom_worlds`,
    coreWorlds: `${root}\\lib\\worlds`,
    players: `${root}\\Players`,
    templates: `${root}\\Players\\Templates`,
    output: `${root}\\output`,
    logs: `${root}\\logs`,
    cache: 'C:\\Users\\Joueur\\AppData\\Local\\Archipelago\\Cache',
    settingsFile: `${root}\\host.yaml`,
  }
}

function apInstall(overrides: Partial<ApInstall> = {}): ApInstall {
  const root = overrides.root ?? ROOT
  return {
    kind: 'windows-installer',
    version: '0.6.8',
    root,
    appImagePath: null,
    paths: pathsOf(root),
    ...overrides,
  }
}

function release(overrides: Partial<ApRelease> = {}): ApRelease {
  return {
    tag: '0.6.8',
    version: '0.6.8',
    publishedAt: '2026-09-28T18:00:00Z',
    notes: 'Fixes and new games.',
    windows: {
      name: 'Setup.Archipelago.0.6.8.exe',
      url: 'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.8/Setup.Archipelago.0.6.8.exe',
      size: 104_857_600,
      sha256: 'a'.repeat(64),
    },
    linuxTarGz: null,
    appImage: null,
    ...overrides,
  }
}

async function renderInstall(handlers: GoatHandlers = {}, options: GoatMockOptions = {}) {
  const goat = installGoatMock(
    { 'ap:detect': () => null, 'ap:latestRelease': () => release(), ...handlers },
    options,
  )
  const view = await renderWithProviders(<InstallScreen />)
  return { goat, ...view }
}

const INSTALL_BUTTON = 'Installer Archipelago 0.6.8'

describe('InstallScreen', () => {
  it('offers install when missing, update when older, nothing when up to date', async () => {
    const missing = await renderInstall({ 'ap:detect': () => null })
    expect(await screen.findByRole('heading', { name: 'Archipelago n’est pas installé' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: INSTALL_BUTTON })).toBeEnabled()
    missing.unmount()

    const older = await renderInstall({ 'ap:detect': () => apInstall({ version: '0.6.7' }) })
    expect(await screen.findByRole('button', { name: 'Mettre à jour vers 0.6.8' })).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'Une mise à jour est disponible' })).toBeInTheDocument()
    expect(screen.getByText('0.6.7')).toBeInTheDocument()
    older.unmount()

    await renderInstall({ 'ap:detect': () => apInstall({ version: '0.6.8' }) })
    expect(await screen.findByRole('heading', { name: 'Archipelago est à jour' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Installer|Mettre à jour)/ })).toBeNull()
  })

  it('shows staged progress from task events and success state', async () => {
    let current: ApInstall | null = null
    const { goat, user } = await renderInstall({
      'ap:detect': () => current,
      'ap:install': () => ({ taskId: 't1' }),
    })
    await user.click(await screen.findByRole('button', { name: INSTALL_BUTTON }))
    await waitFor(() => expect(goat.inputsOf('ap:install')).toEqual([{ desktopIcons: true }]))

    goat.emit('task:progress', { taskId: 't1', kind: 'ap-install', stage: 'download', percent: 42 })
    const steps = await screen.findByRole('list', { name: 'Étapes de l’installation' })
    expect(within(steps).getByText('Téléchargement').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('progressbar', { name: 'Téléchargement' })).toHaveAttribute('aria-valuenow', '42')
    expect(screen.queryByText(/vc_redist/)).toBeNull()

    goat.emit('task:progress', { taskId: 't1', kind: 'ap-install', stage: 'install', percent: null })
    expect(within(steps).getByText('Installation').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(within(steps).getByText('Quarantaine').closest('li')).toHaveAttribute('data-state', 'done')
    // Windows asks for consent (UAC), and vc_redist may show a small window.
    expect(screen.getByText(/vc_redist/)).toBeInTheDocument()

    current = apInstall({ version: '0.6.8' })
    goat.emit('task:done', { taskId: 't1', kind: 'ap-install', result: current })
    expect(await screen.findByRole('heading', { name: 'Archipelago 0.6.8 est installé' })).toBeInTheDocument()
    expect(screen.getByText(ROOT)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Continuer' }))
    expect(await screen.findByRole('heading', { name: 'Archipelago est à jour' })).toBeInTheDocument()
  })

  it('shows elevation denied error with retry', async () => {
    let next = 0
    const { goat, user } = await renderInstall({ 'ap:install': () => ({ taskId: `t${++next}` }) })
    await user.click(await screen.findByRole('button', { name: INSTALL_BUTTON }))
    await waitFor(() => expect(goat.inputsOf('ap:install')).toHaveLength(1))

    goat.emit('task:progress', { taskId: 't1', kind: 'ap-install', stage: 'install', percent: null })
    goat.emit('task:failed', {
      taskId: 't1',
      kind: 'ap-install',
      error: { code: 'INSTALL_ELEVATION_DENIED' },
    })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Autorisation administrateur refusée')).toBeInTheDocument()
    expect(within(alert).getByText(/accepte la demande/)).toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() =>
      expect(goat.inputsOf('ap:install')).toEqual([{ desktopIcons: true }, { desktopIcons: true }]),
    )
    goat.emit('task:progress', { taskId: 't2', kind: 'ap-install', stage: 'download', percent: 5 })
    expect(await screen.findByRole('progressbar', { name: 'Téléchargement' })).toHaveAttribute(
      'aria-valuenow',
      '5',
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows an install that fails to start, with retry', async () => {
    let calls = 0
    const { goat, user } = await renderInstall({
      'ap:install': () => {
        if (++calls === 1) throw new AppError('AP_RUNNING')
        return { taskId: 't1' }
      },
    })
    await user.click(await screen.findByRole('button', { name: INSTALL_BUTTON }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Archipelago est ouvert')).toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(goat.inputsOf('ap:install')).toHaveLength(2))
    expect(await screen.findByRole('list', { name: 'Étapes de l’installation' })).toBeInTheDocument()
  })

  it('uninstall requires confirmation and passes purgeUserData', async () => {
    let current: ApInstall | null = apInstall()
    const { goat, user } = await renderInstall({
      'ap:detect': () => current,
      'ap:uninstall': () => ({ taskId: 'u1' }),
    })
    await user.click(await screen.findByRole('button', { name: 'Désinstaller Archipelago' }))
    const dialog = await screen.findByRole('dialog', { name: 'Désinstaller Archipelago\u00a0?' })
    await user.click(within(dialog).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(goat.inputsOf('ap:uninstall')).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Désinstaller Archipelago' }))
    const again = await screen.findByRole('dialog', { name: 'Désinstaller Archipelago\u00a0?' })
    const purge = within(again).getByRole('checkbox', { name: 'Supprimer aussi mes données' })
    expect(purge).not.toBeChecked()
    await user.click(purge)
    expect(purge).toBeChecked()
    expect(within(again).getByText(/définitivement/)).toBeInTheDocument()
    expect(goat.inputsOf('ap:uninstall')).toEqual([])

    await user.click(within(again).getByRole('button', { name: 'Désinstaller et supprimer mes données' }))
    await waitFor(() => expect(goat.inputsOf('ap:uninstall')).toEqual([{ purgeUserData: true }]))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    current = null
    goat.emit('task:done', { taskId: 'u1', kind: 'ap-uninstall', result: null })
    expect(await screen.findByRole('heading', { name: 'Archipelago est désinstallé' })).toBeInTheDocument()
    expect(screen.getByText(/Tes données ont été supprimées/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continuer' }))
    expect(await screen.findByRole('button', { name: INSTALL_BUTTON })).toBeInTheDocument()
  })

  it('keeps user data by default when uninstalling', async () => {
    const { goat, user } = await renderInstall({
      'ap:detect': () => apInstall(),
      'ap:uninstall': () => ({ taskId: 'u1' }),
    })
    await user.click(await screen.findByRole('button', { name: 'Désinstaller Archipelago' }))
    const dialog = await screen.findByRole('dialog', { name: 'Désinstaller Archipelago\u00a0?' })
    await user.click(within(dialog).getByRole('button', { name: 'Désinstaller' }))
    await waitFor(() => expect(goat.inputsOf('ap:uninstall')).toEqual([{ purgeUserData: false }]))
  })

  it('explains a GitHub rate limit with its reset time and links to the settings', async () => {
    const resetAt = Date.now() + 25 * 60_000
    await renderInstall({
      'ap:latestRelease': () => {
        throw new AppError('GITHUB_RATE_LIMITED', { resetAt })
      },
    })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('GitHub limite les requêtes')).toBeInTheDocument()
    const time = new Intl.DateTimeFormat('fr', { hour: '2-digit', minute: '2-digit' }).format(resetAt)
    expect(within(alert).getByText(new RegExp(`Réessaie après .*${time}`))).toBeInTheDocument()
    expect(within(alert).getByRole('button', { name: 'Ouvrir les réglages' })).toBeInTheDocument()
    // Archipelago can still be installed: the install task fetches the release itself.
    expect(screen.getByRole('button', { name: 'Installer Archipelago' })).toBeEnabled()
  })

  it('checks for updates again on demand, bypassing the cache', async () => {
    let version = '0.6.8'
    const { goat, user } = await renderInstall({
      'ap:detect': () => apInstall({ version: '0.6.8' }),
      'ap:latestRelease': () => release({ version, tag: version }),
    })
    expect(await screen.findByRole('heading', { name: 'Archipelago est à jour' })).toBeInTheDocument()
    version = '0.6.9'
    await user.click(screen.getByRole('button', { name: 'Vérifier les mises à jour' }))
    expect(await screen.findByRole('button', { name: 'Mettre à jour vers 0.6.9' })).toBeInTheDocument()
    expect(goat.inputsOf('ap:latestRelease')).toContainEqual({ force: true })
  })

  it.each([
    {
      name: 'a hash mismatch',
      error: goatError('DOWNLOAD_HASH_MISMATCH', { expected: 'a'.repeat(64), actual: 'b'.repeat(64) }),
      fact: /Empreinte attendue\s: aaaaaaaaaaaa…aaaaaaaa · obtenue\s: bbbbbbbbbbbb…bbbbbbbb/,
    },
    {
      name: 'a size mismatch',
      error: goatError('DOWNLOAD_HASH_MISMATCH', { expectedSize: 104_857_600, actualSize: 52_428_800 }),
      fact: /Taille attendue\s: 104,9\sMo · reçue\s: 52,4\sMo/,
    },
    {
      name: 'an installer exit code',
      error: goatError('INSTALL_FAILED', { exitCode: 4, reason: 'Fatal error during install' }),
      fact: /Code de sortie 4\s: erreur fatale pendant l’installation/,
    },
    {
      name: 'an unknown exit code',
      error: goatError('INSTALL_FAILED', { exitCode: 87 }),
      fact: /Code de sortie 87$/,
    },
  ])('shows the facts of $name', async ({ error, fact }) => {
    const { goat, user } = await renderInstall({ 'ap:install': () => ({ taskId: 't1' }) })
    await user.click(await screen.findByRole('button', { name: INSTALL_BUTTON }))
    await waitFor(() => expect(goat.inputsOf('ap:install')).toHaveLength(1))
    goat.emit('task:failed', { taskId: 't1', kind: 'ap-install', error })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(fact)).toBeInTheDocument()
  })

  it('opens the log of a failed install', async () => {
    const { goat, user } = await renderInstall({
      'ap:install': () => ({ taskId: 't1' }),
      'app:openPath': () => undefined,
    })
    await user.click(await screen.findByRole('button', { name: INSTALL_BUTTON }))
    await waitFor(() => expect(goat.inputsOf('ap:install')).toHaveLength(1))
    const logPath = 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\logs\\inno.log'
    goat.emit('task:failed', {
      taskId: 't1',
      kind: 'ap-install',
      error: goatError('INSTALL_FAILED', { exitCode: 4 }, { logPath }),
    })
    const alert = await screen.findByRole('alert')
    await user.click(within(alert).getByRole('button', { name: 'Ouvrir le log' }))
    await waitFor(() => expect(goat.inputsOf('app:openPath')).toEqual([{ path: logPath }]))
  })

  it('renders the release notes as plain text', async () => {
    const { container } = await renderInstall({
      'ap:latestRelease': () =>
        release({ notes: '## Changes\n- <b>bold</b> & <img src=x onerror=alert(1)>' }),
    })
    const notes = await screen.findByText(/<b>bold<\/b>/)
    expect(notes.tagName).toBe('PRE')
    expect(notes.textContent).toBe('## Changes\n- <b>bold</b> & <img src=x onerror=alert(1)>')
    expect(container.querySelector('b, img')).toBeNull()
    // A named region the keyboard can reach and scroll.
    expect(screen.getByRole('region', { name: 'Notes de version d’Archipelago 0.6.8' })).toBe(notes)
    expect(notes).toHaveAttribute('tabindex', '0')
  })

  it('leaves a folder picked by hand to the user: no update, a way back to automatic detection', async () => {
    await renderInstall({
      'ap:detect': () => apInstall({ kind: 'custom', root: 'D:\\Jeux\\Archipelago', version: '0.6.7' }),
    })
    expect(await screen.findByRole('heading', { name: 'Une mise à jour est disponible' })).toBeInTheDocument()
    // Installing would target the usual folder, which the app does not use while this one is chosen.
    expect(screen.getByText(/ne met pas à jour un dossier choisi à la main/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Installer|Mettre à jour)/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Icônes sur le bureau' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Revenir à la détection automatique' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Désinstaller Archipelago' })).toBeNull()
  })

  it('installs into a custom folder, without desktop icons', async () => {
    const { goat, user } = await renderInstall({
      'ap:install': () => ({ taskId: 't1' }),
      'app:pickPaths': () => ['D:\\Jeux\\Archipelago'],
    })
    await user.click(await screen.findByRole('switch', { name: 'Icônes sur le bureau' }))
    await user.click(screen.getByText('Options avancées'))
    await user.click(screen.getByRole('button', { name: 'Choisir un dossier d’installation' }))
    expect(await screen.findByText('D:\\Jeux\\Archipelago')).toBeInTheDocument()
    expect(goat.inputsOf('app:pickPaths')).toEqual([expect.objectContaining({ mode: 'directory' })])

    await user.click(screen.getByRole('button', { name: INSTALL_BUTTON }))
    await waitFor(() =>
      expect(goat.inputsOf('ap:install')).toEqual([
        { desktopIcons: false, customDir: 'D:\\Jeux\\Archipelago' },
      ]),
    )
  })

  it('points the app at an existing install, then back to automatic detection', async () => {
    let current: ApInstall | null = null
    const { goat, user } = await renderInstall({
      'ap:detect': () => current,
      'app:pickPaths': () => ['D:\\Jeux\\Archipelago'],
      'ap:setCustomPath': ({ path }) => {
        current = path ? apInstall({ kind: 'custom', root: path, version: '0.6.8' }) : null
        return current
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Choisir un dossier existant' }))
    await waitFor(() =>
      expect(goat.inputsOf('ap:setCustomPath')).toEqual([{ path: 'D:\\Jeux\\Archipelago' }]),
    )
    expect(goat.inputsOf('app:pickPaths')).toEqual([expect.objectContaining({ mode: 'directory' })])
    expect(await screen.findByRole('heading', { name: 'Archipelago est à jour' })).toBeInTheDocument()
    expect(screen.getByText('Dossier choisi à la main')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revenir à la détection automatique' }))
    await waitFor(() =>
      expect(goat.inputsOf('ap:setCustomPath')).toEqual([{ path: 'D:\\Jeux\\Archipelago' }, { path: null }]),
    )
    expect(await screen.findByRole('heading', { name: 'Archipelago n’est pas installé' })).toBeInTheDocument()
  })

  it('says so when the chosen folder holds no Archipelago, and ignores a cancelled picker', async () => {
    let picked: string[] = []
    const { goat, user } = await renderInstall({
      'app:pickPaths': () => picked,
      'ap:setCustomPath': () => {
        throw new AppError('AP_NOT_INSTALLED', undefined, { detail: 'D:\\Vide' })
      },
    })
    const choose = await screen.findByRole('button', { name: 'Choisir un dossier existant' })
    await user.click(choose)
    await waitFor(() => expect(goat.inputsOf('app:pickPaths')).toHaveLength(1))
    expect(goat.inputsOf('ap:setCustomPath')).toEqual([])

    picked = ['D:\\Vide']
    await user.click(choose)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Aucun Archipelago dans ce dossier')).toBeInTheDocument()
  })

  it('picks up an install that is already running', async () => {
    await renderInstall({
      'tasks:list': () => [{ taskId: 't9', kind: 'ap-install', stage: 'verify', percent: 100 }],
    })
    const steps = await screen.findByRole('list', { name: 'Étapes de l’installation' })
    expect(within(steps).getByText('Vérification').closest('li')).toHaveAttribute('aria-current', 'step')
  })

  it('on Linux, offers the managed install for an AppImage and leaves the Windows notes out', async () => {
    const appImage = apInstall({
      kind: 'linux-appimage',
      version: '0.6.8',
      root: '/home/joueur/Applications',
      appImagePath: '/home/joueur/Applications/Archipelago_0.6.8_linux-x86_64.AppImage',
    })
    await renderInstall({ 'ap:detect': () => appImage }, { info: { os: 'linux' } })
    expect(await screen.findByRole('button', { name: 'Passer à l’installation gérée' })).toBeEnabled()
    expect(screen.queryByText(/UAC/)).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Icônes sur le bureau' })).toBeNull()
    // An AppImage is not the app's to remove.
    expect(screen.queryByRole('button', { name: 'Désinstaller Archipelago' })).toBeNull()
  })

  it('speaks English', async () => {
    installGoatMock({ 'ap:detect': () => null, 'ap:latestRelease': () => release() })
    await renderWithProviders(<InstallScreen />, { lang: 'en' })
    expect(await screen.findByRole('heading', { name: 'Archipelago is not installed' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Install Archipelago 0.6.8' })).toBeInTheDocument()
  })
})
