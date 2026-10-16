import type { ReactNode } from 'react'
import { cx, toneClass, type Tone } from '../classes'
import './StatusPill.css'

export type Status = 'ok' | 'warn' | 'error' | 'info' | 'busy' | 'idle'

const STATUS_TONE: Record<Status, Tone> = {
  ok: 'green',
  warn: 'yellow',
  error: 'pink',
  info: 'cyan',
  busy: 'violet',
  idle: 'neutral',
}

export interface StatusPillProps {
  status: Status
  label: ReactNode
  className?: string
}

/** A lit pixel and a label; the pixel pulses while busy. */
export function StatusPill({ status, label, className }: StatusPillProps): React.JSX.Element {
  return (
    <span className={cx('status-pill', toneClass(STATUS_TONE[status]), className)} data-status={status}>
      <span className="status-pill__dot" aria-hidden="true" />
      <span className="status-pill__label">{label}</span>
    </span>
  )
}
