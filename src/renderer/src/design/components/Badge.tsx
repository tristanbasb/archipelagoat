import type { ReactNode } from 'react'
import { cx, toneClass, type Tone } from '../classes'
import './Badge.css'

export interface BadgeProps {
  tone?: Tone
  icon?: ReactNode
  /** Plain outline instead of a tinted fill. */
  outline?: boolean
  title?: string
  className?: string
  children: ReactNode
}

export function Badge({
  tone = 'neutral',
  icon,
  outline = false,
  title,
  className,
  children,
}: BadgeProps): React.JSX.Element {
  return (
    <span
      className={cx('badge', toneClass(tone), outline && 'badge--outline', className)}
      data-tone={tone}
      title={title}
    >
      {icon !== undefined && (
        <span className="badge__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </span>
  )
}
