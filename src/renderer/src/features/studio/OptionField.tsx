// One option of the game section, as a card: its name and doc, the control its kind needs (switch,
// segmented or list, slider with special names, YAML block), the simple / weighted mode, a random
// pick and a reset, and the validation issues about it.
import { IconArrowBackUp, IconChevronDown, IconDice5, IconInfoCircle } from '@tabler/icons-react'
import { memo, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { stringify } from 'yaml'
import { setOptionValue } from '@shared/studio-model'
import type { EditorDoc, Issue, OptionSchema, OptionValue } from '@shared/types'
import { Badge, Segmented, Select, Slider, Toggle } from '../../design/components'
import { cx } from '../../design/classes'
import {
  editorMode,
  humanize,
  isModified,
  isRandom,
  isRawKind,
  randomize,
  RANGE_RANDOMS,
  rangeNumber,
  resetOption,
  simpleValue,
  toggleState,
  toSimple,
  toWeighted,
} from './editor-ops'
import { IssueText } from './IssueList'
import { WeightedField } from './WeightedField'
import './OptionField.css'

export type DocEdit = (change: (doc: EditorDoc) => EditorDoc) => void

export interface OptionFieldProps {
  option: OptionSchema
  value: OptionValue | undefined
  issues: readonly Issue[]
  /** The option is not in the game's template: kept and edited as YAML. */
  unknown?: boolean
  onEdit: DocEdit
  /** The option was focused: the preview shows where it is. */
  onActive: (key: string) => void
}

/** Segmented control up to this many choices, a list above. */
const MAX_SEGMENTS = 4

/** The element id of an option's card, which issue links scroll to. */
export const optionDomId = (key: string): string => `studio-option-${key}`

/** `**bold**` in option docs, as Archipelago writes them. */
function richText(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .map((part, index) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part,
    )
}

/** The doc's first paragraph, and whether there is more. */
function docSummary(doc: string): { summary: string; more: boolean } {
  const [first = '', ...rest] = doc.trim().split(/\n\s*\n/)
  return { summary: first.replace(/\s*\n\s*/g, ' '), more: rest.some((part) => part.trim() !== '') }
}

/** The YAML a raw editor starts from. */
function rawText(value: OptionValue | undefined, fallback: unknown): string {
  if (value?.mode === 'raw') return value.yaml
  const data = value === undefined ? fallback : value.mode === 'weighted' ? value.weights : value.value
  if (data === null || data === undefined) return ''
  return stringify(data, { version: '1.1' }).replace(/\n$/, '')
}

const display = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

export const OptionField = memo(function OptionField({
  option,
  value,
  issues,
  unknown = false,
  onEdit,
  onActive,
}: OptionFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const [docOpen, setDocOpen] = useState(false)
  const { key } = option
  const title = humanize(key)
  const mode = editorMode(option, value)
  const weightable = !isRawKind(option)
  const current = simpleValue(option, value)
  const random = mode === 'simple' && isRandom(option, current)
  const modified = isModified(option, value)
  const errors = issues.some((issue) => issue.severity === 'error')
  const { summary, more } = docSummary(option.doc)

  const set = (next: unknown): void =>
    onEdit((doc) => setOptionValue(doc, key, { mode: 'value', value: next }))

  let control: ReactNode
  if (mode === 'weighted' && value?.mode === 'weighted') {
    control = <WeightedField option={option} title={title} weights={value.weights} onEdit={onEdit} />
  } else if (mode === 'raw') {
    control = (
      <RawControl
        option={option}
        labelledBy={titleId}
        text={rawText(value, option.default)}
        locked={weightable}
        onText={(yaml) => onEdit((doc) => setOptionValue(doc, key, { mode: 'raw', yaml }))}
        onBack={() => onEdit((doc) => resetOption(option, doc))}
      />
    )
  } else if (option.kind === 'toggle') {
    control = <ToggleControl title={title} value={current} onChange={set} />
  } else if (option.kind === 'range' || option.kind === 'named-range') {
    control = <RangeControl option={option} title={title} value={current} onChange={set} />
  } else if (option.kind === 'text-choice' && option.choices.length === 0) {
    control = <TextControl option={option} labelledBy={titleId} value={current} onChange={set} />
  } else if (option.kind === 'text-choice') {
    control = (
      <div className="option-text-choice">
        <ChoiceControl option={option} title={title} value={current} onChange={set} ownText />
        <OwnTextControl
          option={option}
          title={title}
          value={current}
          onChange={set}
          onClear={() => onEdit((doc) => resetOption(option, doc))}
        />
      </div>
    )
  } else {
    control = <ChoiceControl option={option} title={title} value={current} onChange={set} />
  }

  return (
    <section
      id={optionDomId(key)}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="option-field"
      data-modified={modified || undefined}
      data-error={errors || undefined}
      data-warning={(!errors && issues.length > 0) || undefined}
      onFocus={() => onActive(key)}
    >
      <header className="option-field__head">
        <div className="option-field__heading">
          <h3 id={titleId} className="option-field__title">
            {title}
          </h3>
          <code className="option-field__key">{key}</code>
          {unknown && (
            <Badge tone="yellow" outline>
              {t('screens.studio.option.unknown')}
            </Badge>
          )}
          {value === undefined && !unknown && (
            <Badge tone="neutral" outline>
              {t('screens.studio.option.default')}
            </Badge>
          )}
          {modified && value !== undefined && !unknown && (
            <Badge tone="violet">{t('screens.studio.option.modified')}</Badge>
          )}
        </div>
        <div className="option-field__tools">
          {weightable && mode !== 'raw' && (
            <Segmented
              size="sm"
              label={t('screens.studio.option.mode', { option: title })}
              value={mode === 'weighted' ? 'weighted' : 'simple'}
              onChange={(next) =>
                onEdit((doc) => (next === 'weighted' ? toWeighted(option, doc) : toSimple(option, doc)))
              }
              options={[
                { value: 'simple', label: t('screens.studio.option.simple') },
                { value: 'weighted', label: t('screens.studio.option.weighted') },
              ]}
            />
          )}
          {weightable && (
            <button
              type="button"
              className="icon-tool"
              data-tone="yellow"
              aria-label={t('screens.studio.option.random', { option: title })}
              aria-pressed={random}
              title={t('screens.studio.option.random', { option: title })}
              onClick={() => onEdit((doc) => randomize(doc, key))}
            >
              <IconDice5 aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="icon-tool"
            aria-label={t('screens.studio.option.reset', { option: title })}
            title={t('screens.studio.option.reset', { option: title })}
            disabled={value === undefined || (!modified && !unknown)}
            onClick={() => onEdit((doc) => resetOption(option, doc))}
          >
            <IconArrowBackUp aria-hidden="true" />
          </button>
        </div>
      </header>

      {summary !== '' && (
        <div className="option-field__doc">
          <p className={cx('option-field__summary', docOpen && 'option-field__summary--open')}>
            {richText(docOpen ? option.doc.trim() : summary)}
          </p>
          {more && (
            <button
              type="button"
              className="option-field__more"
              aria-expanded={docOpen}
              aria-label={t('screens.studio.option.info', { option: title })}
              onClick={() => setDocOpen((open) => !open)}
            >
              <IconInfoCircle aria-hidden="true" />
              <IconChevronDown aria-hidden="true" className="option-field__chevron" />
            </button>
          )}
        </div>
      )}

      {random && <RandomBanner option={option} title={title} value={current} onChange={set} />}
      <div className="option-field__control" data-dimmed={random || undefined}>
        {control}
      </div>

      {issues.length > 0 && (
        <ul className="option-field__issues">
          {issues.map((issue, index) => (
            <li key={index} className="option-field__issue" data-severity={issue.severity}>
              <IssueText issue={issue} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
})

// --- controls --------------------------------------------------------------------------------------

interface ControlProps {
  title: string
  value: unknown
  onChange: (value: unknown) => void
}

function ToggleControl({ title, value, onChange }: ControlProps): React.JSX.Element {
  const { t } = useTranslation()
  const on = toggleState(value) === true
  return (
    <Toggle
      checked={on}
      onChange={onChange}
      className="option-toggle"
      label={
        <>
          <span className="sr-only">{title}</span>
          <span aria-hidden="true" className="option-toggle__state" data-on={on || undefined}>
            {on ? t('screens.studio.option.on') : t('screens.studio.option.off')}
          </span>
        </>
      }
    />
  )
}

/** The choice of `choices` that `value` names (case aside), or null. */
function pickedChoice(option: OptionSchema, value: unknown): string | null {
  const text = typeof value === 'string' ? value.toLowerCase() : String(value)
  return option.choices.find((choice) => choice.toLowerCase() === text) ?? null
}

function ChoiceControl({
  option,
  title,
  value,
  onChange,
  ownText = false,
}: ControlProps & {
  option: OptionSchema
  /** A text field next to it shows a value outside the choices (TextChoice). */
  ownText?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const picked = pickedChoice(option, value)
  const outside =
    !ownText && picked === null && value !== null && value !== undefined && !isRandom(option, value)
  if (option.choices.length <= MAX_SEGMENTS) {
    return (
      <div className="option-choice">
        <Segmented
          label={title}
          value={picked ?? ''}
          onChange={onChange}
          options={option.choices.map((choice) => ({ value: choice, label: humanize(choice) }))}
        />
        {outside && (
          <p className="option-field__note">
            {t('screens.studio.option.current', { value: display(value) })}
          </p>
        )}
      </div>
    )
  }
  const current = outside ? display(value) : null
  return (
    <Select
      label={title}
      hideLabel
      className="option-select"
      value={picked ?? current}
      placeholder={picked === null && current === null ? t('screens.studio.option.otherValue') : undefined}
      onChange={(next) => {
        if (next !== current) onChange(next)
      }}
      options={[
        ...option.choices.map((choice) => ({ value: choice, label: humanize(choice) })),
        ...(current === null
          ? []
          : [{ value: current, label: t('screens.studio.option.current', { value: current }) }]),
      ]}
    />
  )
}

function TextControl({
  option,
  labelledBy,
  value,
  onChange,
}: {
  option: OptionSchema
  labelledBy: string
  value: unknown
  onChange: (value: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const listId = useId()
  const suggestions = [
    ...new Set([...option.choices, ...(typeof option.default === 'string' ? [option.default] : [])]),
  ]
  return (
    <div className="field option-text">
      <div className="input-frame pixel-border tone-yellow">
        <input
          className="input"
          aria-labelledby={labelledBy}
          aria-describedby={`${listId}-hint`}
          list={listId}
          spellCheck={false}
          autoComplete="off"
          value={value === null || value === undefined ? '' : display(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <datalist id={listId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
      <span id={`${listId}-hint`} className="field__hint">
        {t('screens.studio.option.textHint')}
      </span>
    </div>
  )
}

/**
 * The text of one's own of a TextChoice, beside its choices: it shows a value that is not a choice,
 * and stays empty while a choice is picked (unless that choice is what one is typing). Emptied, the
 * option goes back to its default.
 */
function OwnTextControl({
  option,
  title,
  value,
  onChange,
  onClear,
}: ControlProps & { option: OptionSchema; onClear: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const text = value === null || value === undefined ? '' : display(value)
  const shown = pickedChoice(option, value) === null || typed.toLowerCase() === text.toLowerCase() ? text : ''
  return (
    <div className="input-frame pixel-border tone-yellow option-own-text">
      <input
        className="input"
        aria-label={t('screens.studio.option.ownText', { option: title })}
        placeholder={t('screens.studio.option.ownTextPlaceholder')}
        spellCheck={false}
        autoComplete="off"
        value={shown}
        onChange={(event) => {
          const next = event.target.value
          setTyped(next)
          if (next === '') onClear()
          else onChange(next)
        }}
      />
    </div>
  )
}

function RangeControl({
  option,
  title,
  value,
  onChange,
}: ControlProps & { option: OptionSchema }): React.JSX.Element {
  const number = rangeNumber(option, value) ?? rangeNumber(option, option.default)
  const range = option.range ?? { min: Math.min(0, number ?? 0), max: Math.max(100, number ?? 100) }
  const marks = Object.entries(option.specialNames).map(([name, mark]) => ({ value: mark, label: name }))
  return (
    <Slider
      label={title}
      hideLabel
      min={range.min}
      max={range.max}
      value={number ?? range.min}
      withInput
      marks={marks}
      onChange={onChange}
      className="option-range"
    />
  )
}

/** A random value: what it means, and for a range, which kind of random. */
function RandomBanner({
  option,
  title,
  value,
  onChange,
}: ControlProps & { option: OptionSchema }): React.JSX.Element {
  const { t } = useTranslation()
  const isRange = option.kind === 'range' || option.kind === 'named-range'
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const kind = (RANGE_RANDOMS as readonly string[]).includes(text) ? text : ''
  return (
    <div className="option-random tone-yellow">
      <IconDice5 aria-hidden="true" className="option-random__icon" />
      <div className="option-random__text">
        <strong>{t('screens.studio.option.randomTitle')}</strong>
        <span>{t('screens.studio.option.randomBody')}</span>
        {isRange && kind === '' && <code>{display(value)}</code>}
      </div>
      {isRange && (
        <Segmented
          size="sm"
          label={t('screens.studio.option.randomKinds', { option: title })}
          value={kind}
          onChange={onChange}
          options={RANGE_RANDOMS.map((name) => ({
            value: name,
            label: t(`screens.studio.option.randomValues.${name}`),
          }))}
        />
      )}
    </div>
  )
}

function RawControl({
  option,
  labelledBy,
  text,
  locked,
  onText,
  onBack,
}: {
  option: OptionSchema
  labelledBy: string
  text: string
  /** A simple option whose value only YAML can hold. */
  locked: boolean
  onText: (yaml: string) => void
  onBack: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const hintId = useId()
  const rows = Math.min(14, Math.max(3, text.split('\n').length + 1))
  return (
    <div className="option-raw">
      <div className="option-raw__frame pixel-border">
        <textarea
          className="option-raw__input"
          aria-labelledby={labelledBy}
          aria-describedby={hintId}
          spellCheck={false}
          autoComplete="off"
          rows={rows}
          value={text}
          onChange={(event) => onText(event.target.value)}
          data-kind={option.kind}
        />
      </div>
      <p id={hintId} className="field__hint">
        {locked ? t('screens.studio.option.rawLocked') : t('screens.studio.option.rawHint')}
      </p>
      {locked && (
        <button type="button" className="option-field__link" onClick={onBack}>
          {t('screens.studio.option.rawBack')}
        </button>
      )}
    </div>
  )
}
