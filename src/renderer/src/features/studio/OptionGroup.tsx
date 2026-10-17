// A group of options (a `# Group #` banner of the template) as a foldable card: its name, how many
// options it holds, how many the player changed and how many have a problem.
import { IconChevronDown } from '@tabler/icons-react'
import { memo, useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { Issue, OptionSchema, OptionValue } from '@shared/types'
import { Badge } from '../../design/components'
import { isModified } from './editor-ops'
import { OptionField, type DocEdit } from './OptionField'
import './OptionGroup.css'

export interface OptionGroupProps {
  id: string
  title: string
  /** A line under the title (why these options are here). */
  hint?: string
  options: readonly OptionSchema[]
  values: Record<string, OptionValue>
  issuesByKey: ReadonlyMap<string, Issue[]>
  expanded: boolean
  onToggle: (id: string) => void
  /** Options the template does not know. */
  unknown?: boolean
  onEdit: DocEdit
  onActive: (key: string) => void
}

const NO_ISSUES: Issue[] = []

export const OptionGroup = memo(function OptionGroup({
  id,
  title,
  hint,
  options,
  values,
  issuesByKey,
  expanded,
  onToggle,
  unknown = false,
  onEdit,
  onActive,
}: OptionGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const headId = useId()
  const bodyId = useId()
  const modified = options.filter((option) => isModified(option, values[option.key])).length
  const problems = options.reduce((count, option) => count + (issuesByKey.get(option.key)?.length ?? 0), 0)

  return (
    <section
      className="option-group pixel-border"
      data-expanded={expanded || undefined}
      aria-labelledby={headId}
    >
      <h2 className="option-group__heading">
        <button
          id={headId}
          type="button"
          className="option-group__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => onToggle(id)}
        >
          <IconChevronDown aria-hidden="true" className="option-group__chevron" />
          <span className="option-group__title">{title}</span>{' '}
          <span className="option-group__count">
            {t('screens.studio.options.count', { count: options.length })}
          </span>
          {modified > 0 && (
            <>
              {' '}
              <Badge tone="violet">{t('screens.studio.options.modified', { count: modified })}</Badge>
            </>
          )}
          {problems > 0 && (
            <>
              {' '}
              <Badge tone="pink">{t('screens.studio.options.problems', { count: problems })}</Badge>
            </>
          )}
        </button>
      </h2>
      <div id={bodyId} className="option-group__body" hidden={!expanded}>
        {expanded && (
          <>
            {hint !== undefined && <p className="option-group__hint">{hint}</p>}
            {options.map((option) => (
              <OptionField
                key={option.key}
                option={option}
                value={values[option.key]}
                issues={issuesByKey.get(option.key) ?? NO_ISSUES}
                unknown={unknown}
                onEdit={onEdit}
                onActive={onActive}
              />
            ))}
          </>
        )}
      </div>
    </section>
  )
})
