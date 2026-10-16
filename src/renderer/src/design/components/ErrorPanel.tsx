import { IconAlertOctagon } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { cx } from '../classes'
import './ErrorPanel.css'

export interface ErrorPanelProps {
  /** What went wrong, in plain words. */
  title: ReactNode
  /** How to fix it. */
  body?: ReactNode
  /** Technical detail (a log excerpt), folded under `detailLabel`. */
  detail?: string
  detailLabel?: string
  actions?: ReactNode
  headingLevel?: 2 | 3 | 4
  className?: string
}

/** An error, announced as an alert, with its fix and an optional technical detail. */
export function ErrorPanel({
  title,
  body,
  detail,
  detailLabel,
  actions,
  headingLevel = 3,
  className,
}: ErrorPanelProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const
  return (
    <div role="alert" className={cx('error-panel pixel-border tone-pink', className)}>
      <span className="error-panel__icon" aria-hidden="true">
        <IconAlertOctagon />
      </span>
      <div className="error-panel__main">
        <Heading className="error-panel__title">{title}</Heading>
        {body !== undefined && <p className="error-panel__body">{body}</p>}
        {detail !== undefined && detailLabel !== undefined && (
          <details className="error-panel__detail">
            <summary>{detailLabel}</summary>
            <pre>{detail}</pre>
          </details>
        )}
        {actions !== undefined && <div className="error-panel__actions">{actions}</div>}
      </div>
    </div>
  )
}
