// Where players connect: the server addresses (or the archipelago.gg address and room link), the
// game password, and a ready-to-paste message for the group chat.
import {
  IconAlertTriangle,
  IconClock,
  IconMessageShare,
  IconNetwork,
  IconShieldCheck,
  IconZzz,
} from '@tabler/icons-react'
import type { TFunction } from 'i18next'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Address, ServerState, Session, WebRoom } from '@shared/types'
import type { Tone } from '../../design/classes'
import { CopyField, PixelPanel, Spinner, Toggle } from '../../design/components'
import { useIpcQuery } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import { CopyButton } from './CopyButton'
import { roomAwake } from './live-state'
import { buildShareText } from './share-text'
import './ConnectionCard.css'

const KEY = 'screens.host.connection'
const SHARE = 'screens.host.share'

/** Stands for the password in the share preview: the preview never shows it. */
const PASSWORD_MASK = '••••••••'

/** The order addresses are listed in: the ones players use first. */
const ADDRESS_ORDER: readonly Address['kind'][] = ['lan', 'public', 'vpn', 'localhost']

export type ConnectionTarget = { kind: 'local'; state: ServerState } | { kind: 'web'; room: WebRoom }

export interface ConnectionCardProps {
  session: Session
  target: ConnectionTarget
  /** A note under the addresses (the room state could not be read…). */
  notice?: ReactNode
  tone?: Tone
  glow?: boolean
}

export function ConnectionCard({
  session,
  target,
  notice,
  tone = 'neutral',
  glow = false,
}: ConnectionCardProps): React.JSX.Element {
  const { t } = useTranslation()
  // Read only to show it masked and to copy it; dropped from the cache with the screen.
  const secrets = useIpcQuery(
    'session:getSecrets',
    { id: session.id },
    { enabled: session.hasPassword, staleTime: Infinity, gcTime: 0 },
  )
  const password = secrets.data?.password ?? null

  return (
    <PixelPanel title={t(`${KEY}.title`)} tone={tone} glow={glow} className="connection-card">
      <div className="connection-card__fields">
        {target.kind === 'local' ? (
          <LocalAddresses state={target.state} />
        ) : (
          <RoomAddresses room={target.room} />
        )}
        {session.hasPassword &&
          (secrets.isPending ? (
            <Spinner size="sm" label={t(`${KEY}.passwordLoading`)} />
          ) : secrets.isError ? (
            <p className="connection-card__note">
              {t(`${KEY}.passwordError`, { error: describeError(secrets.error, t).title })}
            </p>
          ) : (
            password && (
              <CopyField
                secret
                value={password}
                label={t(`${KEY}.password`)}
                copyLabel={t('common.copy')}
                copiedLabel={t('common.copied')}
                revealLabel={t(`${KEY}.reveal`)}
                hideLabel={t(`${KEY}.hide`)}
              />
            )
          ))}
      </div>
      {notice}
      <ShareMessage
        session={session}
        target={target.kind === 'local' ? target.state.addresses : target.room}
        password={password}
      />
    </PixelPanel>
  )
}

/** The label of an address: its kind, and the name of its VPN when its adapter tells it. */
export function addressLabel(address: Address, t: TFunction): string {
  if (address.kind === 'vpn' && address.network !== undefined)
    return t(`${KEY}.address.vpnNamed`, { network: address.network })
  return t(`${KEY}.address.${address.kind}`)
}

function LocalAddresses({ state }: { state: ServerState }): React.JSX.Element {
  const { t } = useTranslation()
  const os = useIpcQuery('app:getInfo', undefined, { staleTime: Infinity }).data?.os
  if (state.addresses.length === 0) {
    return state.status === 'starting' ? (
      <Spinner label={t(`${KEY}.starting`)} className="connection-card__waiting connection-card__wide" />
    ) : (
      <p className="connection-card__note connection-card__wide">{t(`${KEY}.noAddress`)}</p>
    )
  }
  const addresses = [...state.addresses].sort(
    (a, b) => ADDRESS_ORDER.indexOf(a.kind) - ADDRESS_ORDER.indexOf(b.kind),
  )
  // Windows lets the players of the local network in once its firewall allows the server (it asks on
  // the first local hosting): said once, under the first local network address.
  const firewallHintAt = os === 'win32' ? addresses.find((address) => address.kind === 'lan') : undefined
  return (
    <>
      {addresses.map((address) => (
        <div key={`${address.kind}-${address.host}`} className="connection-card__address">
          <CopyField
            label={addressLabel(address, t)}
            value={`${address.host}:${address.port}`}
            copyLabel={t('common.copy')}
            copiedLabel={t('common.copied')}
          />
          {address === firewallHintAt && (
            <p className="connection-card__note">
              <IconShieldCheck aria-hidden="true" />
              <span>{t(`${KEY}.firewallHint`)}</span>
            </p>
          )}
          {address.kind === 'vpn' && (
            <p className="connection-card__note">
              <IconNetwork aria-hidden="true" />
              <span>{t(`${KEY}.vpnHint`)}</span>
            </p>
          )}
          {address.kind === 'public' && (
            <p className="connection-card__note connection-card__note--warn">
              <IconAlertTriangle aria-hidden="true" />
              <span>{t(`${KEY}.publicHint`, { port: address.port })}</span>
            </p>
          )}
        </div>
      ))}
    </>
  )
}

function RoomAddresses({ room }: { room: WebRoom }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  return (
    <>
      {room.port !== null ? (
        <div className="connection-card__address">
          <CopyField
            label={t(`${KEY}.serverAddress`)}
            value={`${room.host}:${room.port}`}
            copyLabel={t('common.copy')}
            copiedLabel={t('common.copied')}
          />
          {/* Asleep, the room keeps its last port, which can change when it wakes up. */}
          {!roomAwake(room) && (
            <p className="connection-card__note connection-card__note--warn">
              <IconZzz aria-hidden="true" />
              <span>{t(`${KEY}.asleepPort`)}</span>
            </p>
          )}
        </div>
      ) : (
        <p className="connection-card__note connection-card__note--warn connection-card__wide">
          <IconZzz aria-hidden="true" />
          <span>{t(`${KEY}.asleep`)}</span>
        </p>
      )}
      <CopyField
        className="connection-card__wide"
        label={t(`${KEY}.roomLink`)}
        value={room.roomUrl}
        copyLabel={t('common.copy')}
        copiedLabel={t('common.copied')}
      />
      {(room.lastActivity !== null || room.timeoutS !== null) && (
        <p className="connection-card__note connection-card__wide">
          <IconClock aria-hidden="true" />
          <span>
            {[
              room.lastActivity !== null &&
                t(`${KEY}.lastActivity`, { when: relativeTime(room.lastActivity, i18n.language) }),
              room.timeoutS !== null &&
                t(`${KEY}.timeout`, { duration: duration(room.timeoutS, i18n.language) }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </p>
      )}
    </>
  )
}

function ShareMessage({
  session,
  target,
  password,
}: {
  session: Session
  target: readonly Address[] | WebRoom
  password: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const [include, setInclude] = useState(false)
  const withPassword = include && password !== null
  const preview = buildShareText(session, target, { password: withPassword ? PASSWORD_MASK : null }, t)

  return (
    <section className="connection-card__share" aria-labelledby={titleId}>
      <div className="connection-card__share-head">
        <h3 id={titleId} className="connection-card__share-title">
          <IconMessageShare aria-hidden="true" />
          {t(`${SHARE}.title`)}
        </h3>
        <CopyButton
          variant="secondary"
          value={() => buildShareText(session, target, { password: withPassword ? password : null }, t)}
          label={t(`${SHARE}.copy`)}
          copiedLabel={t(`${SHARE}.copied`)}
        />
      </div>
      {/* It scrolls when long, so the keyboard can reach it. */}
      <pre className="connection-card__preview" tabIndex={0}>
        {preview}
      </pre>
      <div className="connection-card__share-foot">
        {password !== null && (
          <Toggle
            checked={include}
            onChange={setInclude}
            label={t(`${SHARE}.includePassword`)}
            tone="yellow"
          />
        )}
        <p className="connection-card__note">{t(`${SHARE}.hint`)}</p>
      </div>
    </section>
  )
}

/** "5 minutes ago", in the app language. */
function relativeTime(iso: string, lang: string): string {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000)
  if (Number.isNaN(seconds)) return iso
  const format = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(seconds, 'second')
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour')
  return format.format(Math.round(seconds / 86_400), 'day')
}

/** "2 hours", "30 minutes", in the app language. */
function duration(seconds: number, lang: string): string {
  const hours = seconds >= 3600 && seconds % 3600 === 0
  return new Intl.NumberFormat(lang, {
    style: 'unit',
    unit: hours ? 'hour' : 'minute',
    unitDisplay: 'long',
    maximumFractionDigits: 0,
  }).format(hours ? seconds / 3600 : Math.round(seconds / 60))
}
