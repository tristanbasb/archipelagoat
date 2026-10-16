import { cssVars, cx } from '../classes'
import './Spinner.css'

// The eight cells of a 3×3 ring, clockwise from the top left.
const RING: readonly (readonly [column: number, row: number])[] = [
  [1, 1],
  [2, 1],
  [3, 1],
  [3, 2],
  [3, 3],
  [2, 3],
  [1, 3],
  [1, 2],
]

export interface SpinnerProps {
  /** Announced (role="status") and shown next to the spinner; without it the spinner is decorative. */
  label?: string
  size?: 'sm' | 'md'
  className?: string
}

/** A pixel ring whose lit cell runs around; drawn in the current text color. */
export function Spinner({ label, size = 'md', className }: SpinnerProps): React.JSX.Element {
  const glyph = (
    <span className={cx('spinner', !label && className)} data-spinner="" data-size={size} aria-hidden="true">
      {RING.map(([column, row], index) => (
        <span
          key={index}
          className="spinner__cell"
          style={cssVars({ '--i': index }, { gridColumn: column, gridRow: row })}
        />
      ))}
    </span>
  )
  if (!label) return glyph
  return (
    <span role="status" aria-label={label} className={cx('spinner-status', className)}>
      {glyph}
      <span className="spinner-status__label">{label}</span>
    </span>
  )
}
