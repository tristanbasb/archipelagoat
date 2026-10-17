// Rejoindre (spec §4.2.7): a room link, an archipelago:// address or a patch file, then the slot,
// the readiness checklist and JOUER. `?input=` (set by useOpenRequests for the links and patch
// files the system hands the app) starts the same flow on arrival.
import { IconAlertTriangle, IconArrowBackUp, IconRefresh } from '@tabler/icons-react'
import { useEffect, useEffectEvent, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import type { AppErrorData } from '@shared/errors'
import type { JoinPlan } from '@shared/types'
import {
  ErrorPanel,
  NeonButton,
  PixelPanel,
  ProgressBar,
  Stepper,
  type StepperStep,
} from '../../design/components'
import { cx, toneClass } from '../../design/classes'
import { fileName } from '../../hooks/useOpenRequests'
import { useTask } from '../../hooks/useTask'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { describeError } from '../../lib/errors'
import { JoinEntry, TargetIcon } from './JoinEntry'
import { ConnectionPanel, GuidePanel, StartPanel, connectAddress } from './PlayPanels'
import { ReadinessChecklist } from './ReadinessChecklist'
import { SlotPicker } from './SlotPicker'
import { STEP_FOCUS, STEP_FOCUS_PANEL, useStepFocus } from './step-focus'
import { targetLabel, useRoomHistory, withoutPassword } from './room-history'
import { useJoinFlow, type Job } from './use-join-flow'
import './JoinScreen.css'

type View = 'entry' | 'preparing' | 'failed' | 'slots' | 'plan'
type StepId = 'link' | 'slot' | 'check' | 'play'

export function JoinScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const history = useRoomHistory()
  const flow = useJoinFlow(history)
  const { job, stage, roomPlan, plan } = flow
  const preparing = useTask(stage.kind === 'preparing' ? stage.taskId : null)

  // A link or a patch handed over by the system: every navigation to ?input= starts the flow
  // once (a second open of the same link is a new navigation, with a new key).
  const incoming = new URLSearchParams(location.search).get('input')
  const consumed = useRef<string | null>(null)
  const startIncoming = useEffectEvent((value: string) => void flow.start(value))
  useEffect(() => {
    if (incoming === null || consumed.current === location.key) return
    consumed.current = location.key
    startIncoming(incoming)
  }, [incoming, location.key])

  const reset = (): void => {
    flow.reset()
    if (incoming !== null) void navigate({ search: '' }, { replace: true })
  }

  const view: View = !job
    ? 'entry'
    : stage.kind === 'failed'
      ? 'failed'
      : plan
        ? 'plan'
        : roomPlan
          ? 'slots'
          : 'preparing'
  const root = useRef<HTMLDivElement>(null)
  useStepFocus(root, view)

  const isRoom = job === null || job.target.kind === 'room'
  const steps: StepperStep[] = (['link', 'slot', 'check', 'play'] as const)
    .filter((id) => id !== 'slot' || isRoom)
    .map((id) => ({ id, label: t(`screens.join.progress.${id}`) }))
  const currentStep: StepId =
    view === 'plan' && plan ? (plan.ready ? 'play' : 'check') : roomPlan ? 'slot' : 'link'

  const lastSlot = job
    ? (history.entries.find(
        (entry) => entry.kind === job.target.kind && entry.label === targetLabel(job.target),
      )?.slot ?? null)
    : null

  return (
    <div className="join-screen" ref={root}>
      <ScreenHeader
        eyebrow={t('screens.join.eyebrow')}
        title={t('nav.join')}
        subtitle={t('screens.join.subtitle')}
        actions={
          <Stepper
            className="join-screen__stepper"
            steps={steps}
            current={currentStep}
            label={t('screens.join.progress.label')}
          />
        }
      />

      {!job ? (
        <JoinEntry
          input={flow.input}
          onInput={flow.setInput}
          resolving={flow.resolving}
          error={flow.entryError}
          onStart={(input) => void flow.start(input)}
          history={history}
        />
      ) : (
        <div className="join-screen__stack">
          <TargetBar
            job={job}
            plan={plan}
            onChangeSlot={roomPlan && plan ? flow.changeSlot : undefined}
            onReset={reset}
          />
          {view === 'preparing' && (
            <PixelPanel
              {...STEP_FOCUS_PANEL}
              className="join-preparing"
              tone="violet"
              glow
              eyebrow={t('screens.join.preparing.eyebrow')}
              title={t('screens.join.preparing.title')}
              actions={
                <NeonButton variant="ghost" size="sm" onClick={reset}>
                  {t('common.cancel')}
                </NeonButton>
              }
            >
              <ProgressBar
                percent={preparing.progress?.percent ?? null}
                label={t('tasks.kinds.join-prepare')}
                tone="violet"
              />
              <p className="join-preparing__body">{t('screens.join.preparing.body')}</p>
            </PixelPanel>
          )}
          {stage.kind === 'failed' && <FailedPanel error={stage.error} onRetry={flow.retry} />}
          {(view === 'slots' || view === 'failed') && roomPlan && (
            <SlotPicker
              slots={roomPlan.slots}
              pending={stage.kind === 'preparing' ? stage.slotName : null}
              lastSlot={lastSlot}
              onPick={flow.chooseSlot}
            />
          )}
          {view === 'plan' && plan && <PlanView plan={plan} onRefresh={flow.recheck} />}
        </div>
      )}
    </div>
  )
}

/** What is being joined, with the way back. */
function TargetBar({
  job,
  plan,
  onChangeSlot,
  onReset,
}: {
  job: Job
  plan: JoinPlan | null
  onChangeSlot?: () => void
  onReset: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { target } = job
  const value =
    target.kind === 'room'
      ? withoutPassword(job.source).replace(/^https?:\/\//i, '')
      : target.kind === 'address'
        ? `${target.host}:${target.port}`
        : fileName(target.path)
  const slot = plan?.slot ?? null

  return (
    <div className="join-target pixel-border tone-cyan">
      <span className="join-target__icon" aria-hidden="true">
        <TargetIcon kind={target.kind} />
      </span>
      <div className="join-target__text">
        <span className="join-target__kind">{t(`screens.join.target.${target.kind}`)}</span>
        <span className="join-target__value" title={target.kind === 'patch' ? target.path : value}>
          {value}
        </span>
      </div>
      {slot && (
        <div className="join-target__slot">
          <span className="join-target__slot-name">{slot.name}</span>
          <span className="join-target__slot-game">{slot.game}</span>
        </div>
      )}
      <div className="join-target__actions">
        {onChangeSlot && (
          <NeonButton variant="ghost" size="sm" onClick={onChangeSlot}>
            {t('screens.join.target.changeSlot')}
          </NeonButton>
        )}
        <NeonButton variant="secondary" size="sm" icon={<IconArrowBackUp />} onClick={onReset}>
          {t('screens.join.target.change')}
        </NeonButton>
      </div>
    </div>
  )
}

/** The preparation failed: why, how to fix it, and a retry. */
function FailedPanel({ error, onRetry }: { error: AppErrorData; onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { title, body, detail, action } = describeError(error, t)
  return (
    <ErrorPanel
      title={title}
      body={body}
      detail={detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        <>
          <NeonButton {...STEP_FOCUS} variant="secondary" size="sm" icon={<IconRefresh />} onClick={onRetry}>
            {t('common.retry')}
          </NeonButton>
          {action?.to && (
            <NeonButton variant="ghost" size="sm" onClick={() => void navigate(action.to ?? '/')}>
              {t(action.labelKey)}
            </NeonButton>
          )}
        </>
      }
    />
  )
}

/** The plan of the slot: warnings, checklist and steps, beside JOUER and the connection details. */
function PlanView({
  plan,
  onRefresh,
}: {
  plan: JoinPlan
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  // A PC game has no client to start: its connection details and its steps take the lead.
  const launchable = plan.route.client !== 'none'
  const guide = plan.route.tier !== 'full' && <GuidePanel plan={plan} />
  const guideFirst = plan.route.tier === 'guided'
  return (
    <div className="join-plan">
      {plan.warnings.length > 0 && (
        <section
          {...STEP_FOCUS_PANEL}
          className="join-warnings pixel-border tone-yellow"
          aria-label={t('screens.join.warnings.label')}
        >
          <ul>
            {plan.warnings.map((issue, index) => (
              <li
                key={`${issue.code}-${index}`}
                className={cx(
                  'join-warnings__item',
                  toneClass(issue.severity === 'error' ? 'pink' : 'yellow'),
                )}
              >
                <IconAlertTriangle className="join-warnings__icon" aria-hidden="true" />
                <div>
                  <p>{t(`issues.${issue.code}`, issue.params)}</p>
                  {issue.code === 'patch-server-stale' && (
                    <p className="join-warnings__fix">
                      {t('screens.join.warnings.useAddress')} <code>{connectAddress(plan)}</code>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="join-plan__grid">
        <div className="join-plan__main">
          {guideFirst && guide}
          <ReadinessChecklist plan={plan} onRefresh={onRefresh} />
          {!guideFirst && guide}
        </div>
        <div className="join-plan__side">
          {launchable && <StartPanel plan={plan} />}
          <ConnectionPanel plan={plan} featured={!launchable} />
        </div>
      </div>
    </div>
  )
}
