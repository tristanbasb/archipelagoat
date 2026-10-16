import type { ReactNode } from 'react'
import { IconChevronRight } from '@tabler/icons-react'
import { cx, toneClass, type Tone } from '../classes'
import './StatTile.css'

export interface StatTileProps {
  label: ReactNode
  value: ReactNode
  icon?: ReactNode
  tone?: Tone
  /** A line under the value (a StatusPill, a date…). */
  hint?: ReactNode
  /** Makes the whole tile a button. */
  onClick?: () => void
  className?: string
}

/** A compact status tile: icon, label, value and a hint under it. */
export function StatTile({
  label,
  value,
  icon,
  tone = 'violet',
  hint,
  onClick,
  className,
}: StatTileProps): React.JSX.Element {
  const content = (
    <>
      {(icon !== undefined || onClick) && (
        <span className="stat-tile__top">
          {icon !== undefined && (
            <span className="stat-tile__icon" aria-hidden="true">
              {icon}
            </span>
          )}
          {onClick && <IconChevronRight className="stat-tile__chevron" aria-hidden="true" />}
        </span>
      )}
      {/* The spaces keep the accessible name readable; flex layout ignores them. */}
      <span className="stat-tile__label">{label}</span> <span className="stat-tile__value">{value}</span>
      {hint !== undefined && (
        <>
          {' '}
          <span className="stat-tile__hint">{hint}</span>
        </>
      )}
    </>
  )
  const classes = cx('stat-tile pixel-border', toneClass(tone), className)
  return onClick ? (
    <button type="button" className={classes} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={classes}>{content}</div>
  )
}
