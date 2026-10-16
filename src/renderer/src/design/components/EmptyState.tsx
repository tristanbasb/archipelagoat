import { IconGhost2 } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { cx, toneClass, type Tone } from '../classes'
import './EmptyState.css'

export interface EmptyStateProps {
  title: ReactNode
  body?: ReactNode
  /** What to do next (usually a NeonButton). */
  action?: ReactNode
  icon?: ReactNode
  tone?: Tone
  headingLevel?: 2 | 3 | 4
  className?: string
}

/** Nothing here yet: an invitation to act, with a blinking cursor. */
export function EmptyState({
  title,
  body,
  action,
  icon,
  tone = 'violet',
  headingLevel = 3,
  className,
}: EmptyStateProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const
  return (
    <div className={cx('empty-state', toneClass(tone), className)}>
      <span className="empty-state__icon" aria-hidden="true">
        {icon ?? <IconGhost2 />}
      </span>
      <Heading className="empty-state__title">
        {title}
        <span className="blink-cursor" aria-hidden="true" />
      </Heading>
      {body !== undefined && <p className="empty-state__body">{body}</p>}
      {action !== undefined && <div className="empty-state__action">{action}</div>}
    </div>
  )
}
