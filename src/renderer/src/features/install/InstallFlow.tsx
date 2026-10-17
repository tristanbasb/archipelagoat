// An install or uninstall under way, then how it ended: staged progress, success or a translated
// error with Retry.
import {
  IconCircleCheck,
  IconDeviceGamepad2,
  IconDownload,
  IconShieldLock,
  IconTrash,
  IconTrophy,
} from '@tabler/icons-react'
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { AppErrorData } from '@shared/errors'
import type { ChannelInput } from '@shared/ipc/contract'
import type { ApInstall, OS, TaskLog } from '@shared/types'
import { cx, toneClass, type Tone } from '../../design/classes'
import { NeonButton, ProgressBar, Stepper, Terminal, type TerminalLine } from '../../design/components'
import type { TaskState } from '../../hooks/useTask'
import { INSTALL_STAGES, isInstallStage } from './install-model'
import { InstallError } from './InstallError'

export type InstallInput = ChannelInput<'ap:install'>

interface FlowBase {
  /** Identifies one attempt: a late answer to an earlier attempt is ignored. */
  token: object
  taskId: string | null
  /** The call itself failed, so no task started. */
  startError: AppErrorData | null
}

export type Flow =
  | (FlowBase & {
      kind: 'install'
      /** What was asked, for Retry; null for an install picked up already running. */
      input: InstallInput | null
      /** The version being installed, when known. */
      target: string | null
      update: boolean
    })
  | (FlowBase & {
      kind: 'uninstall'
      /** Null for an uninstall picked up already running. */
      purge: boolean | null
    })

export type FlowStatus = 'running' | 'done' | 'failed'

export function flowStatus(flow: Flow, task: TaskState): FlowStatus {
  if (flow.startError) return 'failed'
  return task.status === 'idle' ? 'running' : task.status
}

export interface InstallFlowProps {
  flow: Flow
  task: TaskState
  os: OS | null
  onRetry: () => void
  onDismiss: () => void
}

export function InstallFlow({ flow, task, os, onRetry, onDismiss }: InstallFlowProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const status = flowStatus(flow, task)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Each new attempt and each outcome takes the focus, so the keyboard and screen readers follow.
  useEffect(() => {
    headingRef.current?.focus()
  }, [flow.token, status])

  const error = flow.startError ?? task.error
  if (status === 'failed' && error) {
    return (
      <FlowFrame
        tone="pink"
        eyebrow={t('screens.install.flow.failed.eyebrow')}
        title={
          flow.kind === 'install'
            ? t('screens.install.flow.failed.install')
            : t('screens.install.flow.failed.uninstall')
        }
        headingRef={headingRef}
      >
        <InstallError error={error} onRetry={onRetry}>
          <NeonButton size="sm" variant="ghost" onClick={onDismiss}>
            {t('screens.install.flow.failed.back')}
          </NeonButton>
        </InstallError>
      </FlowFrame>
    )
  }

  if (status === 'done' && flow.kind === 'install') {
    const result = asInstall(task.result)
    return (
      <FlowFrame
        tone="green"
        glyph={<IconTrophy />}
        eyebrow={t('screens.install.flow.done.eyebrow')}
        title={
          result?.version
            ? t('screens.install.flow.done.title', { version: result.version })
            : t('screens.install.flow.done.titleAny')
        }
        headingRef={headingRef}
        celebrate
      >
        <p className="install-flow__body">{t('screens.install.flow.done.body')}</p>
        {result && (
          <dl className="install-flow__facts">
            <dt>{t('screens.install.flow.done.folder')}</dt>
            <dd>{result.root}</dd>
          </dl>
        )}
        <div className="install-flow__actions">
          <NeonButton icon={<IconCircleCheck />} onClick={onDismiss}>
            {t('screens.install.flow.done.continue')}
          </NeonButton>
          <NeonButton
            variant="secondary"
            icon={<IconDeviceGamepad2 />}
            onClick={() => void navigate('/session/new')}
          >
            {t('screens.install.flow.done.play')}
          </NeonButton>
        </div>
      </FlowFrame>
    )
  }

  if (status === 'done' && flow.kind === 'uninstall') {
    const body =
      flow.purge === null
        ? t('screens.install.flow.removed.generic')
        : flow.purge
          ? t('screens.install.flow.removed.purged')
          : t('screens.install.flow.removed.kept')
    return (
      <FlowFrame
        tone="neutral"
        glyph={<IconTrash />}
        eyebrow={t('screens.install.flow.removed.eyebrow')}
        title={t('screens.install.flow.removed.title')}
        headingRef={headingRef}
      >
        <p className="install-flow__body">{body}</p>
        <div className="install-flow__actions">
          <NeonButton icon={<IconCircleCheck />} onClick={onDismiss}>
            {t('screens.install.flow.done.continue')}
          </NeonButton>
        </div>
      </FlowFrame>
    )
  }

  return flow.kind === 'install' ? (
    <InstallProgress flow={flow} task={task} os={os} headingRef={headingRef} />
  ) : (
    <FlowFrame
      tone="pink"
      glyph={<IconTrash />}
      eyebrow={t('screens.install.flow.uninstall.eyebrow')}
      title={t('screens.install.flow.uninstall.title')}
      headingRef={headingRef}
    >
      <ProgressBar
        percent={task.progress?.percent ?? null}
        label={t('screens.install.flow.uninstall.progress')}
        tone="pink"
        segments={24}
      />
      {os === 'win32' && (
        <p className="install-note tone-yellow">
          <IconShieldLock aria-hidden="true" />
          <span>{t('screens.install.flow.uninstall.uac')}</span>
        </p>
      )}
      <TaskLogs logs={task.logs} />
    </FlowFrame>
  )
}

interface InstallProgressProps {
  flow: Extract<Flow, { kind: 'install' }>
  task: TaskState
  os: OS | null
  headingRef: RefObject<HTMLHeadingElement | null>
}

function InstallProgress({ flow, task, os, headingRef }: InstallProgressProps): React.JSX.Element {
  const { t } = useTranslation()
  const stage = task.progress?.stage
  const current = isInstallStage(stage) ? stage : 'download'
  const title =
    flow.update && flow.target
      ? t('screens.install.flow.install.update', { version: flow.target })
      : flow.target
        ? t('screens.install.flow.install.title', { version: flow.target })
        : t('screens.install.flow.install.titleAny')
  const asksConsent = current === 'install' && os === 'win32'
  const hint = !task.progress
    ? t('screens.install.flow.hints.starting')
    : !isInstallStage(stage)
      ? t('screens.install.flow.hints.other')
      : stage === 'install'
        ? os === 'win32'
          ? t('screens.install.flow.hints.installWin')
          : t('screens.install.flow.hints.installLinux')
        : t(`screens.install.flow.hints.${stage}`)

  return (
    <FlowFrame
      tone="violet"
      glyph={<IconDownload />}
      eyebrow={t('screens.install.flow.install.eyebrow')}
      title={title}
      headingRef={headingRef}
      busy
    >
      <Stepper
        className="install-flow__steps"
        label={t('screens.install.flow.stepsLabel')}
        current={current}
        steps={INSTALL_STAGES.map((id) => ({ id, label: t(`screens.install.flow.stages.${id}`) }))}
      />
      <ProgressBar
        percent={task.progress?.percent ?? null}
        label={t(`screens.install.flow.stages.${current}`)}
        tone={asksConsent ? 'yellow' : 'violet'}
        segments={24}
      />
      <p className={cx('install-flow__hint', asksConsent && 'install-note tone-yellow')} aria-live="polite">
        {asksConsent && <IconShieldLock aria-hidden="true" />}
        <span>{hint}</span>
      </p>
      <TaskLogs logs={task.logs} />
    </FlowFrame>
  )
}

const LOG_TONE: Record<TaskLog['stream'], TerminalLine['tone']> = {
  stdout: 'default',
  stderr: 'warn',
  app: 'info',
}

function TaskLogs({ logs }: { logs: TaskLog[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (logs.length === 0) return null
  return (
    <details className="install-log">
      <summary>
        {t('screens.install.flow.log')} <span className="install-log__count">{logs.length}</span>
      </summary>
      <Terminal
        label={t('screens.install.flow.log')}
        lines={logs.map((log) => ({ text: log.line, tone: LOG_TONE[log.stream] }))}
      />
    </details>
  )
}

interface FlowFrameProps {
  tone: Tone
  eyebrow: string
  title: string
  headingRef: RefObject<HTMLHeadingElement | null>
  glyph?: ReactNode
  /** Animates the glyph while work is under way. */
  busy?: boolean
  /** A short burst of pixels around the glyph. */
  celebrate?: boolean
  children: ReactNode
}

function FlowFrame({
  tone,
  eyebrow,
  title,
  headingRef,
  glyph,
  busy = false,
  celebrate = false,
  children,
}: FlowFrameProps): React.JSX.Element {
  const titleId = useId()
  return (
    <section
      className={cx('install-flow pixel-border', toneClass(tone), busy && 'install-flow--busy')}
      aria-labelledby={titleId}
    >
      {glyph !== undefined && (
        <div
          className={cx('install-flow__glyph', celebrate && 'install-flow__glyph--celebrate')}
          aria-hidden="true"
        >
          {glyph}
        </div>
      )}
      <div className="install-flow__main">
        <span className="install-flow__eyebrow t-display">{eyebrow}</span>
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="install-flow__title">
          {title}
        </h2>
        {children}
      </div>
    </section>
  )
}

function asInstall(result: unknown): ApInstall | null {
  if (typeof result !== 'object' || result === null) return null
  const { root } = result as Partial<ApInstall>
  return typeof root === 'string' ? (result as ApInstall) : null
}
