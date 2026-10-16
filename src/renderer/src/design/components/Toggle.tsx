import { useId, type ReactNode } from 'react'
import { cx, toneClass, type Tone } from '../classes'
import { sfx } from '../sfx'
import './Toggle.css'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  tone?: Tone
  className?: string
}

/** An on/off switch with its label (role="switch"); the knob snaps across in pixel steps. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  tone = 'violet',
  className,
}: ToggleProps): React.JSX.Element {
  const id = useId()
  return (
    <div className={cx('toggle', disabled && 'toggle--disabled', className)}>
      <div className="toggle__text">
        <label htmlFor={id} className="toggle__label">
          {label}
        </label>
        {description !== undefined && (
          <span id={`${id}-description`} className="toggle__description">
            {description}
          </span>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description !== undefined ? `${id}-description` : undefined}
        disabled={disabled}
        className={cx('toggle__switch pixel-border', toneClass(tone))}
        onClick={() => {
          sfx.play('blip')
          onChange(!checked)
        }}
      >
        <span className="toggle__knob" aria-hidden="true" />
      </button>
    </div>
  )
}
