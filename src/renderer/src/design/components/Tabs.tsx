import { motion } from 'motion/react'
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from '../classes'
import { sfx } from '../sfx'
import './Tabs.css'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  icon?: ReactNode
  /** A count or a short mark next to the label. */
  badge?: ReactNode
}

export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[]
  value: T
  onChange: (id: T) => void
  /** Names the tab list. */
  label: string
  /** Content of the selected tab. */
  children?: ReactNode
  className?: string
}

/** Tabs with automatic activation: arrows, Home and End move between them. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  children,
  className,
}: TabsProps<T>): React.JSX.Element {
  const id = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value),
  )
  const tabId = (index: number): string => `${id}-tab-${index}`
  const panelId = `${id}-panel`

  const activate = (index: number): void => {
    const tab = tabs[index]
    if (!tab) return
    if (tab.id !== value) {
      sfx.play('blip')
      onChange(tab.id)
    }
    buttons.current[index]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = tabs.length - 1
    const target =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (target === null) return
    event.preventDefault()
    activate(target)
  }

  return (
    <div className={cx('tabs', className)}>
      <div role="tablist" aria-label={label} className="tabs__list">
        {tabs.map((tab, index) => {
          const isSelected = index === selected
          return (
            <button
              key={tab.id}
              ref={(node) => {
                buttons.current[index] = node
              }}
              id={tabId(index)}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={isSelected ? panelId : undefined}
              tabIndex={isSelected ? 0 : -1}
              className="tabs__tab"
              onClick={() => activate(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {/* The spaces keep accessible names readable ("Installés 42"); flex layout ignores them. */}
              {tab.badge !== undefined && (
                <>
                  {' '}
                  <span className="tabs__badge">{tab.badge}</span>
                </>
              )}
              {isSelected && (
                <motion.span
                  layoutId={`${id}-bar`}
                  className="tabs__bar tone-violet"
                  transition={{ type: 'spring', stiffness: 520, damping: 42 }}
                />
              )}
            </button>
          )
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(selected)}
        tabIndex={0}
        className="tabs__panel"
      >
        {children}
      </div>
    </div>
  )
}
