import { AnimatePresence, motion } from 'motion/react'
import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../classes'
import { usePortalContainer } from '../useEffectsPrefs'
import './Tooltip.css'

export interface TooltipProps {
  content: ReactNode
  /** One focusable element; it gets aria-describedby while the tooltip shows. */
  children: ReactElement<{ 'aria-describedby'?: string }>
  side?: 'top' | 'bottom'
  /** Milliseconds of hover before showing. */
  delay?: number
}

const GAP = 8
const EDGE = 8

/** A short description shown on hover and keyboard focus. Escape hides it. */
export function Tooltip({ content, children, side = 'top', delay = 350 }: TooltipProps): React.JSX.Element {
  const id = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const container = usePortalContainer()

  const show = (wait: number): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (anchorRef.current) setAnchor(anchorRef.current.getBoundingClientRect())
    }, wait)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setAnchor(null)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!anchor) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setAnchor(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [anchor])

  // Keep the bubble inside the window horizontally.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current
    if (!bubble || !anchor) return
    bubble.style.marginLeft = '0px'
    const box = bubble.getBoundingClientRect()
    const overflowRight = box.right - (window.innerWidth - EDGE)
    const overflowLeft = EDGE - box.left
    if (overflowRight > 0) bubble.style.marginLeft = `${-overflowRight}px`
    else if (overflowLeft > 0) bubble.style.marginLeft = `${overflowLeft}px`
  }, [anchor])

  const describedBy = cx(children.props['aria-describedby'], anchor !== null && id) || undefined

  return (
    <>
      <span
        ref={anchorRef}
        className="tooltip-anchor"
        onPointerEnter={() => show(delay)}
        onPointerLeave={hide}
        onFocus={() => show(0)}
        onBlur={hide}
      >
        {cloneElement(children, { 'aria-describedby': describedBy })}
      </span>
      {createPortal(
        <AnimatePresence>
          {anchor && (
            <div
              key="tooltip"
              ref={bubbleRef}
              className="tooltip-position"
              data-side={side}
              style={{
                left: anchor.left + anchor.width / 2,
                top: side === 'top' ? anchor.top - GAP : anchor.bottom + GAP,
              }}
            >
              <motion.div
                id={id}
                role="tooltip"
                className="tooltip"
                initial={{ opacity: 0, y: side === 'top' ? 4 : -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                transition={{ duration: 0.14 }}
              >
                {content}
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        container,
      )}
    </>
  )
}
