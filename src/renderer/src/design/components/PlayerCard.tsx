import { useId, type ReactNode } from 'react'
import { cx } from '../classes'
import { sfx } from '../sfx'
import './PlayerCard.css'

// 5×7 bitmaps of the "1P" / "2P" badge, drawn as pixels rather than text.
const GLYPHS = {
  1: ['..#..', '.##..', '#.#..', '..#..', '..#..', '..#..', '#####'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
} as const

function PixelBadge({ player }: { player: 1 | 2 }): React.JSX.Element {
  const pixels: { x: number; y: number }[] = []
  for (const [offset, glyph] of [GLYPHS[player], GLYPHS.P].entries()) {
    glyph.forEach((row, y) => {
      ;[...row].forEach((cell, x) => {
        if (cell === '#') pixels.push({ x: offset * 6 + x, y })
      })
    })
  }
  return (
    <svg className="player-card__badge" viewBox="0 0 11 7" shapeRendering="crispEdges" aria-hidden="true">
      {pixels.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
      ))}
    </svg>
  )
}

export interface PlayerCardProps {
  player: 1 | 2
  /** Arcade label, e.g. "PLAYER 1". */
  label: string
  title: ReactNode
  subtitle?: ReactNode
  /** Blinking call to action, e.g. "PRESS START" (decorative). */
  cta?: string
  icon?: ReactNode
  onClick: () => void
  disabled?: boolean
  className?: string
}

/** One of the two big home choices: player 1 (violet) hosts, player 2 (cyan) joins. */
export function PlayerCard({
  player,
  label,
  title,
  subtitle,
  cta,
  icon,
  onClick,
  disabled,
  className,
}: PlayerCardProps): React.JSX.Element {
  const id = useId()
  const handleClick = (): void => {
    sfx.play('coin')
    onClick()
  }
  return (
    <button
      type="button"
      className={cx('player-card pixel-border', player === 1 ? 'tone-violet' : 'tone-cyan', className)}
      data-player={player}
      disabled={disabled}
      aria-labelledby={`${id}-label ${id}-title`}
      aria-describedby={subtitle !== undefined ? `${id}-subtitle` : undefined}
      onClick={handleClick}
    >
      <span className="player-card__sheen" aria-hidden="true" />
      <PixelBadge player={player} />
      <span className="player-card__top">
        <span id={`${id}-label`} className="player-card__label t-display">
          {label}
        </span>
        {icon !== undefined && (
          <span className="player-card__icon" aria-hidden="true">
            {icon}
          </span>
        )}
      </span>
      <span className="player-card__text">
        <span id={`${id}-title`} className="player-card__title">
          {title}
        </span>
        {subtitle !== undefined && (
          <span id={`${id}-subtitle`} className="player-card__subtitle">
            {subtitle}
          </span>
        )}
      </span>
      {cta !== undefined && (
        <span className="player-card__cta t-display" aria-hidden="true">
          <span className="player-card__arrow" />
          {cta}
        </span>
      )}
    </button>
  )
}
