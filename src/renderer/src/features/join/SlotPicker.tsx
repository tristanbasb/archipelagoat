// The players of a room as an arcade "select player" grid (JoinPlan.slots of the first
// join:prepare). Picking one prepares that slot.
import { IconChevronRight, IconSearch, IconUsersGroup } from '@tabler/icons-react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, EmptyState, PixelPanel, Spinner } from '../../design/components'
import { STEP_FOCUS_PANEL } from './step-focus'
import './SlotPicker.css'

export interface SlotPickerProps {
  slots: readonly { name: string; game: string }[]
  /** The slot being prepared: the grid waits for it. */
  pending: string | null
  /** The slot picked the last time this room was joined. */
  lastSlot: string | null
  onPick: (name: string) => void
}

/** From this many slots on, a search field narrows the grid. */
const SEARCH_FROM = 9

/** Lower case, without accents: "pokemon" finds "Pokémon". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export function SlotPicker({ slots, pending, lastSlot, onPick }: SlotPickerProps): React.JSX.Element {
  const { t } = useTranslation()
  const searchId = useId()
  const [query, setQuery] = useState('')

  // Slot numbers follow the room's order (P1, P2…), whatever the search keeps.
  const shown = useMemo(() => {
    const numbered = slots.map((slot, index) => ({ ...slot, number: index + 1 }))
    const wanted = fold(query.trim())
    if (!wanted) return numbered
    return numbered.filter((slot) => fold(`${slot.name} ${slot.game}`).includes(wanted))
  }, [slots, query])

  return (
    <PixelPanel
      {...STEP_FOCUS_PANEL}
      className="slot-picker"
      tone="cyan"
      eyebrow={t('screens.join.slots.eyebrow')}
      title={t('screens.join.slots.title')}
    >
      {slots.length === 0 ? (
        <EmptyState
          tone="cyan"
          icon={<IconUsersGroup />}
          title={t('screens.join.slots.emptyTitle')}
          body={t('screens.join.slots.emptyBody')}
        />
      ) : (
        <>
          <div className="slot-picker__top">
            <p className="slot-picker__subtitle">
              {t('screens.join.slots.subtitle', { count: slots.length })}
            </p>
            {slots.length >= SEARCH_FROM && (
              <div className="slot-picker__search">
                <label htmlFor={searchId} className="sr-only">
                  {t('screens.join.slots.filter')}
                </label>
                <span className="input-frame pixel-border tone-cyan">
                  <IconSearch aria-hidden="true" />
                  <input
                    id={searchId}
                    className="input"
                    type="search"
                    value={query}
                    placeholder={t('screens.join.slots.filter')}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </span>
              </div>
            )}
          </div>
          <ul className="slot-picker__grid">
            {shown.map((slot) => {
              const waiting = pending === slot.name
              return (
                <li key={slot.name}>
                  <button
                    type="button"
                    className="slot-card pixel-border tone-cyan"
                    data-pending={waiting || undefined}
                    data-last={lastSlot === slot.name || undefined}
                    disabled={pending !== null}
                    aria-busy={waiting || undefined}
                    onClick={() => onPick(slot.name)}
                  >
                    <span className="slot-card__number t-display" aria-hidden="true">
                      {`P${slot.number}`}
                    </span>
                    <span className="slot-card__text">
                      <span className="slot-card__name">{slot.name}</span>
                      <span className="slot-card__game">{slot.game}</span>
                    </span>
                    {lastSlot === slot.name && (
                      <Badge tone="yellow" className="slot-card__last">
                        {t('screens.join.slots.last')}
                      </Badge>
                    )}
                    <span className="slot-card__go" aria-hidden="true">
                      {waiting ? <Spinner size="sm" /> : <IconChevronRight />}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {shown.length === 0 && <p className="slot-picker__none">{t('screens.join.slots.noMatch')}</p>}
          <p role="status" className="sr-only">
            {pending !== null ? t('screens.join.slots.loading', { name: pending }) : ''}
          </p>
        </>
      )}
    </PixelPanel>
  )
}
