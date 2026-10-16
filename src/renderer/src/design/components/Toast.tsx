import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react'
import { AnimatePresence, motion } from 'motion/react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cx, toneClass, type Tone } from '../classes'
import { sfx } from '../sfx'
import { usePortalContainer } from '../useEffectsPrefs'
import './Toast.css'

export type ToastTone = 'info' | 'ok' | 'warn' | 'error'

export interface ToastOptions {
  tone?: ToastTone
  title: ReactNode
  body?: ReactNode
  action?: { label: string; onClick: () => void }
  /** Milliseconds before it goes away; 0 keeps it until closed. Default 5000. */
  duration?: number
}

export interface ToastApi {
  /** Shows a toast; returns its id. */
  push(options: ToastOptions): string
  dismiss(id: string): void
}

const DEFAULT_DURATION = 5000
const MAX_TOASTS = 4

const TONES: Record<ToastTone, { tone: Tone; icon: ReactNode }> = {
  info: { tone: 'cyan', icon: <IconInfoCircle /> },
  ok: { tone: 'green', icon: <IconCircleCheck /> },
  warn: { tone: 'yellow', icon: <IconAlertTriangle /> },
  error: { tone: 'pink', icon: <IconAlertOctagon /> },
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast() needs a <ToastProvider> above it')
  return api
}

export interface ToastProviderProps {
  /** Names the notification region. */
  label: string
  /** Accessible name of each toast's close button. */
  closeLabel: string
  children?: ReactNode
}

/** Holds the toasts and shows them in a live region at the bottom right. */
export function ToastProvider({ label, closeLabel, children }: ToastProviderProps): React.JSX.Element {
  const [toasts, setToasts] = useState<(ToastOptions & { id: string })[]>([])
  const lastId = useRef(0)
  const container = usePortalContainer()

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback((options: ToastOptions) => {
    lastId.current += 1
    const id = `toast-${lastId.current}`
    setToasts((list) => [...list, { ...options, id }].slice(-MAX_TOASTS))
    sfx.play(options.tone === 'error' ? 'error' : options.tone === 'ok' ? 'success' : 'blip')
    return id
  }, [])

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss])

  return (
    <ToastContext value={api}>
      {children}
      {createPortal(
        <section className="toast-viewport" aria-label={label} aria-live="polite">
          <AnimatePresence initial={false}>
            {toasts.map(({ id, ...toast }) => (
              <Toast key={id} {...toast} closeLabel={closeLabel} onClose={() => dismiss(id)} />
            ))}
          </AnimatePresence>
        </section>,
        container,
      )}
    </ToastContext>
  )
}

export interface ToastProps extends ToastOptions {
  onClose: () => void
  closeLabel: string
}

/** One notification. Its timer pauses while hovered or focused. */
export function Toast({
  tone = 'info',
  title,
  body,
  action,
  duration = DEFAULT_DURATION,
  onClose,
  closeLabel,
}: ToastProps): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const remaining = useRef(duration)
  const expire = useEffectEvent(onClose)

  useEffect(() => {
    if (duration <= 0 || paused) return
    const startedAt = Date.now()
    const timer = window.setTimeout(() => expire(), remaining.current)
    return () => {
      window.clearTimeout(timer)
      remaining.current -= Date.now() - startedAt
    }
  }, [duration, paused])

  const { tone: neon, icon } = TONES[tone]
  return (
    <motion.div
      layout
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx('toast pixel-border', toneClass(neon))}
      initial={{ opacity: 0, x: 48 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 48, transition: { duration: 0.16 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="toast__text">
        <p className="toast__title">{title}</p>
        {body !== undefined && <p className="toast__body">{body}</p>}
        {action && (
          <button
            type="button"
            className="toast__action"
            onClick={() => {
              action.onClick()
              onClose()
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      <button type="button" className="toast__close" aria-label={closeLabel} onClick={onClose}>
        <IconX aria-hidden="true" />
      </button>
      {duration > 0 && (
        <span
          className="toast__timer"
          aria-hidden="true"
          style={{ animationDuration: `${duration}ms`, animationPlayState: paused ? 'paused' : 'running' }}
        />
      )}
    </motion.div>
  )
}
