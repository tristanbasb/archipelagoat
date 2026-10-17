import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { AppError } from '@shared/errors'
import type { ApInstall, IntegrationState } from '@shared/types'
import { AboutPanel } from '@renderer/features/settings/AboutPanel'
import { parseLicenses } from '@renderer/features/settings/licenses'
import { installGoatMock, TEST_INFO } from './goat-mock'
import { renderApp, renderWithProviders, type RenderAppOptions } from './render-app'

function fxRoot(): Element {
  const root = document.querySelector('[data-fx-root]')
  if (!root) throw new Error('no fx root')
  return root
}

const AP_INSTALL: ApInstall = {
  kind: 'windows-installer',
  version: '0.6.8',
  root: 'C:\\ProgramData\\Archipelago',
  appImagePath: null,
  paths: {
    localPath: 'C:\\ProgramData\\Archipelago',
    userPath: 'C:\\ProgramData\\Archipelago',
    customWorlds: 'C:\\ProgramData\\Archipelago\\custom_worlds',
    coreWorlds: 'C:\\ProgramData\\Archipelago\\lib\\worlds',
    players: 'C:\\ProgramData\\Archipelago\\Players',
    templates: 'C:\\ProgramData\\Archipelago\\Players\\Templates',
    output: 'C:\\ProgramData\\Archipelago\\output',
    logs: 'C:\\ProgramData\\Archipelago\\logs',
    cache: 'C:\\ProgramData\\Archipelago\\cache',
    settingsFile: 'C:\\ProgramData\\Archipelago\\host.yaml',
  },
}

const NO_INTEGRATION: IntegrationState = {
  linuxDesktop: false,
  winProtocol: false,
  winAssociations: false,
  available: { linuxDesktop: false, winProtocol: true, winAssociations: false },
}

/** The settings screen with every channel it reads answered (tests override what they need). */
async function renderSettings(options: RenderAppOptions = {}): ReturnType<typeof renderApp> {
  const result = await renderApp({
    route: '/settings',
    ...options,
    handlers: {
      'ap:detect': () => AP_INSTALL,
      'system:integration': () => NO_INTEGRATION,
      'app:secretsStatus': () => ({ canEncrypt: true, hasGithubToken: false }),
      ...options.handlers,
    },
  })
  await screen.findByRole('heading', { level: 1, name: /Réglages|Settings/ })
  return result
}

describe('settings screen', () => {
  it('switching language updates UI text immediately', async () => {
    const { user, goat } = await renderSettings()
    const language = screen.getByRole('radiogroup', { name: 'Langue' })
    expect(within(language).getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true')

    await user.click(within(language).getByRole('radio', { name: 'English' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeInTheDocument()
    expect(goat.inputsOf('app:setConfig')).toEqual([{ language: 'en' }])
    expect(goat.config().language).toBe('en')
  })

  it('disabling animations puts fx-no-anim on the fx root', async () => {
    const { user, goat } = await renderSettings()
    const animations = screen.getByRole('switch', { name: 'Animations' })
    expect(animations).toHaveAttribute('aria-checked', 'true')
    expect(fxRoot()).not.toHaveClass('fx-no-anim')

    await user.click(animations)

    expect(fxRoot()).toHaveClass('fx-no-anim')
    expect(fxRoot()).not.toHaveClass('fx-off')
    expect(fxRoot()).not.toHaveClass('fx-no-crt')
    expect(animations).toHaveAttribute('aria-checked', 'false')
    expect(goat.inputsOf('app:setConfig')).toEqual([{ effects: { animations: false } }])
  })

  it('the other effects and the 18+ worlds patch the config one field at a time', async () => {
    const { user, goat } = await renderSettings()
    await user.click(screen.getByRole('switch', { name: 'Écran CRT' }))
    await user.click(screen.getByRole('switch', { name: 'Sons' }))
    await user.click(screen.getByRole('switch', { name: 'Mondes 18+' }))

    await waitFor(() => expect(fxRoot()).toHaveClass('fx-no-crt'))
    expect(goat.inputsOf('app:setConfig')).toEqual([
      { effects: { crt: false } },
      { effects: { sounds: true } },
      { showAfterDark: true },
    ])
    expect(screen.getByRole('switch', { name: 'Mondes 18+' })).toHaveAttribute('aria-checked', 'true')
  })

  it('a refused config change rolls the switch back and says why', async () => {
    const { user } = await renderSettings({
      handlers: {
        'app:setConfig': () => {
          throw new AppError('INVALID_INPUT')
        },
      },
    })
    const glow = screen.getByRole('switch', { name: 'Glow néon' })
    await user.click(glow)
    expect(await screen.findByText('Requête invalide')).toBeInTheDocument()
    expect(glow).toHaveAttribute('aria-checked', 'true')
  })

  it('integration toggles call system:setIntegration and reflect availability', async () => {
    let state = NO_INTEGRATION
    const { user, goat } = await renderSettings({
      handlers: {
        'system:integration': () => state,
        'system:setIntegration': (patch) => {
          state = { ...state, ...patch }
          return state
        },
      },
    })
    const protocol = await screen.findByRole('switch', { name: 'Ouvrir les liens archipelago:// ici' })
    const associations = screen.getByRole('switch', { name: 'Ouvrir les fichiers .apsml2 ici' })
    expect(protocol).toBeEnabled()
    expect(protocol).toHaveAttribute('aria-checked', 'false')
    // Not available here: shown, but switched off for good, with the reason.
    expect(associations).toBeDisabled()
    expect(associations).toHaveAccessibleDescription(/Pas disponible sur ce système/)
    // The Linux desktop integration does not concern Windows.
    expect(screen.queryByRole('switch', { name: /bureau/ })).toBeNull()

    await user.click(protocol)

    await waitFor(() => expect(protocol).toHaveAttribute('aria-checked', 'true'))
    expect(goat.inputsOf('system:setIntegration')).toEqual([{ winProtocol: true }])

    cleanup()
    const linux: IntegrationState = {
      ...NO_INTEGRATION,
      linuxDesktop: true,
      available: { linuxDesktop: true, winProtocol: false, winAssociations: false },
    }
    await renderSettings({ info: { os: 'linux' }, handlers: { 'system:integration': () => linux } })
    const desktop = await screen.findByRole('switch', { name: 'Intégrer ArchipelaGOAT au bureau' })
    expect(desktop).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('switch', { name: /archipelago:\/\// })).toBeNull()
    expect(screen.queryByRole('switch', { name: /\.apsml2/ })).toBeNull()
  })

  it('shows why the system integration cannot be read, with a retry', async () => {
    let fail = true
    const { user } = await renderSettings({
      handlers: {
        'system:integration': () => {
          if (fail) throw new AppError('NOT_IMPLEMENTED')
          return NO_INTEGRATION
        },
      },
    })
    const panel = screen.getByRole('region', { name: 'Intégration au système' })
    expect(await within(panel).findByText('Cette fonction n’est pas encore disponible')).toBeInTheDocument()
    fail = false
    await user.click(within(panel).getByRole('button', { name: 'Réessayer' }))
    expect(
      await within(panel).findByRole('switch', { name: 'Ouvrir les liens archipelago:// ici' }),
    ).toBeInTheDocument()
  })

  it('github token field is write-only and shows saved state', async () => {
    let hasGithubToken = false
    const { user, goat } = await renderSettings({
      handlers: {
        'app:secretsStatus': () => ({ canEncrypt: true, hasGithubToken }),
        'app:setGithubToken': ({ token }) => {
          hasGithubToken = token !== null
          return { hasToken: hasGithubToken }
        },
      },
    })
    const panel = screen.getByRole('region', { name: 'Jeton GitHub' })
    expect(await within(panel).findByText('Aucun jeton enregistré')).toBeInTheDocument()
    const field = within(panel).getByLabelText('Nouveau jeton')
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveAttribute('autocomplete', 'off')
    const save = within(panel).getByRole('button', { name: 'Enregistrer le jeton' })
    expect(save).toBeDisabled()

    await user.type(field, '  ghp_s3cretT0ken  ')
    await user.click(save)

    expect(await within(panel).findByText('Jeton enregistré')).toBeInTheDocument()
    expect(goat.inputsOf('app:setGithubToken')).toEqual([{ token: 'ghp_s3cretT0ken' }])
    // Never read back nor kept on screen.
    expect(field).toHaveValue('')
    expect(document.body.textContent).not.toContain('ghp_s3cretT0ken')

    await user.click(within(panel).getByRole('button', { name: 'Supprimer le jeton' }))
    expect(await within(panel).findByText('Aucun jeton enregistré')).toBeInTheDocument()
    expect(goat.inputsOf('app:setGithubToken')).toEqual([{ token: 'ghp_s3cretT0ken' }, { token: null }])
  })

  it('a token that cannot be stored says why', async () => {
    const { user } = await renderSettings({
      handlers: {
        'app:secretsStatus': () => ({ canEncrypt: false, hasGithubToken: false }),
        'app:setGithubToken': () => {
          throw new AppError('SECRETS_UNAVAILABLE')
        },
      },
    })
    const panel = screen.getByRole('region', { name: 'Jeton GitHub' })
    const field = await within(panel).findByLabelText('Nouveau jeton')
    await user.type(field, 'ghp_abc{Enter}')
    expect(await within(panel).findByText('Impossible de chiffrer les secrets')).toBeInTheDocument()
    expect(within(panel).getByText('Aucun jeton enregistré')).toBeInTheDocument()
  })

  it('plaintext secrets toggle appears only when encryption is unavailable and asks confirmation', async () => {
    await renderSettings()
    const encrypted = screen.getByRole('region', { name: 'Jeton GitHub' })
    await within(encrypted).findByText('Aucun jeton enregistré')
    expect(screen.queryByRole('switch', { name: 'Mémoriser les secrets en clair' })).toBeNull()

    cleanup()
    const { user, goat } = await renderSettings({
      handlers: { 'app:secretsStatus': () => ({ canEncrypt: false, hasGithubToken: false }) },
    })
    const plaintext = await screen.findByRole('switch', { name: 'Mémoriser les secrets en clair' })
    expect(plaintext).toHaveAttribute('aria-checked', 'false')

    // Cancelled: nothing changes.
    await user.click(plaintext)
    let dialog = await screen.findByRole('dialog', { name: 'Mémoriser les secrets en clair\u00a0?' })
    await user.click(within(dialog).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(goat.inputsOf('app:setConfig')).toEqual([])
    expect(plaintext).toHaveAttribute('aria-checked', 'false')

    // Confirmed: saved.
    await user.click(plaintext)
    dialog = await screen.findByRole('dialog', { name: 'Mémoriser les secrets en clair\u00a0?' })
    await user.click(within(dialog).getByRole('button', { name: 'Mémoriser en clair' }))
    await waitFor(() => expect(plaintext).toHaveAttribute('aria-checked', 'true'))
    expect(goat.inputsOf('app:setConfig')).toEqual([{ allowPlaintextSecrets: true }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Turning it back off needs no confirmation.
    await user.click(plaintext)
    await waitFor(() => expect(plaintext).toHaveAttribute('aria-checked', 'false'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(goat.inputsOf('app:setConfig')).toEqual([
      { allowPlaintextSecrets: true },
      { allowPlaintextSecrets: false },
    ])
  })

  it('clear catalog cache calls app:clearData', async () => {
    const { user, goat } = await renderSettings({ handlers: { 'app:clearData': () => undefined } })
    const panel = screen.getByRole('region', { name: 'Données de l’app' })

    await user.click(within(panel).getByRole('button', { name: 'Vider le cache du catalogue' }))
    const dialog = await screen.findByRole('dialog', { name: 'Vider le cache du catalogue\u00a0?' })
    expect(goat.inputsOf('app:clearData')).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Vider' }))

    expect(await screen.findByText('Cache du catalogue vidé')).toBeInTheDocument()
    expect(goat.inputsOf('app:clearData')).toEqual([{ targets: ['catalog'] }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens the app folders through app:openPath', async () => {
    const { user, goat } = await renderSettings({ handlers: { 'app:openPath': () => undefined } })
    const panel = screen.getByRole('region', { name: 'Données de l’app' })
    await user.click(within(panel).getByRole('button', { name: 'Ouvrir le dossier des logs' }))
    await user.click(within(panel).getByRole('button', { name: 'Ouvrir le dossier des réglages' }))
    await waitFor(() =>
      expect(goat.inputsOf('app:openPath')).toEqual([
        { path: 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\logs' },
        { path: 'C:\\Users\\Joueur\\AppData\\Roaming\\ArchipelaGOAT' },
      ]),
    )
  })

  it('choosing an Archipelago folder goes through app:pickPaths then ap:setCustomPath, and back', async () => {
    const custom: ApInstall = { ...AP_INSTALL, kind: 'custom', root: 'D:\\Jeux\\Archipelago' }
    let current: ApInstall | null = AP_INSTALL
    const { user, goat } = await renderSettings({
      handlers: {
        'ap:detect': () => current,
        'app:pickPaths': () => ['D:\\Jeux\\Archipelago'],
        'ap:setCustomPath': ({ path }) => {
          current = path === null ? AP_INSTALL : custom
          return current
        },
      },
    })
    const panel = screen.getByRole('region', { name: 'Dossier d’Archipelago' })
    expect(await within(panel).findByText('C:\\ProgramData\\Archipelago')).toBeInTheDocument()
    expect(within(panel).getByText('Archipelago 0.6.8')).toBeInTheDocument()
    expect(within(panel).getByText('Détection automatique')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Revenir à la détection automatique' })).toBeNull()

    await user.click(within(panel).getByRole('button', { name: 'Choisir un dossier…' }))

    expect(await within(panel).findByText('D:\\Jeux\\Archipelago')).toBeInTheDocument()
    expect(within(panel).getByText('Dossier choisi')).toBeInTheDocument()
    expect(await screen.findByText('Archipelago trouvé dans ce dossier')).toBeInTheDocument()
    expect(goat.inputsOf('app:pickPaths')).toEqual([
      { mode: 'directory', title: 'Dossier d’installation d’Archipelago' },
    ])
    expect(goat.inputsOf('ap:setCustomPath')).toEqual([{ path: 'D:\\Jeux\\Archipelago' }])

    await user.click(within(panel).getByRole('button', { name: 'Revenir à la détection automatique' }))

    expect(await within(panel).findByText('C:\\ProgramData\\Archipelago')).toBeInTheDocument()
    expect(goat.inputsOf('ap:setCustomPath')).toEqual([{ path: 'D:\\Jeux\\Archipelago' }, { path: null }])
  })

  it('a folder without Archipelago is refused with the reason', async () => {
    const { user, goat } = await renderSettings({
      handlers: {
        'app:pickPaths': () => ['D:\\Vide'],
        'ap:setCustomPath': () => {
          throw new AppError('AP_NOT_INSTALLED')
        },
      },
    })
    const panel = screen.getByRole('region', { name: 'Dossier d’Archipelago' })
    await user.click(await within(panel).findByRole('button', { name: 'Choisir un dossier…' }))
    expect(await within(panel).findByText('Pas d’Archipelago dans ce dossier')).toBeInTheDocument()
    expect(goat.inputsOf('ap:setCustomPath')).toEqual([{ path: 'D:\\Vide' }])
  })

  it('about panel shows unofficial companion notice', async () => {
    await renderSettings()
    const about = screen.getByRole('region', { name: 'À propos' })
    expect(within(about).getByText('Compagnon non officiel pour Archipelago')).toBeInTheDocument()
    expect(within(about).getByText('v0.1.0')).toBeInTheDocument()
    // A development build: electron-updater does nothing.
    expect(within(about).getByText('Version de développement')).toBeInTheDocument()
    expect(within(about).getByText(/CC BY-NC-SA 4\.0/)).toBeInTheDocument()
    expect(within(about).getByRole('link', { name: /Index ionium/ })).toBeInTheDocument()
    expect(within(about).getByText('Licences des dépendances')).toBeInTheDocument()
  })

  it('attribution links open in the browser through app:openExternal', async () => {
    const { user, goat } = await renderSettings({ handlers: { 'app:openExternal': () => undefined } })
    const about = screen.getByRole('region', { name: 'À propos' })
    await user.click(within(about).getByRole('link', { name: /Wiki d’Archipelago/ }))
    await waitFor(() =>
      expect(goat.inputsOf('app:openExternal')).toEqual([{ url: 'https://archipelago.miraheze.org/' }]),
    )
    expect(window.location.hash).toBe('#/settings')
  })
})

describe('about panel', () => {
  it.each([
    ['active', 'Actives : installées en quittant l’app'],
    ['unsupported', 'Pas pour cette version (portable, deb, tar.gz)'],
    ['not-configured', 'Non configurées'],
  ] as const)('says what the updater does for this build (%s)', async (updater, label) => {
    installGoatMock()
    await renderWithProviders(
      <AboutPanel info={{ ...TEST_INFO, isPackaged: true, updater }} licenses={null} />,
    )
    // (The text matcher sees the no-break space of the French text as a space.)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('says the license list only exists in packaged builds', async () => {
    installGoatMock()
    await renderWithProviders(<AboutPanel info={TEST_INFO} licenses={null} />)
    expect(screen.getByText('Pas disponible dans une version de développement')).toBeInTheDocument()
    expect(screen.getByText('Développement')).toBeInTheDocument()
    expect(screen.queryByText('Voir les licences')).toBeNull()
  })

  it('lists the bundled licenses when the build has them', async () => {
    installGoatMock()
    const { user } = await renderWithProviders(
      <AboutPanel
        info={{ ...TEST_INFO, isPackaged: true }}
        licenses={[
          { name: 'odd', version: '1.0.0', license: null },
          { name: 'react', version: '19.3.1', license: 'MIT' },
        ]}
      />,
    )
    expect(screen.queryByText('Pas disponible dans une version de développement')).toBeNull()
    expect(screen.getByText('Publiée')).toBeInTheDocument()
    const summary = screen.getByText('Voir les licences')
    expect(screen.getByText('Paquets : 2')).toBeInTheDocument()

    await user.click(summary)

    expect(summary.closest('details')).toHaveAttribute('open')
    expect(screen.getByText('react')).toBeVisible()
    expect(screen.getByText('MIT')).toBeVisible()
    expect(screen.getByText('Non déclarée')).toBeVisible()
  })
})

describe('parseLicenses', () => {
  it('reads a list of packages, sorted by name', () => {
    expect(
      parseLicenses([
        { name: 'zod', version: '4.6.7', license: 'MIT' },
        { name: 'react', version: '19.3.1', license: 'MIT', repository: 'https://github.com/facebook/react' },
      ]),
    ).toEqual([
      { name: 'react', version: '19.3.1', license: 'MIT' },
      { name: 'zod', version: '4.6.7', license: 'MIT' },
    ])
  })

  it('reads a license-checker map keyed by name@version', () => {
    expect(
      parseLicenses({
        '@tabler/icons-react@3.49.0': { licenses: 'MIT' },
        'yaml@2.9.1': { licenses: ['ISC'] },
        'odd@1.0.0': {},
      }),
    ).toEqual([
      { name: '@tabler/icons-react', version: '3.49.0', license: 'MIT' },
      { name: 'odd', version: '1.0.0', license: null },
      { name: 'yaml', version: '2.9.1', license: 'ISC' },
    ])
  })

  it('returns null for anything else', () => {
    expect(parseLicenses(undefined)).toBeNull()
    expect(parseLicenses('MIT')).toBeNull()
    expect(parseLicenses([{ version: '1.0.0' }])).toEqual([])
  })
})

describe('settings styles', () => {
  // Read from disk (Vitest runs from the project root): Vitest empties imported CSS.
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/features/settings/SettingsScreen.css'),
    'utf8',
  )

  it('spaces the pill and the badges of the found Archipelago, on one line that may wrap', () => {
    const rule = /\.settings-ap__status\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/display:\s*flex/)
    expect(rule).toMatch(/flex-wrap:\s*wrap/)
    expect(rule).toMatch(/gap:\s*var\(--sp-\d\)/)
  })
})
