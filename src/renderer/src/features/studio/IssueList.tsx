// The live validation of the doc on screen: a summary, then each issue, translated, with a link to
// the option (or the name, or the game) it is about.
import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconCircleCheck,
  IconCornerDownRight,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import type { Issue } from '@shared/types'
import { PixelPanel, Spinner, type Tone } from '../../design/components'
import { issueTarget, type IssueTarget } from './editor-ops'
import './IssueList.css'

/** An issue's text, and what it found when the validation says (the value, the range, why). */
export function IssueText({ issue }: { issue: Issue }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const params = issue.params ?? {}
  const reasonKey = `screens.studio.check.reasons.${String(params.reason)}`
  const details = [
    params.value !== undefined && t('screens.studio.check.value', { value: params.value }),
    params.min !== undefined && params.max !== undefined && t('screens.studio.check.range', params),
    params.reason !== undefined && i18n.exists(reasonKey) && t(reasonKey),
  ].filter((detail): detail is string => typeof detail === 'string')
  return (
    <>
      <span className="issue-text">{t(`issues.${issue.code}`, params)}</span>
      {details.length > 0 && (
        <>
          {' '}
          <span className="issue-detail">{details.join(', ')}</span>
        </>
      )}
    </>
  )
}

export interface IssueListProps {
  issues: readonly Issue[]
  game: string
  /** Validation is running for a newer change. */
  pending: boolean
  /** A validation has finished at least once. */
  checked: boolean
  /** The label of what an issue is about (an option's name, the player name…). */
  labelOf: (target: IssueTarget) => string
  onReveal: (target: IssueTarget) => void
}

export function IssueList({
  issues,
  game,
  pending,
  checked,
  labelOf,
  onReveal,
}: IssueListProps): React.JSX.Element {
  const { t } = useTranslation()
  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.length - errors
  const tone: Tone = errors > 0 ? 'pink' : warnings > 0 ? 'yellow' : 'green'
  const summary =
    issues.length === 0
      ? t('screens.studio.check.ok')
      : [
          errors > 0 && t('screens.studio.check.errors', { count: errors }),
          warnings > 0 && t('screens.studio.check.warnings', { count: warnings }),
        ]
          .filter(Boolean)
          .join(' · ')

  return (
    <PixelPanel
      tone={checked ? tone : 'neutral'}
      padding="sm"
      eyebrow={t('screens.studio.check.eyebrow')}
      title={t('screens.studio.check.title')}
      className="issue-panel"
      headingLevel={2}
      actions={pending ? <Spinner size="sm" label={t('screens.studio.check.pending')} /> : undefined}
    >
      <p className="issue-panel__summary" data-tone={checked ? tone : undefined} aria-live="polite">
        {issues.length === 0 && checked && <IconCircleCheck aria-hidden="true" />}
        <span>{checked ? summary : t('screens.studio.check.pending')}</span>
      </p>
      {issues.length > 0 && (
        <ul className="issue-list">
          {issues.map((issue, index) => {
            const target = issueTarget(issue, game)
            const severity = t(`screens.studio.check.${issue.severity}`)
            const content = (
              <>
                <span className="issue-list__icon" aria-hidden="true">
                  {issue.severity === 'error' ? <IconAlertOctagon /> : <IconAlertTriangle />}
                </span>
                <span className="sr-only">{severity} </span>
                <span className="issue-list__body">
                  <span className="issue-list__where">
                    {target ? labelOf(target) : t('screens.studio.check.general')}
                  </span>{' '}
                  <IssueText issue={issue} />
                </span>
                {target && <IconCornerDownRight aria-hidden="true" className="issue-list__go" />}
              </>
            )
            return (
              <li key={index} className="issue-list__item" data-severity={issue.severity}>
                {target ? (
                  <button type="button" className="issue-list__entry" onClick={() => onReveal(target)}>
                    {content}
                  </button>
                ) : (
                  <div className="issue-list__entry">{content}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </PixelPanel>
  )
}
