import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Badge,
  EmptyState,
  ErrorPanel,
  PixelPanel,
  ProgressBar,
  Spinner,
  StatTile,
  StatusPill,
  Stepper,
  Terminal,
  TrustBadge,
} from '@renderer/design/components'

describe('Stepper', () => {
  const steps = [
    { id: 'players', label: 'Joueurs' },
    { id: 'check', label: 'Vérification' },
    { id: 'rules', label: 'Règles' },
    { id: 'generate', label: 'Génération' },
    { id: 'host', label: 'Hébergement' },
  ]

  it('Stepper marks current step with aria-current', () => {
    render(<Stepper label="Étapes" steps={steps} current="rules" />)
    const list = screen.getByRole('list', { name: 'Étapes' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, null, 'step', null, null])
    expect(items.map((item) => item.dataset.state)).toEqual(['done', 'done', 'current', 'todo', 'todo'])
    expect(items[2]).toHaveTextContent('Règles')
  })
})

describe('ProgressBar', () => {
  it('exposes its value and lights the matching share of segments', () => {
    render(<ProgressBar label="Téléchargement" percent={42.4} />)
    const bar = screen.getByRole('progressbar', { name: 'Téléchargement' })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    const segments = bar.querySelectorAll('[data-segment]')
    expect(segments).toHaveLength(20)
    expect(bar.querySelectorAll('[data-segment="lit"]')).toHaveLength(8)
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('honours the segment count and clamps the value', () => {
    render(<ProgressBar label="Vie" percent={180} segments={10} />)
    const bar = screen.getByRole('progressbar', { name: 'Vie' })
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    expect(bar.querySelectorAll('[data-segment="lit"]')).toHaveLength(10)
  })

  it('is indeterminate without a percent', () => {
    render(<ProgressBar label="Génération" percent={null} />)
    const bar = screen.getByRole('progressbar', { name: 'Génération' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveAttribute('data-indeterminate', 'true')
  })
})

describe('Terminal', () => {
  const lines = [
    { text: 'Hosting game at 127.0.0.1:38281' },
    { text: 'Alice found her Hookshot', tone: 'progression' as const },
    { text: 'Connection refused', tone: 'error' as const },
  ]

  it('shows the lines in a labelled log, each with its tone', () => {
    render(<Terminal label="Console du serveur" lines={lines} />)
    const log = screen.getByRole('log', { name: 'Console du serveur' })
    expect(within(log).getByText('Alice found her Hookshot')).toHaveAttribute('data-tone', 'progression')
    expect(within(log).getByText('Hosting game at 127.0.0.1:38281')).toHaveAttribute('data-tone', 'default')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('sends trimmed commands and recalls the history with the arrows', async () => {
    const user = userEvent.setup()
    const onCommand = vi.fn()
    render(
      <Terminal
        label="Console du serveur"
        inputLabel="Commande"
        lines={lines}
        onCommand={onCommand}
        history={['/players', '/hint Alice Hookshot']}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Commande' })
    await user.type(input, '  /release Bob  {Enter}')
    expect(onCommand).toHaveBeenCalledWith('/release Bob')
    expect(input).toHaveValue('')

    await user.keyboard('{Enter}')
    expect(onCommand).toHaveBeenCalledOnce()

    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('/hint Alice Hookshot')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(input).toHaveValue('/players')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('/hint Alice Hookshot')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('')
  })
})

describe('status and labels', () => {
  it('TrustBadge gives each tier its own tone', () => {
    const tiers = ['core', 'indexed-verified', 'wiki-release', 'unknown'] as const
    render(
      <>
        {tiers.map((tier) => (
          <TrustBadge key={tier} tier={tier} label={`tier ${tier}`} />
        ))}
      </>,
    )
    const tones = tiers.map((tier) =>
      screen.getByText(`tier ${tier}`).closest('[data-tone]')?.getAttribute('data-tone'),
    )
    expect(new Set(tones).size).toBe(4)
    expect(screen.getByText('tier core').closest('[data-tier]')).toHaveAttribute('data-tier', 'core')
  })

  it('StatusPill, Badge, StatTile and Spinner render their text', () => {
    render(
      <>
        <StatusPill status="ok" label="Prêt" />
        <Badge tone="cyan">Nouveau</Badge>
        <StatTile label="Archipelago" value="0.6.8" />
        <Spinner label="Chargement" />
      </>,
    )
    expect(screen.getByText('Prêt').closest('[data-status]')).toHaveAttribute('data-status', 'ok')
    expect(screen.getByText('Nouveau')).toBeInTheDocument()
    expect(screen.getByText('0.6.8')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Chargement' })).toBeInTheDocument()
  })

  it('PixelPanel labels its region with its title', () => {
    render(
      <PixelPanel title="Parties récentes" eyebrow="SAVE">
        contenu
      </PixelPanel>,
    )
    expect(screen.getByRole('region', { name: 'Parties récentes' })).toHaveTextContent('contenu')
    expect(screen.getByRole('heading', { name: 'Parties récentes' })).toBeInTheDocument()
  })
})

describe('EmptyState and ErrorPanel', () => {
  it('EmptyState shows its title, body and action', () => {
    render(
      <EmptyState
        title="Aucun monde"
        body="Dépose un .apworld"
        action={<button type="button">Parcourir</button>}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Aucun monde' })).toBeInTheDocument()
    expect(screen.getByText('Dépose un .apworld')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Parcourir' })).toBeInTheDocument()
  })

  it('ErrorPanel is an alert with a collapsible detail', async () => {
    const user = userEvent.setup()
    render(
      <ErrorPanel
        title="La génération a échoué"
        body="Un YAML est invalide."
        detail="Traceback (most recent call last)"
        detailLabel="Détails techniques"
        actions={<button type="button">Réessayer</button>}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('La génération a échoué')
    const detail = screen.getByText('Traceback (most recent call last)')
    expect(detail).not.toBeVisible()
    await user.click(screen.getByText('Détails techniques'))
    expect(detail).toBeVisible()
    expect(within(alert).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})
