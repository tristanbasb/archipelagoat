// The games a player's YAML plays, each one's cover beside its name.
import type { PlayerDoc } from '@shared/types'
import { cx } from '../../design/classes'
import { Badge } from '../../design/components'
import { GameCover } from '../worlds/GameCover'
import './PlayerGames.css'

export interface PlayerGamesProps {
  games: PlayerDoc['games']
  className?: string
}

export function PlayerGames({ games, className }: PlayerGamesProps): React.JSX.Element {
  return (
    <span className={cx('player-games', className)}>
      {games.map(({ game }) => (
        <span key={game} className="player-games__game">
          <GameCover game={game} />
          <Badge tone="neutral" outline>
            {game}
          </Badge>
        </span>
      ))}
    </span>
  )
}
