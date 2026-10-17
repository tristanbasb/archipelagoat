// Step 5: where the server runs. archipelago.gg (recommended to play over the Internet) only after the
// consent dialog, or a local server; both lead to the live game screen. A game that already has its
// archipelago.gg room wakes that room up (a new room only on request, /new_room is not idempotent),
// and starting the local server over that room asks first: the app would forget it.
import {
  IconBell,
  IconBroadcast,
  IconChevronRight,
  IconCloudUpload,
  IconPlayerPlay,
  IconRouter,
  IconServer2,
  IconSparkles,
  IconTerminal2,
  IconWifi,
  IconWorld,
  IconZzz,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { Session } from '@shared/types'
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  ProgressBar,
  type Tone,
} from '../../design/components'
import { cx, toneClass } from '../../design/classes'
import { useIpcMutation } from '../../hooks/useIpc'
import { useTask } from '../../hooks/useTask'
import { describeError } from '../../lib/errors'
import { StepNav } from './StepNav'
import { WebConsentDialog } from './WebConsentDialog'
import './StepHost.css'

/** The steps of an archipelago.gg hosting (Task 17): upload the zip, open the room, wake it, read its port. */
const WEB_STAGES = ['upload', 'room', 'wake', 'port'] as const

function webStage(stage: string | undefined): (typeof WEB_STAGES)[number] {
  return WEB_STAGES.find((known) => known === stage) ?? 'upload'
}

export interface StepHostProps {
  session: Session
  /** The archipelago.gg hosting task, kept by the wizard. */
  taskId: string | null
  onTaskId: (taskId: string | null) => void
  onBack: () => void
}

export function StepHost({ session, taskId, onTaskId, onBack }: StepHostProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [consentOpen, setConsentOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  /** The consent asks for a new room, beside the one the session has. */
  const [newRoom, setNewRoom] = useState(false)
  const [confirmLocal, setConfirmLocal] = useState(false)
  /** Set from the consent until its hosting is answered: a second confirm sends nothing. */
  const submitting = useRef(false)
  const task = useTask(taskId)
  const live = `/play/${session.id}`
  const room = session.hosting?.mode === 'web' ? session.hosting : null

  const web = useIpcMutation('webhost:host', {
    onSuccess: ({ taskId: id }) => onTaskId(id),
    onSettled: () => {
      submitting.current = false
    },
  })
  const wake = useIpcMutation('webhost:wake', {
    invalidates: ['session:get', 'session:list'],
    onSuccess: () => void navigate(live),
  })
  const local = useIpcMutation('server:start', {
    invalidates: ['session:get', 'session:list'],
    onSuccess: (state) => {
      if (state.error === null) void navigate(live)
    },
  })

  // The room is up: on to the live game. The task is then forgotten, so coming back to this step
  // later does not bounce there again. A failed hosting may still have opened its room, which the
  // session now holds: this step then offers to wake it rather than open another.
  useEffect(() => {
    if (task.status !== 'done' && task.status !== 'failed') return
    for (const channel of ['session:get', 'session:list']) {
      void queryClient.invalidateQueries({ queryKey: [channel] })
    }
    if (task.status !== 'done') return
    onTaskId(null)
    void navigate(live)
  }, [task.status, live, navigate, queryClient, onTaskId])

  const webBusy = web.isPending || wake.isPending || (taskId !== null && task.status === 'running')
  const webError =
    wake.error ?? web.error ?? (taskId !== null && task.status === 'failed' ? task.error : null)
  const localError = local.error ?? local.data?.error ?? null
  const busy = webBusy || local.isPending

  const askConsent = (asNewRoom: boolean): void => {
    setAcknowledged(false)
    setNewRoom(asNewRoom)
    setConsentOpen(true)
  }
  const hostOnWeb = (): void => {
    setConsentOpen(false)
    if (submitting.current || webBusy) return
    submitting.current = true
    onTaskId(null)
    web.reset()
    wake.reset()
    web.mutate(
      newRoom
        ? { sessionId: session.id, consent: true, newRoom: true }
        : { sessionId: session.id, consent: true },
    )
  }
  const startLocal = (replaceWeb: boolean): void =>
    local.mutate(replaceWeb ? { sessionId: session.id, replaceWeb: true } : { sessionId: session.id })

  if (!session.generation) {
    return (
      <>
        <PixelPanel as="div" tone="violet" padding="lg">
          <EmptyState
            icon={<IconSparkles />}
            title={t('screens.session.host.noGenerationTitle')}
            body={t('screens.session.host.noGenerationBody')}
            headingLevel={2}
            action={
              <NeonButton variant="secondary" onClick={onBack}>
                {t('screens.session.host.toGenerate')}
              </NeonButton>
            }
          />
        </PixelPanel>
        <StepNav onBack={onBack} />
      </>
    )
  }

  return (
    <>
      <div className="host-step">
        {session.hosting && session.status === 'hosting' && (
          <div className="host-live pixel-border tone-green" role="status">
            <IconBroadcast className="host-live__icon" aria-hidden="true" />
            <div className="host-live__text">
              <p className="host-live__title">{t('screens.session.host.liveTitle')}</p>
              <p className="host-live__body">
                {session.hosting.mode === 'web'
                  ? t('screens.session.host.liveWeb')
                  : t('screens.session.host.liveLocal')}
              </p>
            </div>
            <NeonButton variant="secondary" size="sm" onClick={() => void navigate(live)}>
              {t('screens.session.host.openLive')}
              <IconChevronRight aria-hidden="true" />
            </NeonButton>
          </div>
        )}

        <div className="host-cards" role="list" aria-label={t('screens.session.host.chooseLabel')}>
          <HostCard
            tone="violet"
            featured
            icon={<IconWorld />}
            eyebrow={t('screens.session.host.web.eyebrow')}
            title={t('screens.session.host.web.title')}
            badge={<Badge tone="yellow">{t('screens.session.host.recommended')}</Badge>}
            body={t('screens.session.host.web.body')}
            points={[
              { icon: <IconRouter />, text: t('screens.session.host.web.pointSetup') },
              { icon: <IconWifi />, text: t('screens.session.host.web.pointConnect') },
              { icon: <IconZzz />, text: t('screens.session.host.web.pointSleep') },
            ]}
          >
            {webBusy ? (
              <ProgressBar
                percent={wake.isPending ? null : (task.progress?.percent ?? null)}
                label={
                  wake.isPending
                    ? t('screens.session.host.web.waking')
                    : t(`screens.session.host.web.stages.${webStage(task.progress?.stage)}`)
                }
                segments={16}
                tone="violet"
              />
            ) : room ? (
              <>
                <p className="host-card__note">{t('screens.session.host.web.hasRoom')}</p>
                <NeonButton
                  size="lg"
                  icon={<IconBell />}
                  disabled={busy}
                  onClick={() => {
                    web.reset()
                    wake.mutate({ roomId: room.roomId })
                  }}
                >
                  {t('screens.session.host.web.wake')}
                </NeonButton>
                <NeonButton variant="ghost" size="sm" disabled={busy} onClick={() => askConsent(true)}>
                  {t('screens.session.host.web.newRoom')}
                </NeonButton>
              </>
            ) : (
              <NeonButton
                size="lg"
                icon={<IconCloudUpload />}
                disabled={busy}
                onClick={() => askConsent(false)}
              >
                {t('screens.session.host.web.action')}
              </NeonButton>
            )}
            {webError && !webBusy && <HostError error={webError} />}
          </HostCard>

          <HostCard
            tone="cyan"
            icon={<IconServer2 />}
            eyebrow={t('screens.session.host.local.eyebrow')}
            title={t('screens.session.host.local.title')}
            badge={
              <Badge tone="cyan" outline>
                {t('screens.session.host.local.badge')}
              </Badge>
            }
            body={t('screens.session.host.local.body')}
            points={[
              { icon: <IconWifi />, text: t('screens.session.host.local.pointLan') },
              { icon: <IconRouter />, text: t('screens.session.host.local.pointPort') },
              { icon: <IconTerminal2 />, text: t('screens.session.host.local.pointConsole') },
            ]}
          >
            <NeonButton
              variant="secondary"
              size="lg"
              icon={<IconPlayerPlay />}
              disabled={busy && !local.isPending}
              loading={local.isPending}
              loadingLabel={t('screens.session.host.local.starting')}
              onClick={() => (room ? setConfirmLocal(true) : startLocal(false))}
            >
              {t('screens.session.host.local.action')}
            </NeonButton>
            {localError && !local.isPending && <HostError error={localError} />}
          </HostCard>
        </div>
      </div>
      <WebConsentDialog
        open={consentOpen}
        hasPassword={session.hasPassword || session.hasServerPassword}
        newRoom={newRoom}
        acknowledged={acknowledged}
        onAcknowledge={setAcknowledged}
        onConfirm={hostOnWeb}
        onCancel={() => setConsentOpen(false)}
      />
      <ConfirmDialog
        open={confirmLocal}
        tone="cyan"
        eyebrow={t('screens.session.host.replaceWeb.eyebrow')}
        title={t('screens.session.host.replaceWeb.title')}
        confirmLabel={t('screens.session.host.replaceWeb.confirm')}
        confirmIcon={<IconPlayerPlay />}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.closeDialog')}
        onCancel={() => setConfirmLocal(false)}
        onConfirm={() => {
          setConfirmLocal(false)
          startLocal(true)
        }}
      >
        <p>{t('screens.session.host.replaceWeb.body')}</p>
        {room && (
          <>
            <p className="confirm-dialog__note">{t('screens.session.host.replaceWeb.keep')}</p>
            <p className="confirm-dialog__link">{room.roomUrl}</p>
          </>
        )}
      </ConfirmDialog>
      <StepNav onBack={onBack} />
    </>
  )
}

interface HostCardProps {
  tone: Tone
  featured?: boolean
  icon: ReactNode
  eyebrow: string
  title: string
  badge: ReactNode
  body: string
  points: { icon: ReactNode; text: string }[]
  children: ReactNode
}

function HostCard({
  tone,
  featured = false,
  icon,
  eyebrow,
  title,
  badge,
  body,
  points,
  children,
}: HostCardProps): React.JSX.Element {
  const titleId = useId()
  return (
    <article
      role="listitem"
      aria-labelledby={titleId}
      className={cx('host-card pixel-border', toneClass(tone), featured && 'host-card--featured')}
    >
      <div className="host-card__top">
        <span className="host-card__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="host-card__heading">
          <span className="host-card__eyebrow t-display" aria-hidden="true">
            {eyebrow}
          </span>
          <h2 id={titleId} className="host-card__title">
            {title}
          </h2>
        </div>
      </div>
      <div className="host-card__badge">{badge}</div>
      <p className="host-card__body">{body}</p>
      <ul className="host-card__points">
        {points.map((point) => (
          <li key={point.text}>
            <span className="host-card__point-icon" aria-hidden="true">
              {point.icon}
            </span>
            <span>{point.text}</span>
          </li>
        ))}
      </ul>
      <div className="host-card__action">{children}</div>
    </article>
  )
}

function HostError({ error }: { error: unknown }): React.JSX.Element {
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
        action?.to !== undefined ? (
          <NeonButton variant="secondary" size="sm" onClick={() => void navigate(action.to ?? '/')}>
            {t(action.labelKey)}
          </NeonButton>
        ) : undefined
      }
    />
  )
}
