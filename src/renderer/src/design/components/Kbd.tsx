import type { ReactNode } from 'react'
import { cx } from '../classes'
import './Kbd.css'

/** A key cap, for shortcuts (Ctrl, 1…7). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <kbd className={cx('kbd', className)}>{children}</kbd>
}
