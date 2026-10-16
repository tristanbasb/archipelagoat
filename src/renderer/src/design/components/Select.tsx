import { IconChevronDown } from '@tabler/icons-react'
import { useId, type ReactNode } from 'react'
import { cx } from '../classes'
import './Select.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectProps<T extends string> {
  options: readonly SelectOption<T>[]
  /** null shows the placeholder. */
  value: T | null
  onChange: (value: T) => void
  label: ReactNode
  /** Keeps the label for screen readers only. */
  hideLabel?: boolean
  placeholder?: string
  hint?: ReactNode
  disabled?: boolean
  className?: string
}

/** A native select in a pixel frame (Chromium's customizable select styles its list too). */
export function Select<T extends string>({
  options,
  value,
  onChange,
  label,
  hideLabel = false,
  placeholder,
  hint,
  disabled,
  className,
}: SelectProps<T>): React.JSX.Element {
  const id = useId()
  return (
    <div className={cx('field', className)}>
      <label htmlFor={id} className={cx('field__label', hideLabel && 'sr-only')}>
        {label}
      </label>
      <div className="input-frame select-frame pixel-border tone-yellow">
        <select
          id={id}
          className="select"
          value={value ?? ''}
          disabled={disabled}
          aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
          onChange={(event) => {
            const picked = options.find((option) => option.value === event.target.value)
            if (picked) onChange(picked.value)
          }}
        >
          {placeholder !== undefined && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <IconChevronDown className="select__chevron" aria-hidden="true" />
      </div>
      {hint !== undefined && (
        <span id={`${id}-hint`} className="field__hint">
          {hint}
        </span>
      )}
    </div>
  )
}
