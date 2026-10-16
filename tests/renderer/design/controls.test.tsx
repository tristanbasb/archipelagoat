import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import {
  Combobox,
  CopyField,
  NeonButton,
  PlayerCard,
  Segmented,
  Select,
  Slider,
  Tabs,
  Toggle,
  WeightSlider,
} from '@renderer/design/components'

describe('NeonButton', () => {
  it('NeonButton loading disables click and shows spinner label', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <NeonButton loading loadingLabel="Installation…" onClick={onClick}>
        Installer
      </NeonButton>,
    )
    const button = screen.getByRole('button', { name: 'Installation…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button.querySelector('[data-spinner]')).not.toBeNull()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps its own label while loading when no loading label is given', () => {
    render(<NeonButton loading>Installer</NeonButton>)
    expect(screen.getByRole('button', { name: 'Installer' })).toBeDisabled()
  })

  it('is a plain button that clicks, with its variant and size', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <NeonButton variant="danger" size="lg" onClick={onClick}>
        Supprimer
      </NeonButton>,
    )
    const button = screen.getByRole('button', { name: 'Supprimer' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('data-variant', 'danger')
    expect(button).toHaveAttribute('data-size', 'lg')
    expect(button).not.toHaveAttribute('aria-busy')
    await user.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('PlayerCard', () => {
  it('is one button named by its label and title', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <PlayerCard
        player={2}
        label="PLAYER 2"
        title="Rejoindre une partie"
        subtitle="Avec un lien de room"
        cta="PRESS START"
        onClick={onClick}
      />,
    )
    const card = screen.getByRole('button', { name: /PLAYER 2.*Rejoindre une partie/ })
    expect(card).toHaveAttribute('data-player', '2')
    expect(card).toHaveAccessibleDescription('Avec un lien de room')
    await user.click(card)
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('Toggle', () => {
  it('is a labelled switch that reports the next state', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Toggle label="Effet CRT" description="Lignes de balayage" checked={false} onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Effet CRT' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toHaveAccessibleDescription('Lignes de balayage')
    await user.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('is checked when on and does nothing when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Toggle label="Sons" checked disabled onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Sons' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })
})

const MODES = [
  { value: 'simple', label: 'Simple' },
  { value: 'weighted', label: 'Pondéré' },
  { value: 'raw', label: 'YAML brut' },
] as const

describe('Segmented', () => {
  it('is a radio group moved with the arrow keys', async () => {
    const user = userEvent.setup()
    function Harness(): React.JSX.Element {
      const [value, setValue] = useState<(typeof MODES)[number]['value']>('simple')
      return <Segmented label="Mode" options={MODES} value={value} onChange={setValue} />
    }
    render(<Harness />)
    const group = screen.getByRole('radiogroup', { name: 'Mode' })
    const simple = within(group).getByRole('radio', { name: 'Simple' })
    expect(simple).toBeChecked()
    expect(simple).toHaveAttribute('tabindex', '0')
    expect(within(group).getByRole('radio', { name: 'Pondéré' })).toHaveAttribute('tabindex', '-1')

    simple.focus()
    await user.keyboard('{ArrowRight}')
    expect(within(group).getByRole('radio', { name: 'Pondéré' })).toBeChecked()
    expect(within(group).getByRole('radio', { name: 'Pondéré' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(within(group).getByRole('radio', { name: 'YAML brut' })).toBeChecked()
    await user.click(within(group).getByRole('radio', { name: 'Simple' }))
    expect(simple).toBeChecked()
  })
})

describe('Tabs', () => {
  it('links tabs to their panel and switches with the arrow keys', async () => {
    const user = userEvent.setup()
    function Harness(): React.JSX.Element {
      const [tab, setTab] = useState<'installed' | 'catalog'>('installed')
      return (
        <Tabs
          label="Mondes"
          tabs={[
            { id: 'installed', label: 'Installés', badge: 12 },
            { id: 'catalog', label: 'Catalogue' },
          ]}
          value={tab}
          onChange={setTab}
        >
          <p>Contenu {tab}</p>
        </Tabs>
      )
    }
    render(<Harness />)
    const installed = screen.getByRole('tab', { name: /Installés/ })
    expect(installed).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: /Installés/ })).toHaveTextContent('Contenu installed')

    installed.focus()
    await user.keyboard('{ArrowRight}')
    const catalog = screen.getByRole('tab', { name: 'Catalogue' })
    expect(catalog).toHaveAttribute('aria-selected', 'true')
    expect(catalog).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'Catalogue' })).toHaveTextContent('Contenu catalog')
    await user.keyboard('{Home}')
    expect(installed).toHaveAttribute('aria-selected', 'true')
  })
})

describe('Select', () => {
  it('is a labelled native select', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Select
        label="Langue"
        value="fr"
        onChange={onChange}
        options={[
          { value: 'fr', label: 'Français' },
          { value: 'en', label: 'English' },
        ]}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'Langue' })
    expect(select).toHaveValue('fr')
    await user.selectOptions(select, 'en')
    expect(onChange).toHaveBeenCalledWith('en')
  })
})

describe('Slider', () => {
  it('reports numbers from the range, the field and the named marks', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Slider
        label="Prix de la boutique"
        min={0}
        max={100}
        value={30}
        onChange={onChange}
        withInput
        marks={[{ value: 50, label: 'normal' }]}
      />,
    )
    fireEvent.change(screen.getByRole('slider', { name: 'Prix de la boutique' }), { target: { value: '42' } })
    expect(onChange).toHaveBeenLastCalledWith(42)

    const field = screen.getByRole('spinbutton', { name: 'Prix de la boutique' })
    await user.clear(field)
    await user.type(field, '250{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(100)

    await user.click(screen.getByRole('button', { name: 'normal' }))
    expect(onChange).toHaveBeenLastCalledWith(50)
  })
})

describe('WeightSlider', () => {
  function percents(): number[] {
    return screen.getAllByRole('status').map((output) => Number.parseInt(output.textContent ?? '', 10))
  }

  it('WeightSlider shows rounded probabilities summing to ~100', () => {
    render(<WeightSlider label="Difficulté" weights={{ easy: 1, normal: 1, hard: 1 }} onChange={vi.fn()} />)
    expect(percents()).toEqual([33, 33, 33])
    const sum = percents().reduce((a, b) => a + b, 0)
    expect(sum).toBeGreaterThanOrEqual(98)
    expect(sum).toBeLessThanOrEqual(102)
    expect(within(screen.getByRole('group', { name: 'easy' })).getByRole('status')).toHaveTextContent('33%')
  })

  it('rounds each probability to the nearest integer', () => {
    render(
      <WeightSlider
        weights={{ on: 2, off: 1 }}
        optionLabels={{ on: 'Activé', off: 'Désactivé' }}
        onChange={vi.fn()}
      />,
    )
    expect(within(screen.getByRole('group', { name: 'Activé' })).getByRole('status')).toHaveTextContent('67%')
    expect(within(screen.getByRole('group', { name: 'Désactivé' })).getByRole('status')).toHaveTextContent(
      '33%',
    )
  })

  it('shows 0% everywhere when every weight is zero', () => {
    render(<WeightSlider weights={{ a: 0, b: 0 }} onChange={vi.fn()} />)
    expect(percents()).toEqual([0, 0])
  })

  it('reports the whole weight map when one weight changes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<WeightSlider weights={{ easy: 1, normal: 1, hard: 1 }} onChange={onChange} />)
    fireEvent.change(screen.getByRole('slider', { name: 'normal' }), { target: { value: '7' } })
    expect(onChange).toHaveBeenLastCalledWith({ easy: 1, normal: 7, hard: 1 })

    const field = screen.getByRole('spinbutton', { name: 'hard' })
    await user.clear(field)
    await user.type(field, '120{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ easy: 1, normal: 1, hard: 120 })
  })
})

const GAMES = [
  { value: 'A Link to the Past', label: 'A Link to the Past' },
  { value: 'Ocarina of Time', label: 'Ocarina of Time' },
  { value: 'Super Metroid', label: 'Super Metroid', hint: 'SNES' },
  { value: 'Pokémon Red and Blue', label: 'Pokémon Red and Blue' },
]

describe('Combobox', () => {
  it('filters as you type and picks with the keyboard', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Combobox label="Jeu" options={GAMES} value={null} onChange={onChange} emptyLabel="Aucun jeu" />)
    const input = screen.getByRole('combobox', { name: 'Jeu' })
    expect(input).toHaveAttribute('aria-expanded', 'false')

    await user.type(input, 'of')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Ocarina of Time'])

    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('Ocarina of Time')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('ignores accents and case, and says when nothing matches', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Jeu" options={GAMES} value={null} onChange={vi.fn()} emptyLabel="Aucun jeu" />)
    const input = screen.getByRole('combobox', { name: 'Jeu' })
    await user.type(input, 'POKEMON')
    expect(screen.getByRole('option', { name: 'Pokémon Red and Blue' })).toBeInTheDocument()
    await user.type(input, 'zzz')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('Aucun jeu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the selected option and picks with the mouse', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Combobox
        label="Jeu"
        options={GAMES}
        value="Super Metroid"
        onChange={onChange}
        emptyLabel="Aucun jeu"
      />,
    )
    const input = screen.getByRole('combobox', { name: 'Jeu' })
    expect(input).toHaveValue('Super Metroid')
    await user.click(input)
    expect(screen.getByRole('option', { name: /Super Metroid/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('option', { name: 'A Link to the Past' }))
    expect(onChange).toHaveBeenCalledWith('A Link to the Past')
  })
})

describe('CopyField', () => {
  const labels = { copyLabel: 'Copier', copiedLabel: 'Copié', revealLabel: 'Afficher', hideLabel: 'Masquer' }

  it('CopyField masks secret until revealed', async () => {
    const user = userEvent.setup()
    render(<CopyField label="Mot de passe" value="hunter2" secret {...labels} />)
    expect(screen.queryByText('hunter2')).toBeNull()
    expect(document.body.textContent).not.toContain('hunter2')

    await user.click(screen.getByRole('button', { name: 'Afficher' }))
    expect(screen.getByText('hunter2')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Masquer' }))
    expect(screen.queryByText('hunter2')).toBeNull()
  })

  it('copies the real value, even while masked, and confirms', async () => {
    const user = userEvent.setup()
    render(<CopyField label="Mot de passe" value="hunter2" secret {...labels} />)
    await user.click(screen.getByRole('button', { name: 'Copier' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('hunter2')
    expect(await screen.findByRole('button', { name: 'Copié' })).toBeInTheDocument()
  })

  it('shows a plain value without a reveal button', () => {
    render(<CopyField label="Adresse" value="archipelago.gg:38281" copyLabel="Copier" copiedLabel="Copié" />)
    expect(screen.getByText('archipelago.gg:38281')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Afficher' })).toBeNull()
  })
})
