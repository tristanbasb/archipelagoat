import { IconChevronDown, IconSearch } from '@tabler/icons-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../classes'
import { sfx } from '../sfx'
import { usePortalContainer } from '../useEffectsPrefs'
import './Combobox.css'

export interface ComboboxOption {
  value: string
  label: string
  /** Secondary text at the right of the option. */
  hint?: string
  /** A decorative visual before the label (a cover, an icon). */
  icon?: ReactNode
}

export interface ComboboxProps {
  options: readonly ComboboxOption[]
  value: string | null
  onChange: (value: string) => void
  label: ReactNode
  /** Shown in the list when nothing matches the search. */
  emptyLabel: string
  placeholder?: string
  hideLabel?: boolean
  className?: string
}

/** Lower case, without accents: "Pokémon" matches "pokemon". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/** The label with the matched part highlighted, when folding kept the length. */
function highlight(label: string, query: string): ReactNode {
  const folded = fold(label)
  const at = query ? folded.indexOf(fold(query)) : -1
  if (at < 0 || folded.length !== label.length) return label
  const end = at + fold(query).length
  return (
    <>
      {label.slice(0, at)}
      <mark className="combobox__match">{label.slice(at, end)}</mark>
      {label.slice(end)}
    </>
  )
}

const POPUP_GAP = 6
const POPUP_MAX = 280

/** Fixed position of the list under the field, or above it when the window lacks room below. */
function popupStyle(anchor: DOMRect): CSSProperties {
  const below = window.innerHeight - anchor.bottom
  const above = anchor.top
  const placeAbove = below < POPUP_MAX + POPUP_GAP && above > below
  return {
    left: anchor.left,
    width: anchor.width,
    ...(placeAbove
      ? { bottom: window.innerHeight - anchor.top + POPUP_GAP }
      : { top: anchor.bottom + POPUP_GAP }),
  }
}

/**
 * A searchable list: type to filter, arrows to move, Enter to pick, Escape to close. The list is
 * portalled (fixed position) so that no panel can cover or clip it.
 */
export function Combobox({
  options,
  value,
  onChange,
  label,
  emptyLabel,
  placeholder,
  hideLabel = false,
  className,
}: ComboboxProps): React.JSX.Element {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const container = usePortalContainer()
  const selected = options.find((option) => option.value === value)

  const matches = useMemo(() => {
    const folded = fold(query.trim())
    return folded ? options.filter((option) => fold(option.label).includes(folded)) : options
  }, [options, query])

  const activeOption = open ? matches[active] : undefined
  const optionId = (index: number): string => `${id}-option-${index}`

  // Keep the active option visible while moving with the arrows.
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active, id])

  const measure = (): void => {
    if (anchorRef.current) setAnchor(anchorRef.current.getBoundingClientRect())
  }

  // Follow the field while the list is open.
  useEffect(() => {
    if (!open) return
    const follow = (): void => {
      if (anchorRef.current) setAnchor(anchorRef.current.getBoundingClientRect())
    }
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open])

  const openList = (): void => {
    if (open) return
    measure()
    setOpen(true)
    setQuery('')
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    )
  }

  const pick = (option: ComboboxOption): void => {
    sfx.play('blip')
    onChange(option.value)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) openList()
        else setActive((index) => Math.min(index + 1, matches.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        if (open) setActive((index) => Math.max(index - 1, 0))
        break
      case 'Enter':
        if (open && activeOption) {
          event.preventDefault()
          pick(activeOption)
        }
        break
      case 'Escape':
        if (open) {
          // Handled here: an enclosing modal must not close too.
          event.preventDefault()
          setOpen(false)
          setQuery('')
        }
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div className={cx('field combobox', className)}>
      <label id={`${id}-label`} htmlFor={id} className={cx('field__label', hideLabel && 'sr-only')}>
        {label}
      </label>
      <div ref={anchorRef} className="combobox__anchor">
        <div className="input-frame pixel-border tone-yellow">
          <IconSearch className="combobox__search" aria-hidden="true" />
          <input
            id={id}
            className="input"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={open ? query : (selected?.label ?? '')}
            placeholder={open && selected ? selected.label : placeholder}
            onFocus={openList}
            onClick={openList}
            onBlur={() => setOpen(false)}
            onChange={(event) => {
              if (!open) measure()
              setQuery(event.target.value)
              setActive(0)
              setOpen(true)
            }}
            onKeyDown={onKeyDown}
          />
          <IconChevronDown className="combobox__chevron" aria-hidden="true" data-open={open || undefined} />
        </div>
        {open &&
          createPortal(
            <div
              className="combobox__popup pixel-border"
              style={anchor ? popupStyle(anchor) : undefined}
              onMouseDown={(event) => event.preventDefault()}
            >
              <ul id={listId} role="listbox" aria-labelledby={`${id}-label`} className="combobox__list">
                {matches.map((option, index) => (
                  <li
                    key={option.value}
                    id={optionId(index)}
                    role="option"
                    aria-selected={option.value === value}
                    data-active={index === active || undefined}
                    className="combobox__option"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(option)}
                  >
                    <span className="combobox__cursor" aria-hidden="true" />
                    {option.icon !== undefined && (
                      <span className="combobox__icon" aria-hidden="true">
                        {option.icon}
                      </span>
                    )}
                    <span className="combobox__label">{highlight(option.label, query.trim())}</span>
                    {option.hint !== undefined && <span className="combobox__hint">{option.hint}</span>}
                  </li>
                ))}
              </ul>
              {matches.length === 0 && <p className="combobox__empty">{emptyLabel}</p>}
            </div>,
            container,
          )}
      </div>
    </div>
  )
}
