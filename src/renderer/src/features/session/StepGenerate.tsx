// Step 4: the generation. A big start button, then the stages as a life bar with the live log
// folded under it (and a calm hint when Archipelago says nothing for a long while); a failure reads
// as a translated error with its fix and the full log, a success as the slot list under pixel confetti.
// Generating a session that already has a seed asks first: the new seed replaces it, its patches and
// the game hosted on it (a local save, an archipelago.gg room), which the app can no longer reach.
import {
  IconAdjustments,
  IconBroadcast,
  IconDeviceGamepad2,
  IconFileText,
  IconHourglass,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconSearch,
  IconUserPlus,
  IconUsers,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { GENERATE_STAGE_IDS, type ErrorCode } from '@shared/codes'
import type { AppErrorData } from '@shared/errors'
import type { Generation, Session, TaskLog } from '@shared/types'
import {
  ConfirmDialog,
  EmptyState,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  ProgressBar,
  Terminal,
  useToast,
  type TerminalTone,
} from '../../design/components'
import { cssVars } from '../../design/classes'
import { sfx } from '../../design/sfx'
import { useIpcMutation } from '../../hooks/useIpc'
import { fileName } from '../../hooks/useOpenRequests'
import { useTask } from '../../hooks/useTask'
import { describeError } from '../../lib/errors'
import { PixelConfetti } from './PixelConfetti'
import { StepNav } from './StepNav'
import type { StepNumber } from './steps'
import type { GenerationRun, WizardRuns } from './wizard-runs'
import './StepGenerate.css'

/** Errors the user fixes at an earlier step of the wizard. */
const STEP_FOR_ERROR: Partial<Record<ErrorCode, StepNumber>> = {
  GENERATION_PREFLIGHT: 2,
  AP_YAML_INVALID: 2,
  AP_NAMES_NOT_UNIQUE: 2,
  AP_NO_GAME_OPTIONS: 2,
  AP_QUANTITY_DISABLED: 2,
  AP_PLANDO_DISABLED: 3,
}

const LOG_TONE: Record<TaskLog['stream'], TerminalTone> = { stdout: 'default', stderr: 'warn', app: 'dim' }
/** The stages drawn as a track; `done` is the end of the bar itself. */
const TRACK = GENERATE_STAGE_IDS.filter((stage) => stage !== 'done')

type View = 'idle' | 'running' | 'failed' | 'cancelled' | 'done'

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** The current time, ticking every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

export interface StepGenerateProps {
  session: Session
  run: GenerationRun | null
  onRun: WizardRuns['setGeneration']
  goTo: (step: StepNumber) => void
}

export function StepGenerate({ session, run, onRun, goTo }: StepGenerateProps): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const task = useTask(run?.taskId ?? null)
  const showError = (error: unknown): void => {
    const { title, body } = describeError(error, t)
    toast.push({ tone: 'error', title, body })
  }
  const generate = useIpcMutation('session:generate', {
    onSuccess: ({ taskId }) => onRun({ taskId, startedAt: Date.now(), celebrated: false }),
  })
  const cancel = useIpcMutation('tasks:cancel', { onError: showError })
  const [confirmReplace, setConfirmReplace] = useState(false)

  const failure: AppErrorData | null = generate.error ?? (run && task.status === 'failed' ? task.error : null)
  const view: View = generate.isPending
    ? 'running'
    : failure
      ? failure.code === 'TASK_CANCELLED'
        ? 'cancelled'
        : 'failed'
      : run && task.status === 'running'
        ? 'running'
        : (run && task.status === 'done') || session.generation
          ? 'done'
          : 'idle'
  const generation = run && task.status === 'done' ? (task.result as Generation) : session.generation
  const justFinished = run !== null && task.status === 'done' && !run.celebrated

  // The session now has its generation (and the status bar its new state).
  useEffect(() => {
    if (task.status !== 'done') return
    for (const channel of ['session:get', 'session:list']) {
      void queryClient.invalidateQueries({ queryKey: [channel] })
    }
  }, [task.status, run?.taskId, queryClient])

  useEffect(() => {
    if (justFinished) sfx.play('success')
  }, [justFinished])

  const run_ = (replace: boolean): void => {
    onRun(null)
    generate.reset()
    generate.mutate(replace ? { id: session.id, replace: true } : { id: session.id })
  }
  // Main refuses to replace a game in progress unconfirmed: a stale screen asks here too.
  const inProgress = failure?.code === 'GENERATION_PREFLIGHT' && failure.params?.reason === 'game-in-progress'
  const start = (): void => {
    if (session.generation !== null || inProgress) setConfirmReplace(true)
    else run_(false)
  }

  return (
    <>
      <div className="generate-step">
        {view === 'idle' && session.players.length === 0 && (
          <PixelPanel as="div" tone="violet" padding="lg">
            <EmptyState
              icon={<IconUserPlus />}
              title={t('screens.session.generate.needPlayersTitle')}
              body={t('screens.session.generate.needPlayers')}
              headingLevel={2}
              action={
                <NeonButton variant="secondary" onClick={() => goTo(1)}>
                  {t('screens.session.generate.toPlayers')}
                </NeonButton>
              }
            />
          </PixelPanel>
        )}
        {view === 'idle' && session.players.length > 0 && <Idle session={session} onStart={start} />}
        {view === 'running' && (
          <Running
            run={run}
            stage={task.progress?.stage ?? null}
            percent={task.progress?.percent ?? null}
            stalled={task.progress?.detail?.stalled === 1}
            cancelling={cancel.isPending}
            onCancel={run ? () => cancel.mutate({ taskId: run.taskId }) : undefined}
          />
        )}
        {view === 'failed' && failure && (
          <Failed error={failure} sessionId={session.id} onRetry={start} goTo={goTo} />
        )}
        {view === 'cancelled' && (
          <PixelPanel as="div" tone="neutral" padding="lg">
            <EmptyState
              icon={<IconPlayerStop />}
              tone="neutral"
              title={t('screens.session.generate.cancelledTitle')}
              body={t('screens.session.generate.cancelledBody')}
              headingLevel={2}
              action={
                <NeonButton icon={<IconRefresh />} onClick={start}>
                  {t('screens.session.generate.retry')}
                </NeonButton>
              }
            />
          </PixelPanel>
        )}
        {view === 'done' && generation && <Done generation={generation} onRegenerate={start} />}
        {run && task.logs.length > 0 && view !== 'idle' && (
          <details className="gen-log">
            <summary className="gen-log__summary">
              {t('screens.session.generate.log', { count: task.logs.length })}
            </summary>
            <Terminal
              label={t('screens.session.generate.logLabel')}
              lines={task.logs.map((log) => ({ text: log.line, tone: LOG_TONE[log.stream] }))}
            />
          </details>
        )}
      </div>
      <ConfirmDialog
        open={confirmReplace}
        tone="yellow"
        eyebrow={t('screens.session.generate.replaceEyebrow')}
        title={t('screens.session.generate.replaceTitle')}
        confirmLabel={t('screens.session.generate.replaceConfirm')}
        confirmIcon={<IconRefresh />}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.closeDialog')}
        onCancel={() => setConfirmReplace(false)}
        onConfirm={() => {
          setConfirmReplace(false)
          run_(true)
        }}
      >
        <p>{t('screens.session.generate.replaceBody')}</p>
        {session.hosting?.mode === 'local' && <p>{t('screens.session.generate.replaceLocal')}</p>}
        {session.hosting?.mode === 'web' && <p>{t('screens.session.generate.replaceWeb')}</p>}
      </ConfirmDialog>
      {justFinished && (
        <PixelConfetti onDone={() => onRun((current) => current && { ...current, celebrated: true })} />
      )}
      <StepNav
        onBack={() => goTo(3)}
        onNext={() => goTo(5)}
        nextDisabled={view !== 'done'}
        blockedReason={t('screens.session.generate.needGeneration')}
      />
    </>
  )
}

function Idle({ session, onStart }: { session: Session; onStart: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const docs = session.players.flatMap((file) => file.docs)
  const games = new Set(docs.flatMap((doc) => doc.games.map((game) => game.game)))
  const preset =
    session.rules.preset === 'custom'
      ? t('screens.session.rules.custom')
      : t(`screens.session.rules.presets.${session.rules.preset}.title`)
  return (
    <div className="gen-cabinet pixel-border tone-violet">
      <span className="gen-cabinet__press t-display" aria-hidden="true">
        {t('screens.session.generate.eyebrow')}
      </span>
      <h2 className="gen-cabinet__title">{t('screens.session.generate.idleTitle')}</h2>
      <p className="gen-cabinet__body">{t('screens.session.generate.idleBody')}</p>
      <ul className="gen-chips">
        <li>
          <IconUsers aria-hidden="true" />
          {t('screens.session.generate.players', { count: docs.length })}
        </li>
        <li>
          <IconDeviceGamepad2 aria-hidden="true" />
          {t('screens.session.generate.games', { count: games.size })}
        </li>
        <li>
          <IconAdjustments aria-hidden="true" />
          {t('screens.session.generate.preset', { preset })}
        </li>
      </ul>
      <NeonButton size="lg" icon={<IconPlayerPlay />} className="gen-cabinet__start" onClick={onStart}>
        {t('screens.session.generate.start')}
      </NeonButton>
    </div>
  )
}

interface RunningProps {
  run: GenerationRun | null
  stage: string | null
  percent: number | null
  /** No new line from Archipelago for 10 minutes (the task's `detail.stalled`). */
  stalled: boolean
  cancelling: boolean
  /** Missing until the task has an id. */
  onCancel?: () => void
}

function Running({ run, stage, percent, stalled, cancelling, onCancel }: RunningProps): React.JSX.Element {
  const { t } = useTranslation()
  const now = useNow(true)
  const known = stage !== null && (GENERATE_STAGE_IDS as readonly string[]).includes(stage)
  const label = known ? t(`stages.${stage}`) : t('screens.session.generate.stageWaiting')
  const current = known ? TRACK.indexOf(stage as (typeof TRACK)[number]) : -1
  return (
    <div className="gen-cabinet gen-cabinet--running pixel-border tone-violet">
      <span className="gen-cabinet__press t-display" aria-hidden="true">
        {t('screens.session.generate.runningEyebrow')}
      </span>
      <h2 className="gen-cabinet__title">{t('screens.session.generate.running')}</h2>
      <ProgressBar percent={percent} label={label} segments={24} tone="violet" className="gen-cabinet__bar" />
      <ol className="stage-track" aria-hidden="true">
        {TRACK.map((id, index) => (
          <li
            key={id}
            className="stage-track__node"
            data-state={index < current ? 'done' : index === current ? 'current' : 'todo'}
            style={cssVars({ '--i': index })}
          />
        ))}
      </ol>
      {stalled && (
        <p className="gen-cabinet__stalled" role="status">
          <IconHourglass aria-hidden="true" />
          <span>{t('screens.session.generate.stalled')}</span>
        </p>
      )}
      <div className="gen-cabinet__foot">
        {run && (
          <span className="gen-cabinet__elapsed">
            {t('screens.session.generate.elapsed', { time: clock((now - run.startedAt) / 1000) })}
          </span>
        )}
        <NeonButton
          variant="danger"
          size="sm"
          icon={<IconPlayerStop />}
          aria-label={t('screens.session.generate.cancelLabel')}
          disabled={!onCancel}
          loading={cancelling}
          onClick={onCancel}
        >
          {t('screens.session.generate.cancel')}
        </NeonButton>
      </div>
    </div>
  )
}

interface FailedProps {
  error: AppErrorData
  sessionId: string
  onRetry: () => void
  goTo: (step: StepNumber) => void
}

function Failed({ error, sessionId, onRetry, goTo }: FailedProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const openLog = useIpcMutation('app:openPath', {
    onError: (failure) => {
      const { title, body } = describeError(failure, t)
      toast.push({ tone: 'error', title, body })
    },
  })
  const described = describeError(error, t)
  // A local server of the session runs: it is stopped from the live game screen, not fixed at a step;
  // a game in progress is replaced through the confirmation of Retry.
  const serving = error.code === 'GENERATION_PREFLIGHT' && error.params?.reason === 'hosting'
  const inProgress = error.code === 'GENERATION_PREFLIGHT' && error.params?.reason === 'game-in-progress'
  const backTo = serving || inProgress ? undefined : STEP_FOR_ERROR[error.code]
  const { action, logPath } = described
  return (
    <ErrorPanel
      headingLevel={2}
      title={described.title}
      body={described.body}
      detail={described.detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        <>
          <NeonButton icon={<IconRefresh />} onClick={onRetry}>
            {t('screens.session.generate.retry')}
          </NeonButton>
          {backTo !== undefined && (
            <NeonButton variant="secondary" icon={<IconSearch />} onClick={() => goTo(backTo)}>
              {backTo === 2
                ? t('screens.session.generate.backToCheck')
                : t('screens.session.generate.backToRules')}
            </NeonButton>
          )}
          {serving && (
            <NeonButton
              variant="secondary"
              icon={<IconBroadcast />}
              onClick={() => void navigate(`/play/${sessionId}`)}
            >
              {t('screens.session.generate.toLive')}
            </NeonButton>
          )}
          {action?.to !== undefined && (
            <NeonButton variant="secondary" onClick={() => void navigate(action.to ?? '/')}>
              {t(action.labelKey)}
            </NeonButton>
          )}
          {logPath !== undefined && (
            <NeonButton
              variant="ghost"
              icon={<IconFileText />}
              onClick={() => openLog.mutate({ path: logPath })}
            >
              {t('common.openLog')}
            </NeonButton>
          )}
        </>
      }
    />
  )
}

function Done({
  generation,
  onRegenerate,
}: {
  generation: Generation
  onRegenerate: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="gen-clear pixel-border tone-green">
      <div className="gen-clear__head">
        <div>
          <span className="gen-clear__eyebrow t-display" aria-hidden="true">
            {t('screens.session.generate.successEyebrow')}
          </span>
          <h2 className="gen-clear__title">{t('screens.session.generate.success')}</h2>
          <p className="gen-clear__body">{t('screens.session.generate.successBody')}</p>
        </div>
        <NeonButton variant="ghost" size="sm" icon={<IconRefresh />} onClick={onRegenerate}>
          {t('screens.session.generate.regenerate')}
        </NeonButton>
      </div>
      <dl className="gen-clear__facts">
        <div>
          <dt>{t('screens.session.generate.seed')}</dt>
          <dd>{generation.seedName}</dd>
        </div>
        <div>
          <dt>{t('screens.session.generate.duration')}</dt>
          <dd>{clock(generation.durationS)}</dd>
        </div>
        <div>
          <dt>{t('screens.session.players.title')}</dt>
          <dd>{generation.slots.length}</dd>
        </div>
      </dl>
      <div className="gen-slots">
        <table aria-label={t('screens.session.generate.slotsLabel')}>
          <thead>
            <tr>
              <th scope="col">{t('screens.session.generate.slot')}</th>
              <th scope="col">{t('screens.session.generate.player')}</th>
              <th scope="col">{t('screens.session.generate.game')}</th>
              <th scope="col">{t('screens.session.generate.patch')}</th>
            </tr>
          </thead>
          <tbody>
            {generation.slots.map((slot) => (
              <tr key={slot.slot}>
                <td className="gen-slots__num">{t('screens.session.players.slot', { n: slot.slot })}</td>
                <td className="gen-slots__name">{slot.name}</td>
                <td>{slot.game}</td>
                <td
                  className="gen-slots__patch"
                  data-none={slot.patchFile === null || undefined}
                  title={slot.patchFile ?? undefined}
                >
                  {slot.patchFile ? fileName(slot.patchFile) : t('screens.session.generate.noPatch')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
