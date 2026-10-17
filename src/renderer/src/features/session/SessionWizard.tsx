// The organizer's wizard (spec §4.2.5). /session/new names and creates a game; /session/:id?step=1..5
// then walks it through players, check, rules, generation and hosting.
import { IconGhost2, IconPlus } from '@tabler/icons-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { SessionStatus } from '@shared/types'
import {
  EmptyState,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  Spinner,
  StatusPill,
  Stepper,
} from '../../design/components'
import { useIpcQuery } from '../../hooks/useIpc'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { describeError } from '../../lib/errors'
import { NewSession } from './NewSession'
import { StepCheck } from './StepCheck'
import { StepGenerate } from './StepGenerate'
import { StepHost } from './StepHost'
import { StepPlayers } from './StepPlayers'
import { StepRules } from './StepRules'
import { STATUS_PILL, STEP_IDS, type StepNumber } from './steps'
import { useWizardRuns } from './wizard-runs'
import './SessionWizard.css'

function parseStep(value: string | null): StepNumber | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? (n as StepNumber) : null
}

/** Without ?step, a draft starts with its players and a generated game with its hosting. */
function defaultStep(status: SessionStatus): StepNumber {
  return status === 'draft' ? 1 : 5
}

export function SessionWizard(): React.JSX.Element {
  const { id } = useParams()
  return id ? <Wizard key={id} id={id} /> : <NewSession />
}

function Wizard({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const query = useIpcQuery('session:get', { id })
  // Tasks outlive the step, and the screen, that started them: coming back keeps following them.
  const { generation, setGeneration, hostTaskId, setHostTaskId } = useWizardRuns(id)
  const stepRef = useRef<HTMLDivElement>(null)
  const shownStep = useRef<StepNumber | null>(null)

  const session = query.data
  const step = session ? (parseStep(params.get('step')) ?? defaultStep(session.status)) : null

  // A new step takes the focus, so keyboard and screen reader users start reading at its top.
  useEffect(() => {
    if (step === null) return
    if (shownStep.current !== null && shownStep.current !== step) stepRef.current?.focus()
    shownStep.current = step
  }, [step])

  if (!session || step === null) {
    return (
      <WizardFrame title={t('nav.session')} subtitle={t('nav.hints.session')}>
        {query.isError && <LoadError error={query.error} onRetry={() => void query.refetch()} />}
        {query.isPending && (
          <div className="wizard__loading">
            <Spinner label={t('screens.session.load.loading')} />
          </div>
        )}
      </WizardFrame>
    )
  }

  const stepId = STEP_IDS[step - 1] ?? 'players'
  const goTo = (n: StepNumber): void => setParams({ step: String(n) })

  return (
    <WizardFrame
      eyebrow={t('screens.session.eyebrow', { n: String(step).padStart(2, '0') })}
      title={session.name}
      subtitle={t(`screens.session.hints.${stepId}`)}
      actions={
        <StatusPill
          status={STATUS_PILL[session.status]}
          label={t(`screens.session.status.${session.status}`)}
        />
      }
    >
      <Stepper
        className="wizard__stepper"
        label={t('screens.session.stepsLabel')}
        current={stepId}
        steps={STEP_IDS.map((sid) => ({ id: sid, label: t(`screens.session.steps.${sid}`) }))}
      />
      <div
        ref={stepRef}
        key={stepId}
        className="wizard__step"
        tabIndex={-1}
        role="group"
        aria-label={t(`screens.session.steps.${stepId}`)}
      >
        {step === 1 && <StepPlayers session={session} onNext={() => goTo(2)} />}
        {step === 2 && <StepCheck session={session} onBack={() => goTo(1)} onNext={() => goTo(3)} />}
        {step === 3 && <StepRules session={session} onBack={() => goTo(2)} onNext={() => goTo(4)} />}
        {step === 4 && <StepGenerate session={session} run={generation} onRun={setGeneration} goTo={goTo} />}
        {step === 5 && (
          <StepHost session={session} taskId={hostTaskId} onTaskId={setHostTaskId} onBack={() => goTo(4)} />
        )}
      </div>
    </WizardFrame>
  )
}

interface WizardFrameProps {
  title: string
  eyebrow?: string
  subtitle?: string
  actions?: ReactNode
  children?: ReactNode
}

function WizardFrame({ title, eyebrow, subtitle, actions, children }: WizardFrameProps): React.JSX.Element {
  return (
    <div className="wizard">
      <ScreenHeader eyebrow={eyebrow} title={title} subtitle={subtitle} actions={actions} />
      {children}
    </div>
  )
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  if ((error as { code?: unknown }).code === 'NOT_FOUND') {
    return (
      <PixelPanel as="div" tone="violet" padding="lg">
        <EmptyState
          icon={<IconGhost2 />}
          title={t('screens.session.load.notFoundTitle')}
          body={t('screens.session.load.notFoundBody')}
          headingLevel={2}
          action={
            <NeonButton icon={<IconPlus />} onClick={() => void navigate('/session/new')}>
              {t('screens.session.load.newGame')}
            </NeonButton>
          }
        />
      </PixelPanel>
    )
  }
  const described = describeError(error, t)
  return (
    <ErrorPanel
      headingLevel={2}
      title={described.title}
      body={described.body}
      detail={described.detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        <NeonButton variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </NeonButton>
      }
    />
  )
}
