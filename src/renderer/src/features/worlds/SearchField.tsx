// The search box of the worlds lists: a pixel frame, a magnifier and a button that clears it.
import { IconSearch, IconX } from '@tabler/icons-react'
import { useId, useRef } from 'react'
import { cx } from '../../design/classes'

export interface SearchFieldProps {
  /** Accessible name (the placeholder shows instead). */
  label: string
  placeholder?: string
  clearLabel: string
  value: string
  onChange: (value: string) => void
  className?: string
}

export function SearchField({
  label,
  placeholder,
  clearLabel,
  value,
  onChange,
  className,
}: SearchFieldProps): React.JSX.Element {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className={cx('field worlds-search', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="input-frame pixel-border tone-yellow">
        <IconSearch className="worlds-search__icon" aria-hidden="true" />
        <input
          ref={inputRef}
          id={id}
          type="search"
          className="input"
          placeholder={placeholder}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        {value !== '' && (
          <button
            type="button"
            className="worlds-search__clear"
            aria-label={clearLabel}
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
          >
            <IconX aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
