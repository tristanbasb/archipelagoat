import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { cx } from '../classes'
import './Terminal.css'

/** Line colors: log levels, plus Archipelago's item classes and "yourself" for the item feed. */
export type TerminalTone =
  'default' | 'dim' | 'info' | 'ok' | 'warn' | 'error' | 'progression' | 'useful' | 'trap' | 'filler' | 'self'

export interface TerminalLine {
  text: string
  tone?: TerminalTone
}

export interface TerminalProps {
  lines: readonly TerminalLine[]
  /** Title of the console; also names the log. */
  label: string
  /** Shows a command line; called with the trimmed command on Enter. */
  onCommand?: (command: string) => void
  /** Previous commands, oldest first, recalled with the up and down arrows. */
  history?: readonly string[]
  /** Accessible name of the command field. */
  inputLabel?: string
  placeholder?: string
  className?: string
}

/** How close to the bottom (px) still counts as "following" the log. */
const FOLLOW_SLACK = 12

export function Terminal({
  lines,
  label,
  onCommand,
  history = [],
  inputLabel,
  placeholder,
  className,
}: TerminalProps): React.JSX.Element {
  const labelId = useId()
  const logRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [command, setCommand] = useState('')
  // Position in `history` while browsing it, null while editing the draft.
  const [recall, setRecall] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  // Keep the newest line in view, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const log = logRef.current
    if (log && following.current) log.scrollTop = log.scrollHeight
  }, [lines])

  const onScroll = (): void => {
    const log = logRef.current
    if (log) following.current = log.scrollTop + log.clientHeight >= log.scrollHeight - FOLLOW_SLACK
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const trimmed = command.trim()
    if (!trimmed || !onCommand) return
    onCommand(trimmed)
    following.current = true
    setCommand('')
    setDraft('')
    setRecall(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowUp' && history.length > 0) {
      event.preventDefault()
      const next = recall === null ? history.length - 1 : Math.max(0, recall - 1)
      if (recall === null) setDraft(command)
      setRecall(next)
      setCommand(history[next] ?? '')
    } else if (event.key === 'ArrowDown' && recall !== null) {
      event.preventDefault()
      const next = recall + 1
      if (next < history.length) {
        setRecall(next)
        setCommand(history[next] ?? '')
      } else {
        setRecall(null)
        setCommand(draft)
      }
    }
  }

  return (
    <div className={cx('terminal pixel-border', onCommand && 'terminal--prompt', className)}>
      <div className="terminal__bar">
        <span className="terminal__lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span id={labelId} className="terminal__title">
          {label}
        </span>
      </div>
      <div
        ref={logRef}
        role="log"
        aria-labelledby={labelId}
        tabIndex={0}
        className="terminal__out"
        onScroll={onScroll}
      >
        {lines.map((line, index) => (
          <div key={index} className="terminal__line" data-tone={line.tone ?? 'default'}>
            {line.text}
          </div>
        ))}
      </div>
      {onCommand && (
        <form className="terminal__prompt" onSubmit={submit}>
          <span className="terminal__caret" aria-hidden="true" />
          <input
            className="terminal__input"
            aria-label={inputLabel}
            value={command}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setCommand(event.target.value)
              setRecall(null)
            }}
            onKeyDown={onKeyDown}
          />
        </form>
      )}
    </div>
  )
}
