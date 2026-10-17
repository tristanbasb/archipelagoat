import type { ReactNode } from 'react'
import { cx } from '../design/classes'
import './ScreenHeader.css'

export interface ScreenHeaderProps {
  title: ReactNode
  /** Small arcade label above the title (STAGE 01, LIVE…). */
  eyebrow?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}

/** The heading of a screen: its one h1, under an arcade eyebrow and over a neon rule. */
export function ScreenHeader({
  title,
  eyebrow,
  subtitle,
  actions,
  className,
}: ScreenHeaderProps): React.JSX.Element {
  return (
    <header className={cx('screen-header tone-violet', className)}>
      <div className="screen-header__text">
        {eyebrow !== undefined && <span className="screen-header__eyebrow t-display">{eyebrow}</span>}
        <h1 className="screen-header__title">{title}</h1>
        {subtitle !== undefined && <p className="screen-header__subtitle">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="screen-header__actions">{actions}</div>}
    </header>
  )
}
