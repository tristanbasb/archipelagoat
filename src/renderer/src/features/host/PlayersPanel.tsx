// The players of the game: their slot, their game, and (for a local server) who is online and who
// reached their goal.
import { IconTrophy, IconUsers } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { cx, NEON_SERIES, toneClass } from '../../design/classes'
import { Badge, PixelPanel, StatusPill } from '../../design/components'
import type { Presence } from './live-state'
import './PlayersPanel.css'

const KEY = 'screens.host.players'

export interface PlayerSlot {
  slot: number
  name: string
  game: string
}

export interface PlayersPanelProps {
  players: readonly PlayerSlot[]
  /** Who is online and who finished; absent when nobody says (an archipelago.gg room). */
  presence?: Presence
  className?: string
}

export function PlayersPanel({ players, presence, className }: PlayersPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const isOnline = (name: string): boolean => presence?.online.has(name) === true
  const isDone = (name: string): boolean =>
    presence !== undefined && (presence.everyoneDone || presence.goals.has(name))
  const total = players.length

  const summary =
    presence && total > 0 ? (
      <>
        <Badge tone="green" icon={<IconUsers />}>
          {t(`${KEY}.online`, { online: players.filter((p) => isOnline(p.name)).length, total })}
        </Badge>
        <Badge tone="yellow" icon={<IconTrophy />}>
          {t(`${KEY}.goals`, { goals: players.filter((p) => isDone(p.name)).length, total })}
        </Badge>
      </>
    ) : undefined

  return (
    <PixelPanel title={t(`${KEY}.title`)} actions={summary} className={cx('players-panel', className)}>
      {total === 0 ? (
        <p className="players-panel__note">{t(`${KEY}.empty`)}</p>
      ) : (
        <ul className="players-panel__list">
          {players.map((player, index) => {
            const online = isOnline(player.name)
            return (
              <li
                key={player.slot}
                className={cx(
                  'players-panel__row',
                  toneClass(NEON_SERIES[index % NEON_SERIES.length] ?? 'violet'),
                )}
                data-online={online || undefined}
              >
                <span className="players-panel__slot t-display">
                  {t(`${KEY}.slot`, { slot: player.slot })}
                </span>
                <span className="players-panel__who">
                  <span className="players-panel__name">{player.name}</span>
                  <span className="players-panel__game">{player.game}</span>
                </span>
                {presence && (
                  <span className="players-panel__status">
                    {isDone(player.name) && (
                      <Badge tone="yellow" icon={<IconTrophy />}>
                        {t(`${KEY}.goal`)}
                      </Badge>
                    )}
                    <StatusPill
                      status={online ? 'ok' : 'idle'}
                      label={t(online ? `${KEY}.connected` : `${KEY}.absent`)}
                    />
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!presence && total > 0 && <p className="players-panel__note">{t(`${KEY}.webHint`)}</p>}
    </PixelPanel>
  )
}
