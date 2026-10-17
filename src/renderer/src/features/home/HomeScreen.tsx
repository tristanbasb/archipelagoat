// The home dashboard (spec §4.2.1): the INSERT COIN call when Archipelago is missing, the two player
// cards, the state of the setup, the health check alerts and the recent games.
import {
  IconArrowRight,
  IconBolt,
  IconChevronRight,
  IconDeviceGamepad2,
  IconDisc,
  IconPlugConnected,
  IconPlus,
  IconUsersGroup,
  IconWorld,
} from '@tabler/icons-react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import type { GoatError } from '@shared/errors'
import type {
  ApInstall,
  BizhawkState,
  RomRecord,
  SessionStatus,
  SessionSummary,
  WorldInfo,
  WorldState,
} from '@shared/types'
import {
  EmptyState,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  PlayerCard,
  Spinner,
  StatTile,
  StatusPill,
  type Status,
  type Tone,
} from '../../design/components'
import { useIpcQuery } from '../../hooks/useIpc'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { describeError } from '../../lib/errors'
import {
  CHECK_ICONS,
  CheckFixButton,
  SEVERITY_TONE,
  checkText,
  isAlert,
  sortChecks,
  useDoctorFix,
  useDoctorRun,
} from '../doctor/checks'
import './HomeScreen.css'

const K = 'screens.home'

/**
 * The home reruns the health check at most once a minute; the diagnostic screen always does. An
 * install or a world change reruns it at once (the shell's useEventInvalidation).
 */
const DOCTOR_STALE_MS = 60_000

/** How many recent games the home lists. */
const RECENT_COUNT = 5

export function HomeScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ap = useIpcQuery('ap:detect', undefined)

  return (
    <div className="home">
      <ScreenHeader eyebrow={t(`${K}.eyebrow`)} title={t('nav.home')} subtitle={t(`${K}.subtitle`)} />
      {ap.data === null && <InsertCoin onInsert={() => void navigate('/install')} />}
      <div className="home__players">
        <PlayerCard
          player={1}
          label={t(`${K}.players.host.label`)}
          title={t(`${K}.players.host.title`)}
          subtitle={t(`${K}.players.host.subtitle`)}
          cta={t(`${K}.players.cta`)}
          icon={<IconUsersGroup />}
          onClick={() => void navigate('/session/new')}
        />
        <PlayerCard
          player={2}
          label={t(`${K}.players.join.label`)}
          title={t(`${K}.players.join.title`)}
          subtitle={t(`${K}.players.join.subtitle`)}
          cta={t(`${K}.players.cta`)}
          icon={<IconPlugConnected />}
          onClick={() => void navigate('/join')}
        />
      </div>
      <SetupTiles ap={ap} />
      <AlertBanner />
      <RecentSessions />
    </div>
  )
}

// ---- INSERT COIN ---------------------------------------------------------------------------------

// A 10×12 gold coin: outline, gold, highlight, shade, and the engraved slot in its middle.
const COIN = [
  '...OOOO...',
  '.OOYYYYOO.',
  '.OYHHYYSO.',
  'OYHYYYYYSO',
  'OYHYOOYYSO',
  'OYHYOOYYSO',
  'OYHYOOYYSO',
  'OYHYOOYYSO',
  'OYYYYYYSSO',
  '.OYYYYSSO.',
  '.OOSSSSOO.',
  '...OOOO...',
] as const

const COIN_PIXELS = COIN.flatMap((row, y) =>
  [...row].flatMap((cell, x) => (cell === '.' ? [] : [{ x, y, cell }])),
)

function PixelCoin(): React.JSX.Element {
  return (
    <span className="home-coin__art" aria-hidden="true">
      <svg className="home-coin__coin" viewBox="0 0 10 12" shapeRendering="crispEdges">
        {COIN_PIXELS.map(({ x, y, cell }) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} data-px={cell} />
        ))}
      </svg>
      <span className="home-coin__slot" />
    </span>
  )
}

function InsertCoin({ onInsert }: { onInsert: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  return (
    <section className="home-coin pixel-border tone-yellow" aria-labelledby={titleId}>
      <PixelCoin />
      <div className="home-coin__text">
        <span className="home-coin__eyebrow t-display" aria-hidden="true">
          {t(`${K}.coin.eyebrow`)}
        </span>
        <h2 id={titleId} className="home-coin__title">
          {t(`${K}.coin.title`)}
        </h2>
        <p className="home-coin__body">{t(`${K}.coin.body`)}</p>
      </div>
      <NeonButton arcade size="lg" sound="coin" className="home-coin__cta" onClick={onInsert}>
        <span className="home-coin__cta-main">{t(`${K}.coin.cta`)}</span>{' '}
        <span className="home-coin__cta-hint">{t(`${K}.coin.ctaHint`)}</span>
      </NeonButton>
    </section>
  )
}

// ---- Setup tiles ---------------------------------------------------------------------------------

interface TileState {
  value: ReactNode
  hint?: ReactNode
}

function pill(status: Status, label: string): ReactNode {
  return <StatusPill status={status} label={label} />
}

/**
 * The tile of a query: its loading and failed states, else what `ready` makes of the data. A list
 * that needs Archipelago reads as `whenApMissing` while it is not installed: nothing, not a failure.
 */
function tileState<T>(
  query: UseQueryResult<T, GoatError>,
  t: TFunction,
  ready: (data: T) => TileState,
  whenApMissing?: T,
): TileState {
  if (query.isPending) {
    return {
      value: (
        <span className="home-tile__loading">
          <Spinner size="sm" />
          <span className="sr-only">{t('common.loading')}</span>
        </span>
      ),
    }
  }
  if (query.isError) {
    if (whenApMissing !== undefined && query.error.code === 'AP_NOT_INSTALLED') return ready(whenApMissing)
    return { value: t(`${K}.stats.unknownValue`), hint: pill('idle', t(`${K}.stats.unavailable`)) }
  }
  return ready(query.data)
}

function apTile(install: ApInstall | null, t: TFunction): TileState {
  const k = `${K}.stats.ap`
  if (!install) return { value: t(`${k}.missing`), hint: pill('error', t(`${k}.toInstall`)) }
  if (!install.version)
    return { value: t(`${K}.stats.unknownValue`), hint: pill('warn', t(`${k}.unknownVersion`)) }
  // The app targets the 0.6 series, like the status bar.
  const supported = install.version.startsWith('0.6.')
  return {
    value: install.version,
    hint: supported ? pill('ok', t(`${k}.ready`)) : pill('warn', t(`${k}.otherSeries`)),
  }
}

/** States that make a world worth a look on the worlds screen. */
const WORLD_PROBLEMS: ReadonlySet<WorldState> = new Set([
  'corrupt',
  'bad-name',
  'no-manifest',
  'incompatible',
  'shadowed',
])

function worldsTile(worlds: WorldInfo[], t: TFunction, count: (n: number) => string): TileState {
  const k = `${K}.stats.worlds`
  const enabled = worlds.filter((world) => world.location !== 'disabled')
  const corrupt = enabled.filter((world) => world.states.includes('corrupt')).length
  const problems = enabled.filter((world) => world.states.some((state) => WORLD_PROBLEMS.has(state))).length
  const value = count(enabled.length)
  if (enabled.length === 0) return { value, hint: pill('idle', t(`${k}.none`)) }
  if (corrupt > 0) return { value, hint: pill('error', t(`${k}.corrupt`, { count: corrupt })) }
  if (problems > 0) return { value, hint: pill('warn', t(`${k}.toCheck`, { count: problems })) }
  return { value, hint: pill('ok', t(`${k}.allGood`)) }
}

function romsTile(roms: RomRecord[], t: TFunction, count: (n: number) => string): TileState {
  const k = `${K}.stats.roms`
  const known = roms.filter((rom) => rom.game !== null).length
  const unknown = roms.length - known
  const value = count(known)
  if (roms.length === 0) return { value, hint: pill('idle', t(`${k}.empty`)) }
  if (unknown > 0) return { value, hint: pill('info', t(`${k}.unknown`, { count: unknown })) }
  return { value, hint: pill('ok', t(`${k}.allKnown`)) }
}

function bizhawkTile(state: BizhawkState, t: TFunction): TileState {
  const k = `${K}.stats.bizhawk`
  // BizHawk only matters for the games that run in it.
  if (!state.installed) return { value: t(`${k}.missing`), hint: pill('idle', t(`${k}.optional`)) }
  const value = state.version ?? t(`${k}.installed`)
  if (state.prereqs.some((prereq) => !prereq.ok)) return { value, hint: pill('warn', t(`${k}.prereq`)) }
  if (!state.configuredInAp) return { value, hint: pill('warn', t(`${k}.notLinked`)) }
  return { value, hint: pill('ok', t(`${k}.ready`)) }
}

function SetupTiles({ ap }: { ap: UseQueryResult<ApInstall | null, GoatError> }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const titleId = useId()
  const worlds = useIpcQuery('worlds:list', undefined)
  const roms = useIpcQuery('vault:list', undefined)
  const bizhawk = useIpcQuery('bizhawk:state', undefined)
  const numbers = new Intl.NumberFormat(i18n.language)
  const count = (n: number): string => numbers.format(n)

  const tiles: { key: string; label: string; icon: ReactNode; tone: Tone; to: string; state: TileState }[] = [
    {
      key: 'ap',
      label: t(`${K}.stats.ap.label`),
      icon: <IconBolt />,
      tone: 'violet',
      to: '/install',
      state: tileState(ap, t, (data) => apTile(data, t)),
    },
    {
      key: 'worlds',
      label: t(`${K}.stats.worlds.label`),
      icon: <IconWorld />,
      tone: 'cyan',
      to: '/worlds',
      state: tileState(worlds, t, (data) => worldsTile(data, t, count), []),
    },
    {
      key: 'roms',
      label: t(`${K}.stats.roms.label`),
      icon: <IconDisc />,
      tone: 'magenta',
      to: '/vault',
      state: tileState(roms, t, (data) => romsTile(data, t, count)),
    },
    {
      key: 'bizhawk',
      label: t(`${K}.stats.bizhawk.label`),
      icon: <IconDeviceGamepad2 />,
      tone: 'green',
      to: '/vault',
      state: tileState(bizhawk, t, (data) => bizhawkTile(data, t)),
    },
  ]

  return (
    <section className="home__tiles" aria-labelledby={titleId}>
      <h2 id={titleId} className="sr-only">
        {t(`${K}.stats.title`)}
      </h2>
      {tiles.map((tile) => (
        <StatTile
          key={tile.key}
          label={tile.label}
          icon={tile.icon}
          tone={tile.tone}
          value={tile.state.value}
          hint={tile.state.hint}
          onClick={() => void navigate(tile.to)}
        />
      ))}
    </section>
  )
}

// ---- Health check alerts -------------------------------------------------------------------------

function AlertBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const doctor = useDoctorRun({ staleTime: DOCTOR_STALE_MS })
  const fix = useDoctorFix()
  // Archipelago itself has its tile and the INSERT COIN call: the banner leaves it out.
  const alerts = sortChecks(
    (doctor.data ?? []).filter((check) => isAlert(check) && check.id !== 'ap-installed'),
  )
  const worst = alerts[0]
  if (!worst) return null
  return (
    <PixelPanel
      className="home-alerts"
      tone={SEVERITY_TONE[worst.severity]}
      eyebrow={t(`${K}.alerts.eyebrow`)}
      title={t(`${K}.alerts.title`, { count: alerts.length })}
      actions={
        <Link to="/doctor" className="home-link">
          {t('errors.actions.doctor')}
          <IconArrowRight aria-hidden="true" />
        </Link>
      }
    >
      <ul className="home-alerts__list">
        {alerts.map((check) => {
          const Icon = CHECK_ICONS[check.id]
          const { title, text } = checkText(check, t)
          return (
            <li key={check.id} className={`home-alert tone-${SEVERITY_TONE[check.severity]}`}>
              <span className="home-alert__icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="home-alert__text">
                <span className="home-alert__title">{title}</span>{' '}
                <span className="home-alert__body">{text}</span>
              </span>
              <CheckFixButton check={check} fix={fix} />
            </li>
          )
        })}
      </ul>
    </PixelPanel>
  )
}

// ---- Recent games --------------------------------------------------------------------------------

const SESSION_PILL: Record<SessionStatus, Status> = {
  draft: 'idle',
  generated: 'info',
  hosting: 'ok',
  finished: 'idle',
}

type ResumeAction = 'continue' | 'host' | 'resume' | 'reopen'

/** Where a game continues: the live screen while it runs (or for a web room), else the wizard. */
function resumeOf(session: SessionSummary): { to: string; action: ResumeAction } {
  const id = encodeURIComponent(session.id)
  if (session.status === 'hosting') return { to: `/play/${id}`, action: 'resume' }
  // A web room outlives the app: the live screen wakes it up.
  if (session.status === 'finished' && session.hostingMode === 'web')
    return { to: `/play/${id}`, action: 'reopen' }
  if (session.status === 'draft') return { to: `/session/${id}`, action: 'continue' }
  // Generated, or a local game that ended: host it again from the wizard's last step.
  return { to: `/session/${id}?step=5`, action: 'host' }
}

const TIME_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "il y a 2 heures", "yesterday"… A time ahead of `now` (another clock) reads as now. */
function relativeTime(time: number, lang: string, now: number): string {
  const seconds = Math.min(0, Math.round((time - now) / 1000))
  const format = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  for (const [unit, size] of TIME_UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(0, 'second')
}

function SessionRow({ session, now }: { session: SessionSummary; now: number }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { to, action } = resumeOf(session)
  const updated = Date.parse(session.updatedAt)
  const meta = [t(`${K}.recent.players`, { count: session.playerCount })]
  if (session.hostingMode) meta.push(t(`${K}.recent.hosting.${session.hostingMode}`))
  return (
    <li>
      <Link to={to} className="home-session" data-status={session.status}>
        <span className="home-session__main">
          <span className="home-session__name">{session.name}</span>{' '}
          <span className="home-session__meta">
            {meta.join(' · ')}
            {!Number.isNaN(updated) && (
              <>
                {' · '}
                <time
                  dateTime={session.updatedAt}
                  title={new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: 'long',
                    timeStyle: 'short',
                  }).format(updated)}
                >
                  {relativeTime(updated, i18n.language, now)}
                </time>
              </>
            )}
          </span>
        </span>{' '}
        <StatusPill status={SESSION_PILL[session.status]} label={t(`${K}.recent.status.${session.status}`)} />{' '}
        <span className="home-session__action">
          {t(`${K}.recent.action.${action}`)}
          <IconChevronRight aria-hidden="true" />
        </span>
      </Link>
    </li>
  )
}

function RecentSessions(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const sessions = useIpcQuery('session:list', undefined)
  const newGame = (): void => void navigate('/session/new')
  const recent = [...(sessions.data ?? [])]
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, RECENT_COUNT)

  let body: ReactNode
  if (sessions.isPending) {
    body = <Spinner label={t('common.loading')} className="home-recent__loading" />
  } else if (sessions.isError) {
    const described = describeError(sessions.error, t)
    body = (
      <ErrorPanel
        title={described.title}
        body={described.body}
        detail={described.detail}
        detailLabel={t('common.technicalDetails')}
        actions={
          <NeonButton variant="secondary" size="sm" onClick={() => void sessions.refetch()}>
            {t('common.retry')}
          </NeonButton>
        }
      />
    )
  } else if (recent.length === 0) {
    body = (
      <EmptyState
        icon={<IconUsersGroup />}
        title={t(`${K}.recent.empty.title`)}
        body={t(`${K}.recent.empty.body`)}
        action={
          <NeonButton icon={<IconPlus />} onClick={newGame}>
            {t(`${K}.recent.empty.action`)}
          </NeonButton>
        }
      />
    )
  } else {
    body = (
      <ul className="home-recent__list">
        {recent.map((session) => (
          // Dated from when the list was read, so a render stays pure.
          <SessionRow key={session.id} session={session} now={sessions.dataUpdatedAt} />
        ))}
      </ul>
    )
  }

  return (
    <PixelPanel
      className="home-recent"
      eyebrow={t(`${K}.recent.eyebrow`)}
      title={t(`${K}.recent.title`)}
      actions={
        recent.length > 0 ? (
          <>
            {/* Older games, finished ones and deleting one: on the games page. */}
            {(sessions.data?.length ?? 0) > RECENT_COUNT && (
              <NeonButton variant="ghost" size="sm" onClick={newGame}>
                {t(`${K}.recent.all`, { count: sessions.data?.length ?? 0 })}
              </NeonButton>
            )}
            <NeonButton variant="ghost" size="sm" icon={<IconPlus />} onClick={newGame}>
              {t(`${K}.recent.new`)}
            </NeonButton>
          </>
        ) : undefined
      }
    >
      {body}
    </PixelPanel>
  )
}
