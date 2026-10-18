import { screen, waitFor, within } from '@testing-library/react'
import { AppError } from '@shared/errors'
import { defaultRules } from '@shared/rules'
import type {
  BalanceProposal,
  PlayerChecks,
  PlayerDoc,
  PlayerFile,
  Session,
  SessionChecks,
  SessionValidation,
} from '@shared/types'
import { ChecksPanel } from '@renderer/features/session/ChecksPanel'
import { StepCheck } from '@renderer/features/session/StepCheck'
import { installGoatMock, type GoatHandlers } from './goat-mock'
import { renderApp, renderWithProviders } from './render-app'

const NOW = '2026-10-18T10:00:00.000Z'
const COVER = `goat-cover://${'cd'.repeat(32)}.jpg`

function doc(index: number, name: string, ...games: string[]): PlayerDoc {
  return { index, name, games: games.map((game) => ({ game, weight: 1 })), issues: [] }
}

function playerFile(id: string, docs: PlayerDoc[]): PlayerFile {
  return { id, originalName: `${id}.yaml`, storedName: `${id}.yaml`, docs, addedAt: NOW }
}

function session(players: PlayerFile[]): Session {
  return {
    id: 's1',
    name: 'Soirée GOAT',
    createdAt: NOW,
    updatedAt: NOW,
    status: 'draft',
    players,
    rules: defaultRules(),
    hasPassword: false,
    hasServerPassword: false,
    generation: null,
    hosting: null,
    workspace: 'C:\\sessions\\s1',
  }
}

const SESSION = session([
  playerFile('f1', [doc(0, 'Link', 'A Link to the Past')]),
  playerFile('f2', [doc(0, 'Madeline', 'Celeste')]),
  playerFile('f3', [doc(0, 'Knight', 'Hollow Knight')]),
])

function counted(fileId: string, name: string, game: string | null, checks: number | null) {
  return (extra: Partial<PlayerChecks> = {}): PlayerChecks => ({
    fileId,
    docIndex: 0,
    name,
    game,
    checks,
    range: null,
    source: 'measure',
    error: null,
    ...extra,
  })
}

const LINK = counted('f1', 'Link', 'A Link to the Past', 100)
const MADELINE = counted('f2', 'Madeline', 'Celeste', 110)
const KNIGHT = counted('f3', 'Knight', 'Hollow Knight', 200)

/** The median is 110: Knight is 82 % above it, the other two are within a quarter of it. */
const MEASURED: SessionChecks = { measuredAt: NOW, players: [LINK(), MADELINE(), KNIGHT()] }

/** A check that finds nothing to fix. */
const READY: SessionValidation = {
  files: SESSION.players.map((file) => ({ fileId: file.id, docs: file.docs })),
  sessionIssues: [],
  missingWorlds: [],
  romNeeds: [],
  blocking: false,
}

const PROPOSALS: BalanceProposal[] = [
  {
    id: 'p1',
    changes: [
      { key: 'randomize_charms', from: true, to: false },
      { key: 'goal', from: 'hollowknight', to: 'siblings' },
    ],
    checks: 118,
    diff: '-  randomize_charms: true\n+  randomize_charms: false\n-  goal: hollowknight\n+  goal: siblings',
  },
  {
    id: 'p2',
    changes: [{ key: 'randomize_charms', from: true, to: false }],
    checks: 140,
    diff: '-  randomize_charms: true\n+  randomize_charms: false',
  },
]

async function renderPanel(handlers: GoatHandlers = {}, forSession: Session = SESSION) {
  const goat = installGoatMock({ 'checks:lastSession': () => MEASURED, ...handlers })
  const rendered = await renderWithProviders(<ChecksPanel session={forSession} />)
  return { goat, ...rendered }
}

// Testing Library reads a non-breaking space as a plain one in the page, not in the text it is given:
// the strings it looks for are written with plain spaces, the ones compared as they are keep U+00A0.

/** The row of a player, by name. */
function rowOf(name: string): HTMLElement {
  const item = screen.getByText(name).closest('li')
  if (!item) throw new Error(`no row for ${name}`)
  return item
}

/** Starts the suggestion for Knight and lets the task answer with `proposals`. */
async function suggestForKnight(
  goat: Awaited<ReturnType<typeof renderPanel>>['goat'],
  user: Awaited<ReturnType<typeof renderPanel>>['user'],
  proposals: BalanceProposal[] = PROPOSALS,
  taskId = 's1',
): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Proposer des réglages pour Knight' }))
  await waitFor(() => expect(goat.inputsOf('checks:suggest')).toHaveLength(1))
  goat.emit('task:progress', {
    taskId,
    kind: 'measure',
    stage: 'generate',
    percent: null,
    detail: { done: 3 },
  })
  goat.emit('task:done', { taskId, kind: 'measure', result: proposals })
  return screen.findByRole('dialog', { name: 'Réglages proposés pour Knight' })
}

describe('ChecksPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists one row per player document with cover, name, game and the last counts', async () => {
    const duo = playerFile('f4', [doc(0, 'Samus', 'Metroid Prime'), doc(1, 'Ridley', 'Super Metroid')])
    const { goat } = await renderPanel(
      {
        'covers:get': ({ game }) => ({ url: game === 'Celeste' ? COVER : null }),
        'checks:lastSession': () => ({
          measuredAt: NOW,
          players: [
            LINK(),
            MADELINE(),
            KNIGHT(),
            { ...counted('f4', 'Samus', 'Metroid Prime', 130)(), docIndex: 0 },
            { ...counted('f4', 'Ridley', 'Super Metroid', 90)(), docIndex: 1 },
          ],
        }),
      },
      session([...SESSION.players, duo]),
    )

    const panel = await screen.findByRole('region', { name: 'Checks' })
    await within(panel).findByText('130')
    expect(within(panel).getAllByRole('listitem')).toHaveLength(5)
    expect(goat.inputsOf('checks:lastSession')[0]).toEqual({ sessionId: 's1' })

    const celeste = within(rowOf('Madeline'))
    expect(celeste.getByText('Celeste')).toBeInTheDocument()
    expect(celeste.getByText('110')).toBeInTheDocument()
    await waitFor(() => expect(rowOf('Madeline').querySelector('img')).toHaveAttribute('src', COVER))
    // Two players in one file are two rows, each with its own count.
    expect(within(rowOf('Samus')).getByText('Metroid Prime')).toBeInTheDocument()
    expect(within(rowOf('Ridley')).getByText('90')).toBeInTheDocument()
    // A player whose cover is unknown keeps the pixel sprite.
    expect(rowOf('Link').querySelector('.game-sprite')).not.toBeNull()
  })

  it('shows "jusqu\'à N" estimates before any measure', async () => {
    const rolled = playerFile('f4', [doc(0, 'Dice', 'Celeste', 'Hollow Knight')])
    const max: Record<string, number> = { 'A Link to the Past': 976, Celeste: 312 }
    const { goat } = await renderPanel(
      {
        'checks:lastSession': () => null,
        'checks:estimate': ({ games }) =>
          Object.fromEntries(games.map((game) => [game, { max: max[game] ?? null, profiles: null }])),
      },
      session([...SESSION.players, rolled]),
    )

    expect(await screen.findByText('jusqu’à 976 checks')).toBeInTheDocument()
    expect(within(rowOf('Madeline')).getByText('jusqu’à 312 checks')).toBeInTheDocument()
    // The estimate is asked once for the games the players play alone; the dice player has no single game.
    expect(goat.inputsOf('checks:estimate')).toEqual([
      { games: ['A Link to the Past', 'Celeste', 'Hollow Knight'] },
    ])
    // A game no table knows, and a player who rolls their game, have nothing to show yet.
    expect(within(rowOf('Knight')).getByText('Pas encore mesuré')).toBeInTheDocument()
    expect(within(rowOf('Dice')).getByText('Pas encore mesuré')).toBeInTheDocument()
    // Nothing is flagged without a measure, so nothing is offered.
    expect(screen.queryByRole('button', { name: /Proposer des réglages/ })).toBeNull()
  })

  it('Mesurer les checks starts a measure task and shows its progress', async () => {
    let last: SessionChecks | null = null
    const { goat, user } = await renderPanel({
      'checks:lastSession': () => last,
      'checks:measureSession': () => ({ taskId: 'm1' }),
    })
    const measure = await screen.findByRole('button', { name: 'Mesurer les checks' })
    await waitFor(() => expect(goat.inputsOf('checks:lastSession')).toHaveLength(1))

    await user.click(measure)
    await waitFor(() => expect(goat.inputsOf('checks:measureSession')).toEqual([{ sessionId: 's1' }]))
    goat.emit('task:progress', {
      taskId: 'm1',
      kind: 'measure',
      stage: 'generate',
      percent: 50,
      detail: { done: 2, total: 4 },
    })

    const bar = await screen.findByRole('progressbar', { name: 'Générations de test' })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(bar).toHaveAttribute('aria-valuetext', '2 sur 4 joueurs')
    // One measure at a time.
    expect(screen.getByRole('button', { name: 'Mesurer les checks' })).toBeDisabled()

    last = MEASURED
    goat.emit('task:done', { taskId: 'm1', kind: 'measure', result: MEASURED })
    expect(await within(rowOf('Knight')).findByText('200')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('button', { name: 'Mesurer les checks' })).toBeEnabled()
  })

  it('says why a measure failed and lets it start again', async () => {
    let started = 0
    const { goat, user } = await renderPanel({
      'checks:measureSession': () => ({ taskId: `m${String(++started)}` }),
    })
    await user.click(await screen.findByRole('button', { name: 'Mesurer les checks' }))
    await waitFor(() => expect(goat.inputsOf('checks:measureSession')).toHaveLength(1))

    goat.emit('task:failed', { taskId: 'm1', kind: 'measure', error: { code: 'MEASURE_TIMEOUT' } })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('La génération de test a pris trop de temps')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mesurer les checks' })).toBeEnabled()

    // Starting again clears the failure.
    await user.click(screen.getByRole('button', { name: 'Mesurer les checks' }))
    await waitFor(() => expect(goat.inputsOf('checks:measureSession')).toHaveLength(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('says nothing of a measure that was cancelled', async () => {
    const { goat, user } = await renderPanel({ 'checks:measureSession': () => ({ taskId: 'm1' }) })
    await user.click(await screen.findByRole('button', { name: 'Mesurer les checks' }))
    await waitFor(() => expect(goat.inputsOf('checks:measureSession')).toHaveLength(1))

    goat.emit('task:failed', { taskId: 'm1', kind: 'measure', error: { code: 'TASK_CANCELLED' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mesurer les checks' })).toBeEnabled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('flags a player beyond ±25 % of the median and changes the target with the selector (court/moyen/long/nombre)', async () => {
    const { user } = await renderPanel()
    const gap = (name: string): string | null => {
      const row = rowOf(name)
      return (
        within(row).queryByText('Dans la cible')?.textContent ??
        row.querySelector('.status-pill__label')?.textContent ??
        null
      )
    }

    // The median: 110 checks.
    expect(await screen.findByText('Cible : 110 checks')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Moyen' })).toBeChecked()
    expect(gap('Link')).toBe('Dans la cible')
    expect(gap('Madeline')).toBe('Dans la cible')
    expect(gap('Knight')).toBe('82\u00a0% au-dessus de la cible')
    expect(rowOf('Knight')).toHaveAttribute('data-off')
    expect(rowOf('Link')).not.toHaveAttribute('data-off')

    // Short: 0.6 × 110 = 66 checks, everyone is above it.
    await user.click(screen.getByRole('radio', { name: 'Court' }))
    expect(screen.getByText('Cible : 66 checks')).toBeInTheDocument()
    expect(gap('Link')).toBe('52\u00a0% au-dessus de la cible')
    expect(gap('Knight')).toBe('203\u00a0% au-dessus de la cible')

    // Long: 1.5 × 110 = 165 checks, Knight is back within a quarter of it.
    await user.click(screen.getByRole('radio', { name: 'Long' }))
    expect(screen.getByText('Cible : 165 checks')).toBeInTheDocument()
    expect(gap('Link')).toBe('39\u00a0% en dessous de la cible')
    expect(gap('Knight')).toBe('Dans la cible')

    // A number of checks.
    await user.click(screen.getByRole('radio', { name: 'Nombre' }))
    const count = screen.getByRole('spinbutton', { name: 'Nombre de checks visé' })
    expect(count).toHaveValue(165)
    await user.clear(count)
    await user.type(count, '105')
    expect(screen.getByText('Cible : 105 checks')).toBeInTheDocument()
    expect(gap('Link')).toBe('Dans la cible')
    expect(gap('Madeline')).toBe('Dans la cible')
    expect(gap('Knight')).toBe('90\u00a0% au-dessus de la cible')

    // An empty or impossible number aims at nothing: nobody is flagged.
    await user.clear(count)
    expect(screen.getByText('Entre un nombre de checks entre 1 et 100 000.')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-off]')).toHaveLength(0)
  })

  it('offers Proposer des réglages only on a flagged player with a measured count and a known game', async () => {
    const rolled = playerFile('f4', [doc(0, 'Dice', 'Celeste', 'Hollow Knight')])
    const extra = playerFile('f5', [doc(0, 'Samus', 'Metroid Prime')])
    const { user } = await renderPanel(
      {
        'checks:lastSession': () => ({
          measuredAt: NOW,
          players: [
            LINK(),
            MADELINE(),
            KNIGHT(),
            counted('f4', 'Dice', null, 190)(),
            counted('f5', 'Samus', 'Metroid Prime', 105)(),
          ],
        }),
      },
      session([...SESSION.players, rolled, extra]),
    )

    // Knight and Dice are both above the target; only Knight plays a game that has options to look at.
    await screen.findByRole('button', { name: 'Proposer des réglages pour Knight' })
    expect(screen.getAllByRole('button', { name: /Proposer des réglages/ })).toHaveLength(1)
    expect(within(rowOf('Dice')).getByText(/au-dessus de la cible/)).toBeInTheDocument()

    // With the short target everyone but Dice can be proposed settings.
    await user.click(screen.getByRole('radio', { name: 'Court' }))
    expect(screen.getAllByRole('button', { name: /Proposer des réglages/ })).toHaveLength(4)
    expect(within(rowOf('Dice')).queryByRole('button')).toBeNull()
  })

  it('Proposer des réglages shows the proposals with their counts and diff', async () => {
    const { goat, user } = await renderPanel({ 'checks:suggest': () => ({ taskId: 's1' }) })
    await user.click(await screen.findByRole('button', { name: 'Proposer des réglages pour Knight' }))

    await waitFor(() =>
      expect(goat.inputsOf('checks:suggest')).toEqual([
        { sessionId: 's1', fileId: 'f3', docIndex: 0, target: { kind: 'median' } },
      ]),
    )
    goat.emit('task:progress', {
      taskId: 's1',
      kind: 'measure',
      stage: 'generate',
      percent: null,
      detail: { done: 3 },
    })
    const bar = await screen.findByRole('progressbar', { name: 'Recherche de réglages pour Knight…' })
    expect(bar).toHaveAttribute('aria-valuetext', '3 essais mesurés')
    expect(screen.getByRole('button', { name: 'Mesurer les checks' })).toBeDisabled()

    goat.emit('task:done', { taskId: 's1', kind: 'measure', result: PROPOSALS })
    const dialog = await screen.findByRole('dialog', { name: 'Réglages proposés pour Knight' })
    expect(within(dialog).getByText(/200 checks/)).toBeInTheDocument()
    expect(within(dialog).getByText(/110 checks/)).toBeInTheDocument()

    const first = within(dialog).getByRole('listitem', { name: 'Proposition 1' })
    expect(within(first).getByText('118 checks')).toBeInTheDocument()
    expect(within(first).getByText('randomize_charms')).toBeInTheDocument()
    expect(within(first).getByText('true → false')).toBeInTheDocument()
    expect(within(first).getByText('hollowknight → siblings')).toBeInTheDocument()
    const diff = first.querySelector('pre')
    const lines = [...(diff?.querySelectorAll('[data-kind]') ?? [])].map((line) => line.textContent)
    expect(lines).toEqual(PROPOSALS[0]?.diff.split('\n'))
    expect(diff?.querySelectorAll('[data-kind="del"]')).toHaveLength(2)
    expect(diff?.querySelectorAll('[data-kind="add"]')).toHaveLength(2)

    const second = within(dialog).getByRole('listitem', { name: 'Proposition 2' })
    expect(within(second).getByText('140 checks')).toBeInTheDocument()
    // Nothing is written until Appliquer is clicked.
    expect(goat.inputsOf('checks:apply')).toEqual([])
  })

  it('passes the target the player chose to the suggestion', async () => {
    const { goat, user } = await renderPanel({ 'checks:suggest': () => ({ taskId: 's1' }) })
    await user.click(await screen.findByRole('radio', { name: 'Nombre' }))
    const count = screen.getByRole('spinbutton', { name: 'Nombre de checks visé' })
    await user.clear(count)
    await user.type(count, '150')
    await user.click(screen.getByRole('button', { name: 'Proposer des réglages pour Link' }))

    await waitFor(() =>
      expect(goat.inputsOf('checks:suggest')).toEqual([
        { sessionId: 's1', fileId: 'f1', docIndex: 0, target: { kind: 'count', value: 150 } },
      ]),
    )
  })

  it('says so when no option of the game changes its size', async () => {
    const { goat, user } = await renderPanel({ 'checks:suggest': () => ({ taskId: 's1' }) })
    const dialog = await suggestForKnight(goat, user, [])

    expect(within(dialog).getByText(/Aucune option de Hollow Knight ne change sa taille/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Appliquer/ })).toBeNull()
  })

  it('shows a suggestion that failed as its translated error', async () => {
    const { goat, user } = await renderPanel({ 'checks:suggest': () => ({ taskId: 's1' }) })
    await user.click(await screen.findByRole('button', { name: 'Proposer des réglages pour Knight' }))
    await waitFor(() => expect(goat.inputsOf('checks:suggest')).toHaveLength(1))
    goat.emit('task:failed', {
      taskId: 's1',
      kind: 'measure',
      error: { code: 'AP_ROM_MISSING', params: { game: 'Hollow Knight' } },
    })

    const dialog = await screen.findByRole('dialog', { name: 'Réglages proposés pour Knight' })
    expect(within(dialog).getByText('ROM manquante pour la génération')).toBeInTheDocument()
  })

  it('Appliquer calls checks:apply and refreshes the rows', async () => {
    let last = MEASURED
    const { goat, user, queryClient } = await renderPanel({
      'checks:lastSession': () => last,
      'checks:suggest': () => ({ taskId: 's1' }),
      'checks:apply': () => SESSION,
      'checks:measureSession': () => ({ taskId: 'm2' }),
    })
    const invalidated: string[] = []
    const original = queryClient.invalidateQueries.bind(queryClient)
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((filters, options) => {
      invalidated.push(String(filters?.queryKey?.[0]))
      return original(filters, options)
    })

    const dialog = await suggestForKnight(goat, user)
    await user.click(
      within(within(dialog).getByRole('listitem', { name: 'Proposition 1' })).getByRole('button', {
        name: 'Appliquer',
      }),
    )

    await waitFor(() =>
      expect(goat.inputsOf('checks:apply')).toEqual([{ sessionId: 's1', fileId: 'f3', proposalId: 'p1' }]),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText('Réglages appliqués à Knight')).toBeInTheDocument()
    // The file changed: the session and its validation are read again, and the checks measured again
    // (main keeps the counts of the file as it was).
    await waitFor(() => expect(invalidated).toContain('session:validate'))
    expect(queryClient.getQueryData(['session:get', { id: 's1' }])).toEqual(SESSION)
    await waitFor(() => expect(goat.inputsOf('checks:measureSession')).toEqual([{ sessionId: 's1' }]))

    last = { measuredAt: NOW, players: [LINK(), MADELINE(), KNIGHT({ checks: 118 })] }
    goat.emit('task:done', { taskId: 'm2', kind: 'measure', result: last })
    expect(await within(rowOf('Knight')).findByText('118')).toBeInTheDocument()
    expect(within(rowOf('Knight')).queryByText(/au-dessus de la cible/)).toBeNull()
  })

  it('tells that a proposal is outdated and offers to look again', async () => {
    let asked = 0
    const { goat, user } = await renderPanel({
      'checks:suggest': () => ({ taskId: `s${String(++asked)}` }),
      'checks:apply': () => {
        throw new AppError('NOT_FOUND')
      },
    })
    const dialog = await suggestForKnight(goat, user, PROPOSALS, 's1')
    await user.click(
      within(within(dialog).getByRole('listitem', { name: 'Proposition 1' })).getByRole('button', {
        name: 'Appliquer',
      }),
    )

    expect(await within(dialog).findByText(/Cette proposition n’est plus valable/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Appliquer' })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Chercher de nouveau' }))
    await waitFor(() => expect(goat.inputsOf('checks:suggest')).toHaveLength(2))
    expect(goat.inputsOf('checks:suggest')[1]).toEqual(goat.inputsOf('checks:suggest')[0])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(
      await screen.findByRole('progressbar', { name: 'Recherche de réglages pour Knight…' }),
    ).toBeInTheDocument()
  })

  it('shows any other failure to apply as its translated error and keeps the proposals', async () => {
    const { goat, user } = await renderPanel({
      'checks:suggest': () => ({ taskId: 's1' }),
      'checks:apply': () => {
        throw new AppError('AP_YAML_INVALID')
      },
    })
    const dialog = await suggestForKnight(goat, user)
    await user.click(
      within(within(dialog).getByRole('listitem', { name: 'Proposition 2' })).getByRole('button', {
        name: 'Appliquer',
      }),
    )

    const alert = await within(dialog).findByRole('alert')
    expect(within(alert).getByText('Archipelago refuse un YAML')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('button', { name: 'Appliquer' })).toHaveLength(2)
  })

  it('a row in error shows the translated reason', async () => {
    await renderPanel({
      'checks:lastSession': () => ({
        measuredAt: NOW,
        players: [LINK(), MADELINE(), KNIGHT({ checks: null, error: { code: 'MEASURE_TIMEOUT' } })],
      }),
    })

    const row = within(await waitFor(() => rowOf('Knight')))
    expect(row.getByText('La génération de test a pris trop de temps')).toBeInTheDocument()
    expect(
      row.getByText(/Archipelago n’a pas terminé la génération de test de ce joueur/),
    ).toBeInTheDocument()
    // No count to compare, so no gap and no proposal.
    expect(row.queryByText(/de la cible/)).toBeNull()
    expect(row.queryByRole('button')).toBeNull()
    expect(rowOf('Knight')).toHaveAttribute('data-error')
  })

  it('keeps the estimate of a player whose ROM is missing, out of the target', async () => {
    await renderPanel({
      'checks:lastSession': () => ({
        measuredAt: NOW,
        players: [
          LINK(),
          MADELINE(),
          KNIGHT({
            checks: 5000,
            source: 'estimate',
            error: { code: 'AP_ROM_MISSING', params: { game: 'Hollow Knight' } },
          }),
        ],
      }),
    })

    const row = within(await waitFor(() => rowOf('Knight')))
    expect(row.getByText('jusqu’à 5000 checks')).toBeInTheDocument()
    expect(row.getByText('ROM manquante pour la génération')).toBeInTheDocument()
    expect(row.queryByText(/de la cible/)).toBeNull()
    // The median is that of the measured counts, 100 and 110: 105.
    expect(screen.getByText('Cible : 105 checks')).toBeInTheDocument()
  })

  it('a range is shown as "180–230"', async () => {
    await renderPanel({
      'checks:lastSession': () => ({
        measuredAt: NOW,
        players: [LINK(), MADELINE(), KNIGHT({ checks: 200, range: [180, 230] })],
      }),
    })

    const row = within(await waitFor(() => rowOf('Knight')))
    expect(row.getByText('180–230')).toBeInTheDocument()
    expect(row.getByText(/selon la graine/)).toBeInTheDocument()
    // The middle count is the one compared with the target.
    expect(row.getByText('82 % au-dessus de la cible')).toBeInTheDocument()
  })

  it('says where the counts come from', async () => {
    await renderPanel({
      'checks:lastSession': () => ({
        measuredAt: NOW,
        players: [LINK({ source: 'generation' }), MADELINE(), KNIGHT()],
      }),
    })

    expect(await within(await waitFor(() => rowOf('Link'))).findByText('partie générée')).toBeInTheDocument()
    expect(within(rowOf('Madeline')).getByText('mesuré')).toBeInTheDocument()
  })

  it('speaks English', async () => {
    installGoatMock({ 'checks:lastSession': () => MEASURED })
    await renderWithProviders(<ChecksPanel session={SESSION} />, { lang: 'en' })

    expect(await screen.findByRole('button', { name: 'Measure the checks' })).toBeInTheDocument()
    expect(await screen.findByText('Target: 110 checks')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Short' })).toBeInTheDocument()
    expect(within(rowOf('Knight')).getByText('82% above the target')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Suggest settings for Knight' })).toBeInTheDocument()
  })

  it('says it could not read the last checks, and tries again', async () => {
    let fail = true
    const { user } = await renderPanel({
      'checks:lastSession': () => {
        if (fail) throw new AppError('NOT_FOUND')
        return MEASURED
      },
    })

    const alert = await screen.findByRole('alert')
    fail = false
    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    expect(await within(rowOf('Knight')).findByText('200')).toBeInTheDocument()
  })

  it('is informative: the check step goes on with a flagged player', async () => {
    installGoatMock({ 'checks:lastSession': () => MEASURED, 'session:validate': () => READY })
    const onNext = vi.fn()
    const { user } = await renderWithProviders(
      <StepCheck session={SESSION} onBack={vi.fn()} onNext={onNext} />,
    )

    expect(await screen.findByRole('region', { name: 'Checks' })).toBeInTheDocument()
    expect(await screen.findByText('82 % au-dessus de la cible')).toBeInTheDocument()
    const next = screen.getByRole('button', { name: 'Suivant' })
    expect(next).toBeEnabled()
    await user.click(next)
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('keeps following a measure when the step is left and come back to, and reads its end', async () => {
    let last: SessionChecks | null = null
    const { goat, user } = await renderApp({
      route: '/session/s1?step=2',
      config: { effects: { crt: false, glow: false, animations: false, sounds: false } },
      handlers: {
        'session:get': () => SESSION,
        'session:validate': () => READY,
        'checks:lastSession': () => last,
        'checks:measureSession': () => ({ taskId: 'm1' }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Mesurer les checks' }))
    await waitFor(() => expect(goat.inputsOf('checks:measureSession')).toHaveLength(1))
    goat.emit('task:progress', {
      taskId: 'm1',
      kind: 'measure',
      stage: 'generate',
      percent: 40,
      detail: { done: 1, total: 3 },
    })
    expect(await screen.findByRole('progressbar', { name: 'Générations de test' })).toBeInTheDocument()

    // Next, then back: the panel is mounted again, and the run goes on.
    await user.click(screen.getByRole('button', { name: 'Suivant' }))
    await screen.findByRole('group', { name: 'Règles' })
    expect(screen.queryByRole('region', { name: 'Checks' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Précédent' }))
    const bar = await screen.findByRole('progressbar', { name: 'Générations de test' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(bar).toHaveAttribute('aria-valuetext', '1 sur 3 joueurs')
    expect(screen.getByRole('button', { name: 'Mesurer les checks' })).toBeDisabled()
    expect(goat.inputsOf('checks:measureSession')).toHaveLength(1)

    // It ends while this panel is not the one that started it: the rows are read again.
    last = MEASURED
    goat.emit('task:done', { taskId: 'm1', kind: 'measure', result: MEASURED })
    expect(await within(rowOf('Knight')).findByText('200')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('button', { name: 'Mesurer les checks' })).toBeEnabled()
  })
})
