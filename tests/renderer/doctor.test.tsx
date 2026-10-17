import { screen, waitFor, within } from '@testing-library/react'
import { DOCTOR_CHECK_IDS } from '@shared/codes'
import { AppError } from '@shared/errors'
import type { DoctorCheck } from '@shared/types'
import type { GoatHandlers } from './goat-mock'
import { renderApp } from './render-app'

const ALL_OK: DoctorCheck[] = DOCTOR_CHECK_IDS.map((id) => ({ id, severity: 'ok', params: {}, fix: null }))

function withChecks(changes: Partial<Record<DoctorCheck['id'], Partial<DoctorCheck>>>): DoctorCheck[] {
  return ALL_OK.map((check) => ({ ...check, ...changes[check.id] }))
}

const PROBLEMS = withChecks({
  'worlds-no-manifest': {
    severity: 'warning',
    params: { files: 'pokemon_crystal.apworld' },
    fix: { kind: 'navigate', to: '/worlds' },
  },
  'worlds-corrupt': { severity: 'error', params: { files: 'broken.apworld' }, fix: { kind: 'auto' } },
  'programdata-acl': { severity: 'info' },
})

const BUNDLE =
  'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\downloads\\archipelagoat-support-20261017-101500.zip'

async function renderDoctor(handlers: GoatHandlers) {
  return renderApp({ route: '/doctor', handlers })
}

describe('doctor screen', () => {
  it('lists doctor warnings and runs auto fix', async () => {
    const { goat, user } = await renderDoctor({
      'doctor:run': () => PROBLEMS,
      'doctor:fix': ({ checkId }) =>
        PROBLEMS.map((check) => (check.id === checkId ? { ...check, severity: 'ok', fix: null } : check)),
    })
    const problems = await screen.findByRole('region', { name: 'À regarder' })
    const items = within(problems).getAllByRole('listitem')
    // Errors first, then warnings, then infos.
    expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual([
      'Mondes corrompus',
      'Mondes sans manifeste',
      'Droits du dossier d’Archipelago',
    ])
    const [corrupt, noManifest] = items as [HTMLElement, HTMLElement]
    expect(within(corrupt).getByText('Erreur')).toBeInTheDocument()
    expect(
      within(corrupt).getByText('Un monde corrompu empêche Archipelago de démarrer : mets-le de côté.'),
    ).toBeInTheDocument()
    expect(within(corrupt).getByText('broken.apworld', { exact: false })).toBeInTheDocument()
    expect(within(noManifest).getByText('Attention')).toBeInTheDocument()

    const passing = screen.getByRole('region', { name: 'Tout va bien' })
    expect(within(passing).getAllByRole('listitem')).toHaveLength(DOCTOR_CHECK_IDS.length - 3)
    expect(within(passing).getByText('Archipelago est installé.')).toBeInTheDocument()

    await user.click(within(corrupt).getByRole('button', { name: 'Corriger' }))
    await waitFor(() => expect(goat.inputsOf('doctor:fix')).toEqual([{ checkId: 'worlds-corrupt' }]))
    expect(await within(passing).findByText('Aucun monde corrompu.')).toBeInTheDocument()
    expect(within(problems).getAllByRole('listitem')).toHaveLength(2)
    expect(await screen.findByText('Corrigé : Mondes corrompus')).toBeInTheDocument()
    // One run on arrival; the fix answers with the new list.
    expect(goat.inputsOf('doctor:run')).toHaveLength(1)
  })

  it('a navigate fix opens the screen that fixes the check', async () => {
    const { user } = await renderDoctor({ 'doctor:run': () => PROBLEMS })
    const problems = await screen.findByRole('region', { name: 'À regarder' })
    await user.click(within(problems).getByRole('button', { name: 'Ouvrir les mondes' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Mondes' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/worlds')
  })

  it('shows the health summary and reruns the checks', async () => {
    let runs = 0
    const { goat, user } = await renderDoctor({
      'doctor:run': () => (++runs === 1 ? PROBLEMS : ALL_OK),
    })
    const summary = await screen.findByRole('region', { name: 'Santé du système' })
    expect(within(summary).getByRole('progressbar', { name: 'Vérifications réussies' })).toHaveAttribute(
      'aria-valuenow',
      String(Math.round(((DOCTOR_CHECK_IDS.length - 2) / DOCTOR_CHECK_IDS.length) * 100)),
    )
    expect(within(summary).getByText('Erreurs : 1')).toBeInTheDocument()
    expect(within(summary).getByText('Alertes : 1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Relancer le diagnostic' }))
    expect(await within(summary).findByText('Tout est prêt. Bonne partie !')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'À regarder' })).toBeNull()
    expect(goat.inputsOf('doctor:run')).toHaveLength(2)
  })

  it('creates a support bundle then opens its folder', async () => {
    const { goat, user } = await renderDoctor({
      'doctor:run': () => ALL_OK,
      'doctor:supportBundle': () => ({ path: BUNDLE }),
      'app:openPath': () => undefined,
    })
    const panel = await screen.findByRole('region', { name: 'Bundle de support' })
    expect(within(panel).getByText(/jamais envoyé/)).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: 'Créer un bundle de support' }))
    await waitFor(() =>
      expect(goat.inputsOf('app:openPath')).toEqual([
        { path: 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\downloads' },
      ]),
    )
    expect(goat.inputsOf('doctor:supportBundle')).toHaveLength(1)
    expect(within(panel).getByText(BUNDLE)).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: 'Ouvrir le dossier' }))
    await waitFor(() => expect(goat.inputsOf('app:openPath')).toHaveLength(2))
  })

  it('shows a translated error when the bundle fails', async () => {
    const { user } = await renderDoctor({
      'doctor:run': () => ALL_OK,
      'doctor:supportBundle': () => {
        throw new AppError('PATH_FORBIDDEN', undefined, { detail: 'EPERM' })
      },
    })
    const panel = await screen.findByRole('region', { name: 'Bundle de support' })
    await user.click(within(panel).getByRole('button', { name: 'Créer un bundle de support' }))
    const alert = await within(panel).findByRole('alert')
    expect(alert).toHaveTextContent('EPERM')
  })

  it('shows a translated error and retries when the doctor fails', async () => {
    let runs = 0
    const { user } = await renderDoctor({
      'doctor:run': () => {
        if (++runs === 1) throw new AppError('AP_UNKNOWN', undefined, { detail: 'boom' })
        return ALL_OK
      },
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Erreur inattendue')
    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByText('Tout est prêt. Bonne partie !')).toBeInTheDocument()
  })

  it('leaves out the checks of another system and never calls a check that could not run passed', async () => {
    const checks = withChecks({
      glibc: { params: { skipped: 'not-linux' } },
      'programdata-acl': { params: { skipped: 'no-installer-folder' } },
      'ap-update': { params: { skipped: 'release-unavailable', error: 'NETWORK_OFFLINE: x' } },
      network: { severity: 'warning', params: { reason: 'offline' } },
    })
    await renderDoctor({ 'doctor:run': () => checks })
    const passing = await screen.findByRole('region', { name: 'Tout va bien' })
    // Linux's C library on Windows, the permissions of an installer folder that is not there: not shown.
    expect(screen.queryByText('Bibliothèque C (glibc)')).toBeNull()
    expect(screen.queryByText('Droits du dossier d’Archipelago')).toBeNull()
    // Offline, the latest release is unknown: the check says so, not that Archipelago is up to date.
    const update = within(passing).getByText('Mise à jour d’Archipelago').closest('li')
    expect(update).toHaveTextContent('Pas vérifié : la dernière version ne peut pas être lue pour le moment.')
    expect(screen.queryByText('Archipelago est à jour.')).toBeNull()

    // Every check but two concerns this machine; two of those did not pass (the warning, the update
    // left unchecked).
    const concerned = DOCTOR_CHECK_IDS.length - 2
    const passed = concerned - 2
    const summary = screen.getByRole('region', { name: 'Santé du système' })
    expect(within(summary).getByText(`${passed}/${concerned}`)).toBeInTheDocument()
    expect(within(summary).getByRole('progressbar', { name: 'Vérifications réussies' })).toHaveAttribute(
      'aria-valuenow',
      String(Math.round((passed / concerned) * 100)),
    )
  })

  it('says a check waits for Archipelago while it is not installed', async () => {
    const checks = withChecks({
      'ap-installed': { severity: 'error', fix: { kind: 'navigate', to: '/install' } },
      'settings-file': { params: { skipped: 'ap-not-installed' } },
    })
    await renderDoctor({ 'doctor:run': () => checks })
    const passing = await screen.findByRole('region', { name: 'Tout va bien' })
    const settings = within(passing).getByText('Fichier de réglages').closest('li')
    expect(settings).toHaveTextContent('Vérifié une fois Archipelago installé.')
    expect(screen.queryByText('Le fichier de réglages d’Archipelago est lisible.')).toBeNull()
  })

  it('announces the checks while they run', async () => {
    let finish: (checks: DoctorCheck[]) => void = () => undefined
    await renderDoctor({
      'doctor:run': () => new Promise<DoctorCheck[]>((resolve) => (finish = resolve)),
    })
    expect(await screen.findByRole('status', { name: 'Diagnostic en cours…' })).toBeInTheDocument()
    finish(ALL_OK)
    expect(await screen.findByText('Tout est prêt. Bonne partie !')).toBeInTheDocument()
  })
})
