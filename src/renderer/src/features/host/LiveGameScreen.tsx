// The live game (spec §4.2.6): a local server (state, addresses, players, item feed, console, stop)
// or an archipelago.gg room (address, room link, wake, remote console, log, owner access), plus the
// players' files in both cases.
import {
  IconAlertTriangle,
  IconDeviceFloppy,
  IconExternalLink,
  IconHistory,
  IconPlayerPlay,
  IconPlayerStopFilled,
  IconServerOff,
  IconSunrise,
  IconWand,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import type { Hosting, ServerState, Session, WebRoom } from '@shared/types'
import type { Tone } from '../../design/classes'
import {
  EmptyState,
  ErrorPanel,
  Modal,
  NeonButton,
  PixelPanel,
  Spinner,
  StatusPill,
  useToast,
  type Status,
} from '../../design/components'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { ConnectionCard } from './ConnectionCard'
import { ConsolePanel } from './ConsolePanel'
import { EventFeed, ItemLegend } from './EventFeed'
import { presence, roomAwake, roomLogLines } from './live-state'
import { PlayersPanel } from './PlayersPanel'
import { SlotFiles } from './SlotFiles'
import { useLocalServer, useWebRoom } from './useLiveGame'
import './LiveGameScreen.css'

const KEY = 'screens.host'

type ServerStatus = ServerState['status']

const STATUS_PILL: Record<ServerStatus, Status> = {
  starting: 'busy',
  ready: 'ok',
  stopping: 'busy',
  stopped: 'idle',
  crashed: 'error',
}

const STATUS_TONE: Record<ServerStatus, Tone> = {
  starting: 'violet',
  ready: 'green',
  stopping: 'violet',
  stopped: 'neutral',
  crashed: 'pink',
}

/** The wizard step that starts the server again. */
const wizardHostStep = (sessionId: string): string => `/session/${sessionId}?step=5`

export function LiveGameScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { sessionId = '' } = useParams()
  const session = useIpcQuery('session:get', { id: sessionId })

  if (session.isPending) {
    return (
      <>
        <LiveHeader />
        <Spinner label={t(`${KEY}.loading`)} className="live-game__loading" />
      </>
    )
  }
  if (session.isError) {
    const { title, body, detail } = describeError(session.error, t)
    return (
      <>
        <LiveHeader />
        <ErrorPanel
          title={title}
          body={body}
          detail={detail}
          detailLabel={t('common.technicalDetails')}
          actions={
            <NeonButton variant="secondary" size="sm" onClick={() => void session.refetch()}>
              {t('common.retry')}
            </NeonButton>
          }
        />
      </>
    )
  }

  const { hosting } = session.data
  if (!hosting) {
    return (
      <>
        <LiveHeader subtitle={session.data.name} />
        <PixelPanel as="div" padding="lg">
          <EmptyState
            icon={<IconServerOff />}
            title={t(`${KEY}.notHosted.title`)}
            body={t(`${KEY}.notHosted.body`)}
            headingLevel={2}
            action={
              <NeonButton icon={<IconWand />} onClick={() => void navigate(`/session/${sessionId}`)}>
                {t(`${KEY}.notHosted.action`)}
              </NeonButton>
            }
          />
        </PixelPanel>
      </>
    )
  }
  return hosting.mode === 'local' ? (
    <LocalGame session={session.data} />
  ) : (
    <WebGame session={session.data} hosting={hosting} />
  )
}

function LiveHeader({ subtitle, actions }: { subtitle?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenHeader eyebrow={t(`${KEY}.eyebrow`)} title={t('nav.play')} subtitle={subtitle} actions={actions} />
  )
}

function useToastError(): (error: unknown) => void {
  const { t } = useTranslation()
  const toast = useToast()
  return (error) => {
    const { title, body } = describeError(error, t)
    toast.push({ tone: 'error', title, body })
  }
}

// --- Local server ---------------------------------------------------------------------------------

function LocalGame({ session }: { session: Session }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { server, feed, print } = useLocalServer(session.id)
  const [confirmStop, setConfirmStop] = useState(false)
  const command = useIpcMutation('server:command', {
    onError: (error) =>
      print({ text: t(`${KEY}.console.failed`, { error: describeError(error, t).title }), tone: 'error' }),
  })

  const state = server.data ?? null
  const status: ServerStatus = state?.status ?? 'stopped'
  const orphan = state?.error?.params?.orphanPid !== undefined
  const running = status === 'starting' || status === 'ready'
  // Players stay connected until the server is gone.
  const connected = status === 'ready' || status === 'stopping'
  const slots = session.generation?.slots ?? []
  const players = useMemo(
    () => presence(feed.data?.events ?? [], { running: connected }),
    [feed.data, connected],
  )

  const send = (text: string): void => {
    print({ text: `› ${text}`, tone: 'self' })
    command.mutate({ sessionId: session.id, command: text })
  }
  const restart = (): void => void navigate(wizardHostStep(session.id))

  const since =
    state && status === 'ready'
      ? new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(
          new Date(state.startedAt),
        )
      : null

  let connection: ReactNode
  if (server.isPending) {
    connection = (
      <PixelPanel title={t(`${KEY}.connection.title`)}>
        <Spinner label={t('common.loading')} />
      </PixelPanel>
    )
  } else if (server.isError) {
    const { title, body } = describeError(server.error, t)
    connection = (
      <ErrorPanel
        title={title}
        body={body}
        actions={
          <NeonButton variant="secondary" size="sm" onClick={() => void server.refetch()}>
            {t('common.retry')}
          </NeonButton>
        }
      />
    )
  } else if (state && status === 'crashed' && orphan) {
    // A server an earlier run of the app left running still serves its players: its addresses hold.
    connection = (
      <div className="live-game__orphan">
        <CrashPanel state={state} onRestart={restart} onStop={() => setConfirmStop(true)} />
        <ConnectionCard session={session} target={{ kind: 'local', state }} tone="yellow" />
      </div>
    )
  } else if (state && status === 'crashed') {
    connection = <CrashPanel state={state} onRestart={restart} onStop={() => setConfirmStop(true)} />
  } else if (state && status !== 'stopped') {
    connection = (
      <ConnectionCard
        session={session}
        target={{ kind: 'local', state }}
        tone={STATUS_TONE[status]}
        glow={status === 'ready'}
      />
    )
  } else {
    // The server ignored /exit and was killed after 15 s (spec §3.11).
    const forced = state?.error?.code === 'PROCESS_TIMEOUT'
    connection = (
      <PixelPanel as="div" padding="lg" className="live-game__stopped">
        {forced && (
          <p className="live-game__warning">
            <IconAlertTriangle aria-hidden="true" />
            <span>{t(`${KEY}.stopped.forced`)}</span>
          </p>
        )}
        <EmptyState
          tone="neutral"
          icon={<IconServerOff />}
          title={t(`${KEY}.stopped.title`)}
          body={t(`${KEY}.stopped.body`)}
          headingLevel={2}
          action={
            <NeonButton icon={<IconPlayerPlay />} onClick={restart}>
              {t(`${KEY}.restart`)}
            </NeonButton>
          }
        />
      </PixelPanel>
    )
  }

  return (
    <>
      <LiveHeader
        subtitle={
          since
            ? t(`${KEY}.subtitle.since`, { name: session.name, time: since })
            : t(`${KEY}.subtitle.local`, { name: session.name })
        }
        actions={
          <>
            {!server.isPending && (
              <StatusPill
                status={orphan && status === 'crashed' ? 'warn' : STATUS_PILL[status]}
                label={
                  orphan && status === 'crashed' ? t(`${KEY}.status.orphan`) : t(`${KEY}.status.${status}`)
                }
              />
            )}
            {status === 'ready' && (
              <NeonButton variant="secondary" icon={<IconDeviceFloppy />} onClick={() => send('/save')}>
                {t(`${KEY}.save`)}
              </NeonButton>
            )}
            {running && (
              <NeonButton
                variant="danger"
                icon={<IconPlayerStopFilled />}
                onClick={() => setConfirmStop(true)}
              >
                {t(`${KEY}.stop.button`)}
              </NeonButton>
            )}
          </>
        }
      />
      <div className="live-game">
        {state?.resumedFromSave && (running || status === 'stopping') && (
          <div className="live-game__banner tone-yellow">
            <IconHistory aria-hidden="true" />
            <div>
              <p className="live-game__banner-title">{t(`${KEY}.resumed.title`)}</p>
              <p className="live-game__banner-body">{t(`${KEY}.resumed.body`)}</p>
            </div>
          </div>
        )}
        <div className="live-game__top">
          {connection}
          <PlayersPanel players={slots} presence={players} />
        </div>
        <div className="live-game__duo">
          <div className="live-game__feed">
            <div className="live-game__feed-box">
              <EventFeed events={feed.data?.events} error={feed.error} className="live-game__feed-terminal" />
            </div>
            {state?.tracker !== undefined && <ItemLegend tracker={state.tracker} />}
          </div>
          <ConsolePanel
            title={t(`${KEY}.console.title`)}
            lines={feed.data?.lines ?? []}
            onCommand={status === 'ready' ? send : undefined}
            players={slots.map((slot) => slot.name)}
            className="live-game__terminal"
          />
        </div>
        <SlotFiles slots={slots} />
      </div>
      <StopDialog sessionId={session.id} open={confirmStop} onClose={() => setConfirmStop(false)} />
    </>
  )
}

function CrashPanel({
  state,
  onRestart,
  onStop,
}: {
  state: ServerState
  onRestart: () => void
  onStop: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const openLog = useIpcMutation('app:openPath', { onError: useToastError() })
  const { title, body, detail, logPath, action } = describeError(
    state.error ?? { code: 'SERVER_START_FAILED' },
    t,
  )
  const fixAt = action?.to
  // A server left over from an earlier run of the app still holds the port: it can be stopped.
  const orphan = state.error?.params?.orphanPid !== undefined
  return (
    <ErrorPanel
      title={title}
      body={body}
      detail={detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        <>
          {/* An orphan holds the game's save and port: it is stopped first, then started again. */}
          {!orphan && (
            <NeonButton variant="secondary" size="sm" icon={<IconPlayerPlay />} onClick={onRestart}>
              {t(`${KEY}.restart`)}
            </NeonButton>
          )}
          {orphan && (
            <NeonButton variant="danger" size="sm" icon={<IconPlayerStopFilled />} onClick={onStop}>
              {t(`${KEY}.stop.button`)}
            </NeonButton>
          )}
          {action && fixAt !== undefined && (
            <NeonButton variant="ghost" size="sm" onClick={() => void navigate(fixAt)}>
              {t(action.labelKey)}
            </NeonButton>
          )}
          {logPath !== undefined && (
            <NeonButton variant="ghost" size="sm" onClick={() => openLog.mutate({ path: logPath })}>
              {t('common.openLog')}
            </NeonButton>
          )}
        </>
      }
    />
  )
}

function StopDialog({
  sessionId,
  open,
  onClose,
}: {
  sessionId: string
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toastError = useToastError()
  // The server:state events tell the rest (stopping, then stopped).
  const stop = useIpcMutation('server:stop', {
    onSuccess: onClose,
    onError: (error) => {
      toastError(error)
      onClose()
    },
  })
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!stop.isPending}
      tone="pink"
      size="sm"
      eyebrow={t(`${KEY}.stop.eyebrow`)}
      title={t(`${KEY}.stop.title`)}
      closeLabel={t('common.closeDialog')}
      footer={
        <>
          <NeonButton variant="ghost" disabled={stop.isPending} onClick={onClose}>
            {t('common.cancel')}
          </NeonButton>
          <NeonButton
            variant="danger"
            icon={<IconPlayerStopFilled />}
            loading={stop.isPending}
            loadingLabel={t(`${KEY}.stop.stopping`)}
            onClick={() => stop.mutate({ sessionId })}
          >
            {t(`${KEY}.stop.confirm`)}
          </NeonButton>
        </>
      }
    >
      <div className="live-game__dialog">
        <p>{t(`${KEY}.stop.body`)}</p>
        <p className="live-game__dialog-dim">{t(`${KEY}.stop.later`)}</p>
        <p className="live-game__dialog-dim">{t(`${KEY}.stop.force`)}</p>
      </div>
    </Modal>
  )
}

// --- archipelago.gg room --------------------------------------------------------------------------

type WebHosting = Extract<Hosting, { mode: 'web' }>

/** What the session knows of its room, until archipelago.gg answers. */
function roomFromHosting(hosting: WebHosting): WebRoom {
  let host = 'archipelago.gg'
  try {
    host = new URL(hosting.roomUrl).hostname
  } catch {
    // Keep the default host.
  }
  return {
    roomId: hosting.roomId,
    seedId: hosting.seedId,
    roomUrl: hosting.roomUrl,
    host,
    port: hosting.port,
    lastActivity: null,
    timeoutS: null,
    players: [],
    downloads: [],
    trackerUrl: null,
  }
}

function WebGame({ session, hosting }: { session: Session; hosting: WebHosting }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const toastError = useToastError()
  const queryClient = useQueryClient()
  const { roomId } = hosting
  const { room, log, print } = useWebRoom(roomId)
  const current = room.data ?? roomFromHosting(hosting)
  const awake = roomAwake(current)

  // The port can change when the room wakes up.
  const wake = useIpcMutation('webhost:wake', {
    onSuccess: (next) => {
      queryClient.setQueryData(['webhost:room', { roomId }], next)
      if (next.port !== null) {
        toast.push({ tone: 'ok', title: t(`${KEY}.connection.woken`, { port: next.port }) })
      }
    },
    onError: toastError,
  })
  const owner = useIpcMutation('webhost:openAsOwner', { onError: toastError })
  const command = useIpcMutation('webhost:command', {
    onError: (error) =>
      print({ text: t(`${KEY}.console.failed`, { error: describeError(error, t).title }), tone: 'error' }),
  })

  const send = (text: string): void => {
    print({ text: `› ${text}`, tone: 'self' })
    command.mutate({ roomId, command: text })
  }

  const slots = useMemo(
    () =>
      session.generation?.slots ??
      current.players.map((player, index) => ({ ...player, slot: index + 1, patchFile: null })),
    [session.generation, current.players],
  )
  const downloads = useMemo(
    () => new Map(current.downloads.map((download) => [download.slot, download.url])),
    [current.downloads],
  )
  const lines = log.data ? roomLogLines(log.data) : []
  const shownLines = log.error
    ? [
        ...lines,
        {
          text: t(`${KEY}.console.logError`, { error: describeError(log.error, t).title }),
          tone: 'warn' as const,
        },
      ]
    : lines

  return (
    <>
      <LiveHeader
        subtitle={t(`${KEY}.subtitle.web`, { name: session.name, host: current.host })}
        actions={
          <>
            {/* Only from archipelago.gg's answer: the session alone cannot tell. */}
            {room.data && (
              <StatusPill
                status={awake ? 'info' : 'idle'}
                label={t(awake ? `${KEY}.status.webAwake` : `${KEY}.status.webAsleep`)}
              />
            )}
            <NeonButton
              variant={awake ? 'secondary' : 'primary'}
              icon={<IconSunrise />}
              loading={wake.isPending}
              loadingLabel={t(`${KEY}.connection.waking`)}
              onClick={() => wake.mutate({ roomId })}
            >
              {t(`${KEY}.connection.wake`)}
            </NeonButton>
            <NeonButton variant="ghost" icon={<IconExternalLink />} onClick={() => owner.mutate({ roomId })}>
              {t(`${KEY}.connection.openAsOwner`)}
            </NeonButton>
          </>
        }
      />
      <div className="live-game">
        <div className="live-game__top">
          <ConnectionCard
            session={session}
            target={{ kind: 'web', room: current }}
            tone="cyan"
            glow={awake}
            notice={
              room.error && (
                <p className="live-game__notice">
                  {t(`${KEY}.connection.roomError`, { error: describeError(room.error, t).title })}
                </p>
              )
            }
          />
          <PlayersPanel players={slots} />
        </div>
        <ConsolePanel
          title={t(`${KEY}.console.webTitle`)}
          lines={shownLines}
          onCommand={send}
          players={slots.map((slot) => slot.name)}
          className="live-game__terminal"
        />
        <SlotFiles slots={slots} downloads={downloads} />
      </div>
    </>
  )
}
