import { useId, useState, type ReactNode } from 'react'
import { cssVars, cx, toneClass, type Tone } from '../classes'
import './Slider.css'

export interface SliderMark {
  value: number
  /** A named value of the option, e.g. "normal" or "random-low". */
  label: string
}

export interface SliderProps {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  label: ReactNode
  hideLabel?: boolean
  /** Named values, offered as chips under the range. */
  marks?: readonly SliderMark[]
  /** Adds a number field to type an exact value. */
  withInput?: boolean
  hint?: ReactNode
  tone?: Tone
  disabled?: boolean
  className?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface NumberFieldProps {
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  /** Element ids that name the field. */
  labelledBy: string
  integer?: boolean
  disabled?: boolean
}

/** A number field that commits (clamped) on Enter or blur, and goes back on Escape. */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  labelledBy,
  integer,
  disabled,
}: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const parsed = Number.parseFloat(draft)
    setDraft(null)
    if (!Number.isFinite(parsed)) return
    const rounded = integer ? Math.round(parsed) : parsed
    onCommit(clamp(rounded, min ?? -Infinity, max ?? Infinity))
  }
  return (
    <span className="number-field input-frame pixel-border tone-yellow">
      <input
        className="input"
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        aria-labelledby={labelledBy}
        min={min}
        max={max}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape' && draft !== null) {
            event.preventDefault()
            setDraft(null)
          }
        }}
      />
    </span>
  )
}

/** A pixel range slider, optionally with a number field and named values. */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  hideLabel = false,
  marks,
  withInput = false,
  hint,
  tone = 'violet',
  disabled,
  className,
}: SliderProps): React.JSX.Element {
  const id = useId()
  const fill = max > min ? ((clamp(value, min, max) - min) / (max - min)) * 100 : 0
  const named = marks?.find((mark) => mark.value === value)
  return (
    <div className={cx('field slider', toneClass(tone), className)}>
      <div className="slider__head">
        <label id={`${id}-label`} htmlFor={id} className={cx('field__label', hideLabel && 'sr-only')}>
          {label}
        </label>
        {!withInput && (
          <output htmlFor={id} className="slider__value">
            {named ? named.label : value}
          </output>
        )}
      </div>
      <div className="slider__row">
        <input
          id={id}
          type="range"
          className="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-valuetext={named ? `${value} (${named.label})` : undefined}
          aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
          style={cssVars({ '--fill': `${fill}%` })}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {withInput && (
          <NumberField
            value={value}
            min={min}
            max={max}
            integer={Number.isInteger(step)}
            labelledBy={`${id}-label`}
            disabled={disabled}
            onCommit={onChange}
          />
        )}
      </div>
      {marks !== undefined && marks.length > 0 && (
        <div className="slider__marks">
          {marks.map((mark) => (
            <button
              key={mark.label}
              type="button"
              className="slider__mark"
              aria-pressed={mark.value === value}
              disabled={disabled}
              onClick={() => onChange(mark.value)}
            >
              {mark.label}
            </button>
          ))}
        </div>
      )}
      {hint !== undefined && (
        <span id={`${id}-hint`} className="field__hint">
          {hint}
        </span>
      )}
    </div>
  )
}
