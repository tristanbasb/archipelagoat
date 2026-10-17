// Every option of the doc on screen, by group: the template's groups first, then the options of the
// file the template does not know (kept, edited as YAML). A filter narrows them down; `reveal`
// opens an option's group and brings its card into view (validation links use it).
import { IconChevronsDown, IconChevronsUp, IconSearch, IconX } from '@tabler/icons-react'
import { useCallback, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { GameSchema, Issue, OptionSchema, OptionValue } from '@shared/types'
import { humanize } from './editor-ops'
import { OptionGroup } from './OptionGroup'
import { optionDomId, type DocEdit } from './OptionField'
import './OptionList.css'

/** Archipelago folds this group by default (`start_collapsed`, Options.py). */
const FOLDED_GROUPS: ReadonlySet<string> = new Set(['Item & Location Options'])
/** Translated names of the groups every world has. */
const KNOWN_GROUPS: Record<string, string> = { 'Game Options': 'game', 'Item & Location Options': 'items' }
const UNKNOWN_GROUP = '\u0000unknown'

interface GroupView {
  id: string
  title: string
  hint?: string
  options: OptionSchema[]
  unknown: boolean
}

export interface OptionListHandle {
  /** Opens the option's group, clears a filter hiding it; returns its card. */
  reveal(key: string): HTMLElement | null
  focusFilter(): void
}

export interface OptionListProps {
  ref?: Ref<OptionListHandle>
  schema: GameSchema | undefined
  values: Record<string, OptionValue>
  issuesByKey: ReadonlyMap<string, Issue[]>
  onEdit: DocEdit
  onActive: (key: string) => void
}

/** An option the template does not know: any YAML. */
const looseOption = (key: string): OptionSchema => ({
  key,
  group: UNKNOWN_GROUP,
  doc: '',
  kind: 'free',
  default: null,
  choices: [],
  range: null,
  specialNames: {},
  confidence: 'inferred',
})

/** Lower case, without accents: "Pokémon" matches "pokemon". */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

export function OptionList({
  ref,
  schema,
  values,
  issuesByKey,
  onEdit,
  onActive,
}: OptionListProps): React.JSX.Element {
  const { t } = useTranslation()
  const filterId = useId()
  const filterRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(FOLDED_GROUPS)

  // The keys of the file, joined: the groups only change when an option comes or goes.
  const keys = Object.keys(values).join('\u0000')
  const groups = useMemo((): GroupView[] => {
    const known = new Set(schema?.groups.flatMap((group) => group.options.map((option) => option.key)))
    const views: GroupView[] = (schema?.groups ?? []).map((group) => {
      const id = KNOWN_GROUPS[group.name]
      return {
        id: group.name,
        title: id ? t(`screens.studio.options.groups.${id}`) : group.name,
        options: group.options,
        unknown: false,
      }
    })
    const loose = (keys === '' ? [] : keys.split('\u0000')).filter((key) => !known.has(key)).map(looseOption)
    if (loose.length > 0) {
      views.push({
        id: UNKNOWN_GROUP,
        title: t(schema ? 'screens.studio.options.groups.unknown' : 'screens.studio.options.groups.file'),
        hint: t(schema ? 'screens.studio.options.unknownHint' : 'screens.studio.options.fileHint'),
        options: loose,
        unknown: true,
      })
    }
    return views
  }, [schema, keys, t])

  const folded = fold(query.trim())
  const shown = useMemo(
    () =>
      folded === ''
        ? groups
        : groups
            .map((group) => ({
              ...group,
              options: group.options.filter((option) =>
                [option.key, humanize(option.key), option.doc].some((text) => fold(text).includes(folded)),
              ),
            }))
            .filter((group) => group.options.length > 0),
    [groups, folded],
  )

  useImperativeHandle(
    ref,
    () => ({
      reveal(key) {
        const group = groups.find((view) => view.options.some((option) => option.key === key))
        flushSync(() => {
          setQuery('')
          if (group) setCollapsed((current) => new Set([...current].filter((id) => id !== group.id)))
        })
        return document.getElementById(optionDomId(key))
      },
      focusFilter() {
        filterRef.current?.focus()
      },
    }),
    [groups],
  )

  const toggle = useCallback(
    (id: string): void =>
      setCollapsed((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [],
  )
  const allExpanded = groups.every((group) => !collapsed.has(group.id))

  return (
    <div className="option-list">
      <div className="option-list__toolbar">
        <div className="field option-list__filter">
          <label htmlFor={filterId} className="sr-only">
            {t('screens.studio.options.filter')}
          </label>
          <div className="input-frame pixel-border tone-yellow">
            <IconSearch aria-hidden="true" className="option-list__search" />
            <input
              ref={filterRef}
              id={filterId}
              type="search"
              className="input"
              value={query}
              placeholder={t('screens.studio.options.filterPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query !== '') {
                  event.preventDefault()
                  setQuery('')
                }
              }}
            />
            {query !== '' && (
              <button
                type="button"
                className="option-list__clear"
                aria-label={t('screens.studio.options.clearFilter')}
                onClick={() => {
                  setQuery('')
                  filterRef.current?.focus()
                }}
              >
                <IconX aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        {folded === '' && groups.length > 1 && (
          <button
            type="button"
            className="option-list__fold"
            onClick={() => setCollapsed(allExpanded ? new Set(groups.map((group) => group.id)) : new Set())}
          >
            {allExpanded ? <IconChevronsUp aria-hidden="true" /> : <IconChevronsDown aria-hidden="true" />}
            {allExpanded ? t('screens.studio.options.collapseAll') : t('screens.studio.options.expandAll')}
          </button>
        )}
      </div>

      {shown.length === 0 && folded !== '' && (
        <p className="option-list__none">{t('screens.studio.options.noMatch', { query: query.trim() })}</p>
      )}
      {shown.map((group) => (
        <OptionGroup
          key={group.id}
          id={group.id}
          title={group.title}
          hint={group.hint}
          options={group.options}
          values={values}
          issuesByKey={issuesByKey}
          expanded={folded !== '' || !collapsed.has(group.id)}
          onToggle={toggle}
          unknown={group.unknown}
          onEdit={onEdit}
          onActive={onActive}
        />
      ))}
    </div>
  )
}
