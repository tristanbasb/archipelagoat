import { IconX } from '@tabler/icons-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useEffectEvent, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx, toneClass, type Tone } from '../classes'
import { usePortalContainer } from '../useEffectsPrefs'
import './Modal.css'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** Small arcade label above the title. */
  eyebrow?: ReactNode
  children?: ReactNode
  /** Action buttons, right aligned. */
  footer?: ReactNode
  /** Accessible name of the close button. */
  closeLabel: string
  tone?: Tone
  size?: 'sm' | 'md' | 'lg'
  /** Escape and a click on the backdrop close the modal (default); false for a forced choice. */
  dismissible?: boolean
}

const FIELDS = 'input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'
const FOCUSABLE = `a[href], button:not(:disabled), ${FIELDS}, [tabindex]:not([tabindex="-1"])`

function focusables(root: HTMLElement, selector = FOCUSABLE): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)]
}

/** A modal dialog that switches on like a CRT: focus trapped inside, restored on close. */
export function Modal({ open, ...props }: ModalProps): React.JSX.Element {
  const container = usePortalContainer()
  return createPortal(
    <AnimatePresence>{open && <ModalWindow key="modal" {...props} />}</AnimatePresence>,
    container,
  )
}

function ModalWindow({
  onClose,
  title,
  eyebrow,
  children,
  footer,
  closeLabel,
  tone = 'violet',
  size = 'md',
  dismissible = true,
}: Omit<ModalProps, 'open'>): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const close = useEffectEvent(onClose)

  // Focus the first text field of the body, else the dialog itself (never a button, so that Enter
  // cannot confirm by accident); give focus back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (dialog) {
      const body = dialog.querySelector<HTMLElement>('.modal__body')
      const field = body ? focusables(body, FIELDS)[0] : undefined
      ;(field ?? dialog).focus()
    }
    return () => opener?.focus()
  }, [])

  useEffect(() => {
    if (!dismissible) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dismissible])

  const trapTab = (event: KeyboardEvent<HTMLDivElement>): void => {
    const dialog = dialogRef.current
    if (event.key !== 'Tab' || !dialog) return
    const items = focusables(dialog)
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) {
      event.preventDefault()
      return
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose()
      }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('modal pixel-border', toneClass(tone))}
        data-size={size}
        initial={{ opacity: 0, scaleY: 0.03, scaleX: 0.94 }}
        animate={{ opacity: 1, scaleY: 1, scaleX: 1 }}
        exit={{ opacity: 0, scaleY: 0.03, scaleX: 0.94 }}
        transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
        onKeyDown={trapTab}
      >
        <header className="modal__head">
          <div className="modal__heading">
            {eyebrow !== undefined && <span className="modal__eyebrow t-display">{eyebrow}</span>}
            <h2 id={titleId} className="modal__title">
              {title}
            </h2>
          </div>
          {dismissible && (
            <button type="button" className="modal__close" aria-label={closeLabel} onClick={onClose}>
              <IconX aria-hidden="true" />
            </button>
          )}
        </header>
        {children !== undefined && <div className="modal__body">{children}</div>}
        {footer !== undefined && <footer className="modal__foot">{footer}</footer>}
      </motion.div>
    </motion.div>
  )
}
