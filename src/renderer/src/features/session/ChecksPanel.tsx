// The Checks panel of the check step (spec §4): how many checks each player document of the session
// has (measured by test generations, read from the real generation, or the most its game can have),
// against the target the session aims at, and measured proposals for the players beyond it. It is
// informative: it never stops the step from going on.
import { IconAdjustments, IconRulerMeasure } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction, TOptions } from 'i18next'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isOffTarget, MAX_TARGET, measuredCounts, targetOf } from '@shared/checks'
import type { AppErrorData } from '@shared/errors'
import type {
  BalanceProposal,
  BalanceTarget,
  PlayerChecks,
  PlayerDoc,
  Session,
  SessionChecks,
} from '@shared/types'
import {
  ErrorPanel,
  Modal,
  NeonButton,
  PixelPanel,
  ProgressBar,
  Segmented,
  Spinner,
  StatusPill,
  useToast,
  type SegmentedOption,
} from '../../design/components'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useTask } from '../../hooks/useTask'
import { describeError } from '../../lib/errors'
import { stageLabel } from '../../lib/task-stages'
import { useTasksStore } from '../../stores/tasks'
import { PlayerGames } from './PlayerGames'
import './ChecksPanel.css'

type PanelText = (key: string, options?: TOptions) => string

/** The root `t`, and `p('measure')` for `screens.session.checksPanel.measure`. */
function usePanelText(): { t: TFunction; p: PanelText } {
  const { t } = useTranslation()
  return { t, p: (key, options) => t(`screens.session.checksPanel.${key}`, options) }
}

type TargetKind = BalanceTarget['kind']

/** The order the selector shows them in: from the shortest game to a number of one's own. */
const TARGET_KINDS: readonly TargetKind[] = ['short', 'median', 'long', 'count']

/** The target the selector stands for; null for a number that no target can be. */
function targetOfChoice(kind: TargetKind, countText: string): BalanceTarget | null {
  if (kind !== 'count') return { kind }
  const value = /^\d+$/.test(countText.trim()) ? Number(countText) : 0
  return value >= 1 && value <= MAX_TARGET ? { kind, value } : null
}

/** A count that was measured or read from a generation, as against the estimate kept for want of a ROM. */
type Exact = PlayerChecks & { checks: number; source: 'measure' | 'generation' }

function exactOf(checks: PlayerChecks | null): Exact | null {
  if (checks === null || checks.source === 'estimate' || checks.checks === null) return null
  return { ...checks, checks: checks.checks, source: checks.source }
}

/** One player document of the session, with what the last checks say of it. */
interface Row {
  key: string
  fileId: string
  docIndex: number
  name: string | null
  games: PlayerDoc['games']
  /** The game it plays when it plays one only (else it rolls between several). */
  game: string | null
  checks: PlayerChecks | null
}

/** The documents of the session in its order, each with its row of the last checks if it has one. */
function rowsOf(session: Session, last: SessionChecks | null): Row[] {
  const known = new Map((last?.players ?? []).map((row) => [`${row.fileId}#${row.docIndex}`, row]))
  return session.players.flatMap((file) =>
    file.docs.map((doc): Row => {
      const key = `${file.id}#${doc.index}`
      return {
        key,
        fileId: file.id,
        docIndex: doc.index,
        name: doc.name,
        games: doc.games,
        game: doc.games.length === 1 ? (doc.games[0]?.game ?? null) : null,
        checks: known.get(key) ?? null,
      }
    }),
  )
}

/** The proposals asked for one player: what the dialog that shows them needs to say. */
interface Suggestion {
  fileId: string
  docIndex: number
  name: string
  game: string
  /** The player's count and the number of checks aimed at, when the proposals were asked for. */
  checks: number
  goal: number
  taskId: string | null
}

/** A number the progress of a task reports in its detail, if it reports it. */
function detailNumber(detail: Record<string, string | number> | undefined, name: string): number | null {
  const value = detail?.[name]
  return typeof value === 'number' ? value : null
}

export function ChecksPanel({ session }: { session: Session }): React.JSX.Element {
  const { t, p } = usePanelText()
  const toast = useToast()
  const queryClient = useQueryClient()
  const sessionId = session.id
  const countId = useId()
  const [kind, setKind] = useState<TargetKind>('median')
  const [countText, setCountText] = useState('')
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [measureId, setMeasureId] = useState<string | null>(null)

  // Asked again on each visit: a generation, or a measure that ended meanwhile, wrote new counts.
  const last = useIpcQuery('checks:lastSession', { sessionId }, { refetchOnMount: 'always' })
  const rows = rowsOf(session, last.data ?? null)
  const games = [...new Set(rows.flatMap((row) => (row.game === null ? [] : [row.game])))]
  const estimates = useIpcQuery('checks:estimate', { games }, { enabled: games.length > 0 })

  const counts = measuredCounts(last.data?.players ?? [])
  const target = targetOfChoice(kind, countText)
  // Without a measured count there is nothing to take the median of: no target, nobody flagged.
  const goal =
    target !== null && (target.kind === 'count' || counts.length > 0) ? targetOf(counts, target) : null

  // --- The measure of the whole session ---
  const startMeasure = useIpcMutation('checks:measureSession', {
    onSuccess: ({ taskId }) => setMeasureId(taskId),
  })
  const measureTask = useTask(measureId)
  const failed: AppErrorData | null =
    startMeasure.error ?? (measureTask.status === 'failed' ? measureTask.error : null)
  // A measure that was cancelled elsewhere says nothing.
  const measureFailure = failed?.code === 'TASK_CANCELLED' ? null : failed
  const measure = (): void => {
    startMeasure.reset()
    setMeasureId(null)
    startMeasure.mutate({ sessionId })
  }
  useEffect(() => {
    if (measureTask.status === 'done')
      void queryClient.invalidateQueries({ queryKey: ['checks:lastSession'] })
  }, [measureTask.status, measureId, queryClient])

  // --- The proposals for one player ---
  const startSuggest = useIpcMutation('checks:suggest', {
    onSuccess: ({ taskId }) => setSuggestion((current) => current && { ...current, taskId }),
  })
  const apply = useIpcMutation('checks:apply', { invalidates: ['session:validate', 'session:list'] })
  const suggestTask = useTask(suggestion?.taskId ?? null)
  const suggestFailure: AppErrorData | null =
    suggestion === null
      ? null
      : (startSuggest.error ?? (suggestTask.status === 'failed' ? suggestTask.error : null))
  const suggestDone = suggestion !== null && suggestTask.status === 'done'
  const searching = suggestion !== null && suggestFailure === null && !suggestDone ? suggestion : null
  // A suggestion that was cancelled elsewhere says nothing.
  const dialogOpen = suggestDone || (suggestFailure !== null && suggestFailure.code !== 'TASK_CANCELLED')

  // A run of the panel is followed by its id. One it did not start, or lost track of when the step was
  // left and come back to, is found among the running `measure` tasks the app knows (a task's kind is
  // known from its first event): it keeps the panel busy and shows its progress, as the first run did.
  const otherRun = useTasksStore((state) =>
    searching === null
      ? (Object.values(state.tasks).find(
          (task) =>
            task.kind === 'measure' &&
            task.status === 'running' &&
            task.taskId !== measureId &&
            task.taskId !== suggestion?.taskId,
        ) ?? null)
      : null,
  )
  const ownRun = measureId !== null && measureTask.status === 'running'
  const measuring = startMeasure.isPending || ownRun || otherRun !== null
  const measureProgress = ownRun ? measureTask.progress : (otherRun?.progress ?? null)

  const suggest = (row: Row, exact: Exact): void => {
    if (target === null || goal === null || exact.game === null) return
    startSuggest.reset()
    apply.reset()
    setSuggestion({
      fileId: row.fileId,
      docIndex: row.docIndex,
      name: row.name ?? t('screens.session.check.unnamed'),
      game: exact.game,
      checks: exact.checks,
      goal,
      taskId: null,
    })
    startSuggest.mutate({ sessionId, fileId: row.fileId, docIndex: row.docIndex, target })
  }
  const closeProposals = (): void => {
    startSuggest.reset()
    apply.reset()
    setSuggestion(null)
  }
  /** The same player again, from the counts as they are now. */
  const suggestAgain = (): void => {
    const row = rows.find((r) => r.fileId === suggestion?.fileId && r.docIndex === suggestion.docIndex)
    const exact = exactOf(row?.checks ?? null)
    if (row && exact) suggest(row, exact)
    else closeProposals()
  }
  const applyProposal = (proposalId: string): void => {
    if (suggestion === null) return
    const { fileId, name } = suggestion
    apply.mutate(
      { sessionId, fileId, proposalId },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(['session:get', { id: sessionId }], updated)
          toast.push({
            tone: 'ok',
            title: p('proposals.applied', { name }),
            body: p('proposals.appliedBody'),
          })
          closeProposals()
          // Main keeps the counts of the file as it was: measure the new one.
          measure()
        },
      },
    )
  }

  const busy = measuring || searching !== null || apply.isPending
  const options: SegmentedOption<TargetKind>[] = TARGET_KINDS.map((value) => ({
    value,
    label: p(`target.${value}`),
  }))
  const choose = (next: TargetKind): void => {
    setKind(next)
    // A number to start from: the target the organizer was looking at.
    if (next === 'count' && countText === '' && goal !== null) setCountText(String(goal))
  }
  const invalidCount = kind === 'count' && target === null
  // An empty field is not yet wrong: the hint says what to enter, without the alarm.
  const wrongCount = invalidCount && countText.trim() !== ''

  return (
    <PixelPanel
      tone="cyan"
      padding="md"
      title={p('title')}
      actions={
        <NeonButton
          size="sm"
          icon={<IconRulerMeasure />}
          loading={measuring}
          disabled={busy}
          onClick={measure}
        >
          {p('measure')}
        </NeonButton>
      }
    >
      <p className="checks-panel__intro">{p('intro')}</p>

      <div className="checks-target">
        <Segmented size="sm" label={p('target.label')} options={options} value={kind} onChange={choose} />
        {kind === 'count' && (
          <div className="field checks-target__count">
            <label htmlFor={countId} className="field__label sr-only">
              {p('target.countLabel')}
            </label>
            <div className="input-frame pixel-border tone-cyan" data-invalid={wrongCount || undefined}>
              <input
                id={countId}
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_TARGET}
                value={countText}
                aria-invalid={wrongCount}
                onChange={(event) => setCountText(event.target.value)}
              />
            </div>
          </div>
        )}
        <p className="checks-target__goal" data-problem={wrongCount || undefined}>
          {invalidCount
            ? p('target.invalid')
            : goal === null
              ? p('target.unknown')
              : p('target.goal', { value: p('checksCount', { count: goal }) })}
        </p>
      </div>

      {measuring && (
        <ProgressBar
          className="checks-panel__progress"
          tone="cyan"
          percent={measureProgress?.percent ?? null}
          label={stageLabel(measureProgress, t) ?? p('measuring')}
          valueText={playersDone(measureProgress?.detail, p)}
        />
      )}
      {searching && (
        <ProgressBar
          className="checks-panel__progress"
          tone="cyan"
          percent={null}
          label={p('suggesting', { name: searching.name })}
          valueText={triesDone(suggestTask.progress?.detail, p)}
        />
      )}
      {!measuring && measureFailure && (
        <Failure
          error={measureFailure}
          action={
            <NeonButton variant="secondary" size="sm" onClick={measure}>
              {t('common.retry')}
            </NeonButton>
          }
        />
      )}
      {last.isError && (
        <Failure
          error={last.error}
          action={
            <NeonButton variant="secondary" size="sm" onClick={() => void last.refetch()}>
              {t('common.retry')}
            </NeonButton>
          }
        />
      )}

      {last.isPending ? (
        <div className="checks-panel__loading">
          <Spinner label={t('common.loading')} />
        </div>
      ) : (
        <ul className="checks-rows">
          {rows.map((row) => (
            <CheckRow
              key={row.key}
              row={row}
              estimate={row.game === null ? null : (estimates.data?.[row.game]?.max ?? null)}
              goal={goal}
              busy={busy}
              onSuggest={suggest}
            />
          ))}
        </ul>
      )}

      <ProposalsDialog
        open={dialogOpen}
        suggestion={suggestion}
        failure={suggestFailure}
        proposals={suggestDone ? (suggestTask.result as BalanceProposal[]) : []}
        applying={apply.isPending}
        applyError={apply.error}
        onApply={applyProposal}
        onAgain={suggestAgain}
        onClose={closeProposals}
      />
    </PixelPanel>
  )
}

function playersDone(detail: Record<string, string | number> | undefined, p: PanelText): string | undefined {
  const done = detailNumber(detail, 'done')
  const total = detailNumber(detail, 'total')
  return done !== null && total !== null ? p('playersDone', { done, total }) : undefined
}

function triesDone(detail: Record<string, string | number> | undefined, p: PanelText): string | undefined {
  const done = detailNumber(detail, 'done')
  return done === null ? undefined : p('variantsDone', { count: done })
}

function Failure({ error, action }: { error: unknown; action?: ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const { title, body, detail } = describeError(error, t)
  return (
    <ErrorPanel
      className="checks-panel__error"
      title={title}
      body={body}
      detail={detail}
      detailLabel={t('common.technicalDetails')}
      actions={action}
    />
  )
}

interface CheckRowProps {
  row: Row
  /** The most checks its game can have, when a table knows it. */
  estimate: number | null
  /** The checks aimed at; null while there is no target. */
  goal: number | null
  busy: boolean
  onSuggest: (row: Row, exact: Exact) => void
}

function CheckRow({ row, estimate, goal, busy, onSuggest }: CheckRowProps): React.JSX.Element {
  const { t, p } = usePanelText()
  const exact = exactOf(row.checks)
  // The estimate main kept for want of a ROM, else what the tables know of the game.
  const kept = row.checks?.source === 'estimate' ? row.checks.checks : null
  const upTo = exact === null ? (kept ?? estimate) : null
  const flagged = exact !== null && goal !== null && goal > 0
  const off = flagged && isOffTarget(exact.checks, goal)
  const error = row.checks?.error ? describeError(row.checks.error, t) : null
  const name = row.name ?? row.checks?.name ?? t('screens.session.check.unnamed')

  return (
    <li className="checks-row" data-off={off || undefined} data-error={error !== null || undefined}>
      <span className="checks-row__who">
        <span className="checks-row__name">{name}</span>
        <PlayerGames games={row.games} />
        {off && exact.game !== null && (
          <NeonButton
            variant="secondary"
            size="sm"
            icon={<IconAdjustments />}
            disabled={busy}
            aria-label={p('suggestLabel', { name })}
            onClick={() => onSuggest(row, exact)}
          >
            {p('suggest')}
          </NeonButton>
        )}
      </span>

      <span className="checks-row__result">
        <span className="checks-row__figure">
          {exact ? (
            <>
              <span>
                <strong className="checks-row__value">
                  {exact.range ? `${exact.range[0]}–${exact.range[1]}` : exact.checks}
                </strong>{' '}
                <span className="checks-row__unit">
                  {p('unit', { count: exact.range ? exact.range[1] : exact.checks })}
                </span>
              </span>
              <span className="checks-row__note">
                {exact.range && `${p('rangeHint')} · `}
                {p(`source.${exact.source}`)}
              </span>
            </>
          ) : upTo !== null ? (
            <span>{p('upTo', { count: upTo })}</span>
          ) : (
            error === null && <span className="checks-row__note">{p('unmeasured')}</span>
          )}
        </span>
        {flagged && (
          <StatusPill
            status={off ? 'warn' : 'ok'}
            label={
              off
                ? p(exact.checks > goal ? 'gap.above' : 'gap.below', {
                    percent: Math.round((Math.abs(exact.checks - goal) / goal) * 100),
                  })
                : p('gap.on')
            }
          />
        )}
      </span>

      {error && (
        <p className="checks-row__error">
          <strong>{error.title}</strong> <span>{error.body}</span>
        </p>
      )}
    </li>
  )
}

interface ProposalsDialogProps {
  open: boolean
  suggestion: Suggestion | null
  /** Why the proposals could not be made. */
  failure: AppErrorData | null
  proposals: BalanceProposal[]
  applying: boolean
  applyError: AppErrorData | null
  onApply: (proposalId: string) => void
  onAgain: () => void
  onClose: () => void
}

/** The proposals measured for one player, each with the options it changes and the lines it writes. */
function ProposalsDialog({
  open,
  suggestion,
  failure,
  proposals,
  applying,
  applyError,
  onApply,
  onAgain,
  onClose,
}: ProposalsDialogProps): React.JSX.Element {
  const { t, p } = usePanelText()
  // A proposal main no longer knows: more than an hour old, or the player's file changed since.
  const outdated = applyError?.code === 'NOT_FOUND'

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!applying}
      closeLabel={t('common.closeDialog')}
      tone="cyan"
      size="lg"
      eyebrow={p('proposals.eyebrow')}
      title={p('proposals.title', { name: suggestion?.name ?? '' })}
      footer={
        <NeonButton variant="ghost" disabled={applying} onClick={onClose}>
          {t('common.close')}
        </NeonButton>
      }
    >
      <div className="checks-dialog">
        {failure !== null &&
          (failure.code === 'INVALID_INPUT' ? (
            <p>{p('proposals.needMeasure')}</p>
          ) : (
            <Failure error={failure} />
          ))}
        {failure === null && suggestion && (
          <>
            {proposals.length === 0 ? (
              <p>{p('proposals.empty', { game: suggestion.game })}</p>
            ) : (
              <p>
                {p('proposals.intro', {
                  name: suggestion.name,
                  checks: p('checksCount', { count: suggestion.checks }),
                  goal: p('checksCount', { count: suggestion.goal }),
                })}
              </p>
            )}
            {applyError && !outdated && <Failure error={applyError} />}
            {outdated ? (
              <div className="checks-dialog__outdated" role="status">
                <p>{p('proposals.outdated')}</p>
                <NeonButton variant="secondary" size="sm" onClick={onAgain}>
                  {p('proposals.again')}
                </NeonButton>
              </div>
            ) : (
              proposals.length > 0 && (
                <ul className="checks-proposals" aria-label={p('proposals.listLabel')}>
                  {proposals.map((proposal, index) => (
                    <ProposalItem
                      key={proposal.id}
                      proposal={proposal}
                      n={index + 1}
                      applying={applying}
                      onApply={() => onApply(proposal.id)}
                    />
                  ))}
                </ul>
              )
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/** An option's value as the YAML writes it. */
function show(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

interface ProposalItemProps {
  proposal: BalanceProposal
  n: number
  applying: boolean
  onApply: () => void
}

function ProposalItem({ proposal, n, applying, onApply }: ProposalItemProps): React.JSX.Element {
  const { p } = usePanelText()
  const titleId = useId()
  return (
    <li className="checks-proposal pixel-border tone-cyan" aria-labelledby={titleId}>
      <div className="checks-proposal__head">
        <h3 id={titleId} className="checks-proposal__title">
          {p('proposals.proposal', { n })}
        </h3>
        <span className="checks-proposal__checks">{p('checksCount', { count: proposal.checks })}</span>
        <NeonButton size="sm" loading={applying} loadingLabel={p('proposals.applying')} onClick={onApply}>
          {p('proposals.apply')}
        </NeonButton>
      </div>
      <ul className="checks-proposal__changes" aria-label={p('proposals.changes')}>
        {proposal.changes.map((change) => (
          <li key={change.key}>
            <code>{change.key}</code> <span>{`${show(change.from)} → ${show(change.to)}`}</span>
          </li>
        ))}
      </ul>
      {/* Focusable to scroll it with the keyboard. */}
      <pre className="checks-diff" tabIndex={0} role="group" aria-label={p('proposals.diffLabel')}>
        {proposal.diff.split('\n').map((line, index) => (
          <span
            key={index}
            className="checks-diff__line"
            data-kind={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'same'}
          >
            {line}
          </span>
        ))}
      </pre>
    </li>
  )
}
