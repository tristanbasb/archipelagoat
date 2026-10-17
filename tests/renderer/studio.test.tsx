import { screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { AppError } from '@shared/errors'
import { defaultRules } from '@shared/rules'
import type {
  EditorDoc,
  GameSchema,
  Issue,
  OptionSchema,
  PlayerDoc,
  Session,
  SessionSummary,
  StudioGame,
} from '@shared/types'
import type { GoatHandlers } from './goat-mock'
import { renderApp } from './render-app'

const NOW = '2026-10-17T18:00:00.000Z'
const GAME = 'Test Game'
const FILE = 'C:\\Users\\Joueur\\Documents\\Mes YAML\\Goat.yaml'
const NO_FX = { effects: { crt: false, glow: false, animations: false, sounds: false } }

const option = (key: string, kind: OptionSchema['kind'], value: unknown, extra: Partial<OptionSchema> = {}) =>
  ({
    key,
    group: 'Game Options',
    doc: '',
    kind,
    default: value,
    choices: [],
    range: null,
    specialNames: {},
    confidence: 'inferred',
    ...extra,
  }) satisfies OptionSchema

const SCHEMA: GameSchema = {
  game: GAME,
  source: 'local',
  apVersion: '0.6.8',
  groups: [
    {
      name: 'Game Options',
      options: [
        option('goal', 'choice', 'ganon', {
          choices: ['ganon', 'crystals', 'bosses'],
          doc: 'What you must do to win.\nGanon: beat Ganon.',
        }),
        option('death_link', 'toggle', false, { choices: ['false', 'true'], confidence: 'exact' }),
        option('progression_balancing', 'named-range', 50, {
          range: { min: 0, max: 99 },
          specialNames: { disabled: 0, normal: 50, extreme: 99 },
          confidence: 'exact',
        }),
        option('amount', 'range', 5, { range: { min: 1, max: 10 }, confidence: 'exact' }),
        option('character', 'text-choice', 'link', { choices: ['link', 'zelda'] }),
        option('trainer_name', 'text-choice', 'Ash'),
      ],
    },
    {
      name: 'Item & Location Options',
      options: [option('start_inventory', 'dict', {}, { group: 'Item & Location Options' })],
    },
  ],
  presets: { Hard: { death_link: true, amount: 10 } },
}

const GAMES: StudioGame[] = [
  { game: 'Custom World', installed: true, schemaSource: 'none' },
  { game: GAME, installed: true, schemaSource: 'local' },
]

const SUMMARY: SessionSummary = {
  id: 's1',
  name: 'Soirée GOAT',
  status: 'draft',
  playerCount: 2,
  updatedAt: NOW,
  hostingMode: null,
}

const SESSION: Session = {
  id: 's1',
  name: 'Soirée GOAT',
  createdAt: NOW,
  updatedAt: NOW,
  status: 'draft',
  players: [],
  rules: defaultRules(),
  hasPassword: false,
  hasServerPassword: false,
  generation: null,
  hosting: null,
  workspace: 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT\\sessions\\s1',
}

/** A stand-in for the main process writer: one line per option, enough to read back in the preview. */
function fakeRender({ doc }: { doc: EditorDoc }): { text: string; issues: Issue[] } {
  const lines = [`name: ${doc.name}`, `game: ${doc.game}`, `${doc.game}:`]
  for (const [key, value] of Object.entries(doc.options)) {
    if (value.mode === 'weighted') {
      lines.push(`  ${key}:`)
      for (const [name, weight] of Object.entries(value.weights)) lines.push(`    ${name}: ${weight}`)
    } else if (value.mode === 'raw') lines.push(`  ${key}: ${value.yaml}`)
    else lines.push(`  ${key}: ${JSON.stringify(value.value)}`)
  }
  return { text: `${lines.join('\n')}\n`, issues: [] }
}

const playerDoc = (issues: Issue[] = []): PlayerDoc[] => [
  { index: 0, name: 'Goat', games: [{ game: GAME, weight: 1 }], issues },
]

function handlers(overrides: GoatHandlers = {}): GoatHandlers {
  return {
    'studio:games': () => GAMES,
    'studio:schema': ({ game }) => {
      if (game !== GAME) throw new AppError('NOT_FOUND', { game })
      return SCHEMA
    },
    'studio:render': fakeRender,
    'studio:validate': () => playerDoc(),
    'session:list': () => [SUMMARY],
    ...overrides,
  }
}

const lastRenderedDoc = (inputs: { doc: EditorDoc }[]): EditorDoc | undefined => inputs.at(-1)?.doc

/** Picks a game in the empty Studio and waits for its options. */
async function startNew(user: UserEvent, game = GAME): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: 'Jeu' }))
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${game}`) }))
}

const optionCard = (name: string): HTMLElement => screen.getByRole('region', { name })
const preview = (): HTMLElement => screen.getByRole('region', { name: 'Aperçu YAML' })

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
})

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

describe('YAML studio', () => {
  it('renders a slider for range and a toggle for toggle option', async () => {
    const { user, goat } = await renderApp({ route: '/studio', handlers: handlers(), config: NO_FX })
    await startNew(user)

    const amount = within(await screen.findByRole('region', { name: 'Amount' }))
    expect(amount.getByRole('slider', { name: 'Amount' })).toHaveValue('5')
    expect(amount.getByRole('spinbutton', { name: 'Amount' })).toHaveValue(5)
    const deathLink = within(optionCard('Death link')).getByRole('switch', { name: 'Death link' })
    expect(deathLink).toHaveAttribute('aria-checked', 'false')
    // Few choices: a segmented control; special names of a named range: chips.
    expect(within(optionCard('Goal')).getByRole('radio', { name: 'Crystals' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(
      within(optionCard('Progression balancing')).getByRole('button', { name: 'normal' }),
    ).toHaveAttribute('aria-pressed', 'true')
    // Complex options get a YAML editor; their group starts folded, as in Archipelago.
    expect(screen.getByRole('button', { name: /Objets et lieux/ })).toHaveAttribute('aria-expanded', 'false')

    await user.click(deathLink)
    await user.click(within(optionCard('Goal')).getByRole('radio', { name: 'Crystals' }))
    await waitFor(() =>
      expect(lastRenderedDoc(goat.inputsOf('studio:render'))?.options).toMatchObject({
        death_link: { mode: 'value', value: true },
        goal: { mode: 'value', value: 'crystals' },
      }),
    )
    expect(goat.inputsOf('studio:schema')).toContainEqual({ game: GAME })
    await waitFor(() => expect(preview()).toHaveTextContent('goal: "crystals"'))
  })

  it('switching to weighted mode shows WeightSlider and updates preview', async () => {
    const { user, goat } = await renderApp({ route: '/studio', handlers: handlers(), config: NO_FX })
    await startNew(user)

    const goal = within(await screen.findByRole('region', { name: 'Goal' }))
    await user.click(goal.getByRole('radio', { name: 'Pondéré' }))
    const weights = goal.getByRole('group', { name: 'Poids de Goal' })
    expect(within(weights).getByRole('slider', { name: 'ganon' })).toHaveValue('50')
    await waitFor(() => expect(preview()).toHaveTextContent('goal: ganon: 50'))

    // Other choices are one click away, each with its share of the odds.
    await user.click(goal.getByRole('button', { name: 'Ajouter crystals' }))
    expect(within(weights).getByRole('slider', { name: 'crystals' })).toHaveValue('50')
    expect(within(weights).getAllByText('50%')).toHaveLength(2)
    await waitFor(() =>
      expect(lastRenderedDoc(goat.inputsOf('studio:render'))?.options.goal).toEqual({
        mode: 'weighted',
        weights: { ganon: 50, crystals: 50 },
      }),
    )
    expect(preview()).toHaveTextContent('goal: ganon: 50 crystals: 50')

    // Back to one value: the heaviest (the first of a tie).
    await user.click(goal.getByRole('radio', { name: 'Simple' }))
    expect(goal.queryByRole('group', { name: 'Poids de Goal' })).not.toBeInTheDocument()
    expect(goal.getByRole('radio', { name: 'Ganon' })).toHaveAttribute('aria-checked', 'true')
  })

  it('drops a weighted option once every value is removed, rather than writing {}', async () => {
    const { user, goat } = await renderApp({ route: '/studio', handlers: handlers(), config: NO_FX })
    await startNew(user)

    const goal = within(await screen.findByRole('region', { name: 'Goal' }))
    await user.click(goal.getByRole('radio', { name: 'Pondéré' }))
    await user.click(goal.getByRole('button', { name: 'Retirer ganon' }))
    await waitFor(() => {
      const doc = lastRenderedDoc(goat.inputsOf('studio:render'))
      expect(doc?.options).not.toHaveProperty('goal')
      expect(doc?.options).toHaveProperty('death_link')
    })
    // The option reads as its default again.
    expect(goal.getByRole('radio', { name: 'Ganon' })).toHaveAttribute('aria-checked', 'true')
    expect(goal.getByText('Par défaut')).toBeInTheDocument()
  })

  it('validation issue links scroll to the option', async () => {
    const issues: Issue[] = [
      { severity: 'error', code: 'option-float', path: `${GAME}.amount`, params: { value: 2.5 } },
      { severity: 'warning', code: 'option-unknown', path: `${GAME}.start_inventory` },
      { severity: 'error', code: 'requires-version-format', path: 'requires.version' },
    ]
    const { user } = await renderApp({
      route: '/studio',
      handlers: handlers({ 'studio:validate': () => playerDoc(issues) }),
      config: NO_FX,
    })
    await startNew(user)

    const check = await screen.findByRole('region', { name: 'Vérification' })
    await within(check).findByText('2 erreurs · 1 alerte')
    // The issue shows next to its option too.
    expect(
      within(optionCard('Amount')).getByText('Cette option attend un nombre entier.'),
    ).toBeInTheDocument()

    await user.click(within(check).getByRole('button', { name: /Amount.*nombre entier/ }))
    const amount = optionCard('Amount')
    expect(scrollIntoView).toHaveBeenCalled()
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(amount)
    expect(amount).toHaveFocus()

    // An option in a folded group: the group opens first.
    const items = screen.getByRole('button', { name: /Objets et lieux/ })
    expect(items).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(check).getByRole('button', { name: /Start inventory/ }))
    expect(items).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(optionCard('Start inventory')).toHaveFocus())

    // An issue about no option is listed without a link.
    expect(within(check).getByText(/pas au format x\.y\.z/)).toBeInTheDocument()
    expect(within(check).queryByRole('button', { name: /pas au format/ })).not.toBeInTheDocument()
  })

  it('add to session calls session:addText with rendered text', async () => {
    const { user, goat } = await renderApp({
      route: '/studio',
      handlers: handlers({ 'session:addText': () => SESSION }),
      config: NO_FX,
    })
    await startNew(user)
    const name = screen.getByRole('textbox', { name: 'Nom du joueur' })
    await user.clear(name)
    console.log('type start', performance.now() | 0)
    await user.type(name, 'Goat')
    console.log('type end', performance.now() | 0)

    await user.click(screen.getByRole('button', { name: 'Ajouter à une partie' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter à une partie' })
    await user.click(await within(dialog).findByRole('button', { name: /Soirée GOAT/ }))

    await waitFor(() => expect(goat.inputsOf('session:addText')).toHaveLength(1))
    const [input] = goat.inputsOf('session:addText')
    const doc = lastRenderedDoc(goat.inputsOf('studio:render'))
    expect(doc?.name).toBe('Goat')
    expect(input).toEqual({ id: 's1', fileName: 'Goat.yaml', text: fakeRender({ doc: doc! }).text })
    expect(await screen.findByText('Ajouté à « Soirée GOAT »')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Ajouter à une partie' })).not.toBeInTheDocument(),
    )
  })

  it('opens /studio?open=<path>, keeps unknown options and saves back to that file', async () => {
    const opened: EditorDoc = {
      name: 'Goat',
      description: 'Mon YAML',
      game: GAME,
      requiresVersion: '0.6.8',
      options: {
        goal: { mode: 'value', value: 'bosses' },
        secret_option: { mode: 'value', value: 'kept' },
      },
      extraRoot: { triggers: { mode: 'raw', yaml: '- option_name: goal' } },
    }
    const { user, goat } = await renderApp({
      route: `/studio?open=${encodeURIComponent(FILE)}`,
      handlers: handlers({
        'studio:open': ({ path }) => ({ path: path ?? FILE, text: 'name: Goat\n' }),
        'studio:parse': () => ({ docs: [opened], issues: [] }),
        'studio:save': ({ path }) => ({ path: path ?? FILE }),
      }),
      config: NO_FX,
    })

    expect(await screen.findByRole('textbox', { name: 'Nom du joueur' })).toHaveValue('Goat')
    expect(goat.inputsOf('studio:open')).toEqual([{ path: FILE }])
    expect(goat.inputsOf('studio:parse')).toEqual([{ text: 'name: Goat\n' }])
    expect(await screen.findByRole('radio', { name: 'Bosses' })).toHaveAttribute('aria-checked', 'true')
    // An option the template does not know is kept, as YAML.
    expect(within(optionCard('Secret option')).getByRole('textbox', { name: 'Secret option' })).toHaveValue(
      'kept',
    )
    expect(screen.getByText('Goat.yaml')).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Death link' }))
    // The URL still names the file; editing it asks nothing, the file is not opened again.
    expect(window.location.hash).toBe(`#/studio?open=${encodeURIComponent(FILE)}`)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(goat.inputsOf('studio:save')).toHaveLength(1))
    const doc = {
      ...opened,
      options: { ...opened.options, death_link: { mode: 'value' as const, value: true } },
    }
    expect(goat.inputsOf('studio:save')[0]).toEqual({
      text: fakeRender({ doc }).text,
      path: FILE,
      suggestedName: 'Goat.yaml',
    })
    expect(lastRenderedDoc(goat.inputsOf('studio:render'))?.extraRoot).toEqual(opened.extraRoot)
    expect(await screen.findByText('Enregistré dans Goat.yaml')).toBeInTheDocument()
    expect(goat.inputsOf('studio:open')).toHaveLength(1)

    // Something new: the URL no longer names the file.
    await user.click(screen.getByRole('button', { name: 'Nouveau' }))
    await waitFor(() => expect(window.location.hash).toBe('#/studio'))
    expect(await screen.findByText('Choisis un jeu pour commencer')).toBeInTheDocument()
  })

  it('edits a session file and goes back to the wizard after saving', async () => {
    const alice: EditorDoc = {
      name: 'Alice',
      description: '',
      game: GAME,
      requiresVersion: '0.6.8',
      options: { amount: { mode: 'value', value: 3 } },
      extraRoot: {},
    }
    const bob: EditorDoc = { ...alice, name: 'Bob', options: {} }
    const { user, goat } = await renderApp({
      route: '/studio?session=s1&file=f1',
      handlers: handlers({
        'session:readFile': () => ({ text: 'two players' }),
        'studio:parse': () => ({ docs: [alice, bob], issues: [] }),
        'session:replaceFile': () => SESSION,
        'session:get': () => SESSION,
        'session:validate': () => ({
          files: [],
          sessionIssues: [],
          missingWorlds: [],
          romNeeds: [],
          blocking: false,
        }),
      }),
      config: NO_FX,
    })

    expect(await screen.findByRole('textbox', { name: 'Nom du joueur' })).toHaveValue('Alice')
    expect(goat.inputsOf('session:readFile')).toEqual([{ id: 's1', fileId: 'f1' }])
    // A file with two players: each one can be edited.
    expect(screen.getByRole('radio', { name: 'Bob' })).toHaveAttribute('aria-checked', 'false')

    await user.click(screen.getByRole('switch', { name: 'Death link' }))
    await user.click(screen.getByRole('button', { name: 'Enregistrer et revenir' }))
    await waitFor(() => expect(goat.inputsOf('session:replaceFile')).toHaveLength(1))
    const edited = {
      ...alice,
      options: { ...alice.options, death_link: { mode: 'value' as const, value: true } },
    }
    expect(goat.inputsOf('session:replaceFile')[0]).toEqual({
      id: 's1',
      fileId: 'f1',
      text: `${fakeRender({ doc: edited }).text}\n---\n${fakeRender({ doc: bob }).text}`,
    })
    await waitFor(() => expect(window.location.hash).toBe('#/session/s1?step=2'))
  })

  it('offers to generate the templates of an installed game without a schema', async () => {
    let games = GAMES
    const { user, goat } = await renderApp({
      route: '/studio',
      handlers: handlers({
        'studio:games': () => games,
        'studio:schema': ({ game }) => ({ ...SCHEMA, game }),
        'ap:regenerateTemplates': () => ({ taskId: 't-templates' }),
      }),
      config: NO_FX,
    })
    await startNew(user, 'Custom World')

    await screen.findByText('Pas encore de template pour Custom World')
    expect(goat.inputsOf('studio:schema')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Générer les templates' }))
    await waitFor(() => expect(goat.inputsOf('ap:regenerateTemplates')).toHaveLength(1))
    goat.emit('task:progress', { taskId: 't-templates', kind: 'templates', stage: 'generate', percent: null })
    // The stage shows in the offer (the status bar lists the task too).
    expect(await within(screen.getByRole('main')).findByText('Écriture des templates')).toBeInTheDocument()

    const gamesCalls = goat.inputsOf('studio:games').length
    games = GAMES.map((game) => (game.game === 'Custom World' ? { ...game, schemaSource: 'local' } : game))
    goat.emit('task:done', { taskId: 't-templates', kind: 'templates', result: { count: 2 } })
    await waitFor(() => expect(goat.inputsOf('studio:games').length).toBeGreaterThan(gamesCalls))
    expect(await screen.findByRole('region', { name: 'Amount' })).toBeInTheDocument()
    expect(goat.inputsOf('studio:schema')).toContainEqual({ game: 'Custom World' })
    await waitFor(() =>
      expect(lastRenderedDoc(goat.inputsOf('studio:render'))?.options).toHaveProperty('amount'),
    )
  })

  it('applies a preset over the defaults, and can undo it', async () => {
    const { user, goat } = await renderApp({ route: '/studio', handlers: handlers(), config: NO_FX })
    await startNew(user)
    await user.click(
      within(await screen.findByRole('region', { name: 'Goal' })).getByRole('radio', { name: 'Bosses' }),
    )

    await user.click(screen.getByRole('button', { name: 'Hard' }))
    expect(screen.getByRole('switch', { name: 'Death link' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('slider', { name: 'Amount' })).toHaveValue('10')
    expect(screen.getByRole('radio', { name: 'Ganon' })).toHaveAttribute('aria-checked', 'true')
    await waitFor(() =>
      expect(lastRenderedDoc(goat.inputsOf('studio:render'))?.options.amount).toEqual({
        mode: 'value',
        value: 10,
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Annuler' }))
    expect(screen.getByRole('switch', { name: 'Death link' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: 'Bosses' })).toHaveAttribute('aria-checked', 'true')
  })

  it('waits for a pause before rendering and validating again', async () => {
    const { user, goat } = await renderApp({ route: '/studio', handlers: handlers(), config: NO_FX })
    await startNew(user)
    await waitFor(() => expect(goat.inputsOf('studio:validate')).toHaveLength(1))
    const renders = goat.inputsOf('studio:render').length

    const toggle = screen.getByRole('switch', { name: 'Death link' })
    await user.click(toggle)
    await user.click(toggle)
    await user.click(toggle)
    await waitFor(() => expect(goat.inputsOf('studio:validate')).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(goat.inputsOf('studio:render')).toHaveLength(renders + 1)
    expect(goat.inputsOf('studio:validate')).toHaveLength(2)
    expect(lastRenderedDoc(goat.inputsOf('studio:render'))?.options.death_link).toEqual({
      mode: 'value',
      value: true,
    })
  })

  it('validates once the player stops typing their name, not on every key', async () => {
    const { user, goat } = await renderApp({ route: '/studio', handlers: handlers(), config: NO_FX })
    await startNew(user)
    await waitFor(() => expect(goat.inputsOf('studio:validate')).toHaveLength(1))

    const name = screen.getByRole('textbox', { name: 'Nom du joueur' })
    // Right after picking the game: the debounce holds from the first key.
    await user.clear(name)
    await user.type(name, 'Goat')
    await waitFor(() => expect(goat.inputsOf('studio:validate')).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(goat.inputsOf('studio:validate')).toHaveLength(2)
    expect(goat.inputsOf('studio:validate')[1]).toEqual({
      text: expect.stringContaining('name: Goat\n') as string,
      fileName: 'Goat.yaml',
    })
  })

  it('offers the choices of a text choice, and a text of ones own', async () => {
    const { user, goat } = await renderApp({ route: '/studio', handlers: handlers(), config: NO_FX })
    await startNew(user)

    const character = within(await screen.findByRole('region', { name: 'Character' }))
    expect(character.getByRole('radio', { name: 'Link' })).toHaveAttribute('aria-checked', 'true')
    const own = character.getByRole('textbox', { name: 'Autre texte pour Character' })
    expect(own).toHaveValue('')
    await user.type(own, 'Ganondorf')
    expect(own).toHaveValue('Ganondorf')
    expect(character.getByRole('radio', { name: 'Link' })).toHaveAttribute('aria-checked', 'false')
    await waitFor(() =>
      expect(lastRenderedDoc(goat.inputsOf('studio:render'))?.options.character).toEqual({
        mode: 'value',
        value: 'Ganondorf',
      }),
    )
    // Picking a choice again empties the text of one's own.
    await user.click(character.getByRole('radio', { name: 'Zelda' }))
    expect(own).toHaveValue('')

    // Without choices, a text field alone (suggesting the default).
    const trainer = within(optionCard('Trainer name'))
    expect(trainer.queryByRole('radiogroup', { name: 'Trainer name' })).not.toBeInTheDocument()
    expect(trainer.getByRole('combobox', { name: 'Trainer name' })).toHaveValue('Ash')
  })

  it('explains why a value is refused when the check says', async () => {
    const issues: Issue[] = [
      {
        severity: 'warning',
        code: 'option-invalid-value',
        path: `${GAME}.amount`,
        params: { value: 'random-range--5-5', reason: 'negative-random-range' },
      },
    ]
    const { user } = await renderApp({
      route: '/studio',
      handlers: handlers({ 'studio:validate': () => playerDoc(issues) }),
      config: NO_FX,
    })
    await startNew(user)
    const amount = within(await screen.findByRole('region', { name: 'Amount' }))
    expect(await amount.findByText(/Archipelago lit mal un random-range négatif/)).toBeInTheDocument()
  })

  it('asks before going back to the game with unsaved changes, then starts afresh', async () => {
    const alice: EditorDoc = {
      name: 'Alice',
      description: '',
      game: GAME,
      requiresVersion: '0.6.8',
      options: {},
      extraRoot: {},
    }
    const { user, goat } = await renderApp({
      route: '/studio?session=s1&file=f1',
      handlers: handlers({
        'session:readFile': () => ({ text: 'alice' }),
        'studio:parse': () => ({ docs: [alice], issues: [] }),
        'session:get': () => SESSION,
        'session:validate': () => ({
          files: [],
          sessionIssues: [],
          missingWorlds: [],
          romNeeds: [],
          blocking: false,
        }),
      }),
      config: NO_FX,
    })
    expect(await screen.findByRole('textbox', { name: 'Nom du joueur' })).toHaveValue('Alice')

    await user.click(screen.getByRole('switch', { name: 'Death link' }))
    await user.click(screen.getByRole('button', { name: 'Retour à la partie' }))
    const dialog = await screen.findByRole('dialog', { name: 'Abandonner tes modifications ?' })
    expect(window.location.hash).toBe('#/studio?session=s1&file=f1')
    await user.click(within(dialog).getByRole('button', { name: 'Abandonner' }))
    await waitFor(() => expect(window.location.hash).toBe('#/session/s1?step=2'))
    expect(goat.inputsOf('session:replaceFile')).toEqual([])

    // Back in the Studio: the player that was dropped is gone.
    window.location.hash = '#/studio'
    expect(await screen.findByText('Choisis un jeu pour commencer')).toBeInTheDocument()
  })

  it('turns a file that picks among games into a YAML of the game picked, keeping its section', async () => {
    const multi: EditorDoc = {
      name: 'Goat',
      description: '',
      game: '',
      requiresVersion: '0.6.8',
      options: {},
      extraRoot: {
        game: { mode: 'value', value: { [GAME]: 1, Other: 1 } },
        [GAME]: { mode: 'raw', yaml: 'goal: bosses\ndeath_link:\n  true: 1\n  false: 1' },
        Other: { mode: 'value', value: { foo: 1 } },
      },
    }
    const seeded: EditorDoc = {
      name: 'Goat',
      description: '',
      game: GAME,
      requiresVersion: '0.6.8',
      options: {
        goal: { mode: 'value', value: 'bosses' },
        death_link: { mode: 'weighted', weights: { true: 1, false: 1 } },
      },
      extraRoot: { Other: { mode: 'value', value: { foo: 1 } } },
    }
    const { user, goat } = await renderApp({
      route: `/studio?open=${encodeURIComponent(FILE)}`,
      handlers: handlers({
        'studio:open': () => ({ path: FILE, text: 'multi' }),
        'studio:parse': ({ text }) => ({ docs: [text === 'multi' ? multi : seeded], issues: [] }),
      }),
      config: NO_FX,
    })
    expect(await screen.findByText(/tire son jeu au hasard parmi plusieurs/)).toBeInTheDocument()

    await startNew(user)
    // The file is read again with that game: its own section comes back as options.
    expect(await screen.findByRole('radio', { name: 'Bosses' })).toHaveAttribute('aria-checked', 'true')
    expect(
      within(optionCard('Death link')).getByRole('group', { name: 'Poids de Death link' }),
    ).toBeInTheDocument()
    expect(goat.inputsOf('studio:render')).toContainEqual({
      doc: { ...multi, extraRoot: { ...multi.extraRoot, game: { mode: 'value', value: GAME } } },
    })
    await waitFor(() => {
      const doc = lastRenderedDoc(goat.inputsOf('studio:render'))
      expect(doc?.game).toBe(GAME)
      expect(doc?.options).toEqual(seeded.options)
      expect(doc?.extraRoot).toEqual(seeded.extraRoot)
    })
    // One click takes it back.
    expect(await screen.findByText(`Jeu changé pour ${GAME}`)).toBeInTheDocument()
  })

  it('makes a random pick of an option in one click', async () => {
    const { user, goat } = await renderApp({ route: '/studio', handlers: handlers(), config: NO_FX })
    await startNew(user)
    const amount = within(await screen.findByRole('region', { name: 'Amount' }))
    await user.click(amount.getByRole('button', { name: 'Aléatoire pour Amount' }))
    expect(amount.getByRole('radio', { name: 'Aléatoire' })).toHaveAttribute('aria-checked', 'true')
    await user.click(amount.getByRole('radio', { name: 'Plutôt bas' }))
    await waitFor(() =>
      expect(lastRenderedDoc(goat.inputsOf('studio:render'))?.options.amount).toEqual({
        mode: 'value',
        value: 'random-low',
      }),
    )
    await user.click(amount.getByRole('button', { name: 'Valeur par défaut pour Amount' }))
    expect(amount.getByRole('slider', { name: 'Amount' })).toHaveValue('5')
  })

  it('shows a choice named like a random pick as that choice, not as random', async () => {
    // Factorio's silo: `randomize_recipe` is a choice; only `random` is Archipelago's pick.
    const silo = option('silo', 'choice', 'vanilla', { choices: ['vanilla', 'spawn', 'randomize_recipe'] })
    const schema: GameSchema = { ...SCHEMA, groups: [{ name: 'Game Options', options: [silo] }], presets: {} }
    const { user } = await renderApp({
      route: '/studio',
      handlers: handlers({ 'studio:schema': () => schema }),
      config: NO_FX,
    })
    await startNew(user)
    const card = within(await screen.findByRole('region', { name: 'Silo' }))
    const dice = card.getByRole('button', { name: 'Aléatoire pour Silo' })
    await user.click(card.getByRole('radio', { name: 'Randomize recipe' }))
    expect(card.getByRole('radio', { name: 'Randomize recipe' })).toHaveAttribute('aria-checked', 'true')
    expect(card.queryByText('Tirage au hasard')).not.toBeInTheDocument()
    expect(dice).toHaveAttribute('aria-pressed', 'false')
    // The dice still leaves it to Archipelago.
    await user.click(dice)
    expect(card.getByText('Tirage au hasard')).toBeInTheDocument()
    expect(dice).toHaveAttribute('aria-pressed', 'true')
  })
})
