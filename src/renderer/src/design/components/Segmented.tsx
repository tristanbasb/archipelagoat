import { motion } from 'motion/react'
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from '../classes'
import { sfx } from '../sfx'
import './Segmented.css'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Names the radio group. */
  label: string
  size?: 'sm' | 'md'
  className?: string
}

const NEXT_KEYS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/** A few mutually exclusive choices side by side (a radio group, arrows move the choice). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: SegmentedProps<T>): React.JSX.Element {
  const id = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex((option) => option.value === value)
  const focusable = selected === -1 ? 0 : selected

  const select = (index: number): void => {
    const option = options[index]
    if (!option) return
    if (option.value !== value) {
      sfx.play('blip')
      onChange(option.value)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = NEXT_KEYS[event.key]
    if (step === undefined) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    select(next)
    buttons.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('segmented pixel-border', className)}
      data-size={size}
    >
      {options.map((option, index) => {
        const checked = index === selected
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === focusable ? 0 : -1}
            className="segmented__option"
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {checked && (
              <motion.span
                layoutId={`${id}-thumb`}
                className="segmented__thumb tone-violet"
                transition={{ type: 'spring', stiffness: 520, damping: 40 }}
              />
            )}
            <span className="segmented__label">
              {option.icon}
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
