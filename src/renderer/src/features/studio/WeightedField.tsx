// The weighted mode of an option: one weight per value with the odds it gives (WeightSlider), the
// values to add (the choices left, special names, random kinds, a value of one's own) and to
// remove. Removing the last one removes the option (setWeights): Archipelago rejects `{}`.
import { IconPlus, IconX } from '@tabler/icons-react'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { OptionSchema } from '@shared/types'
import { WeightSlider } from '../../design/components'
import { DEFAULT_WEIGHT, RANGE_RANDOMS, setWeights } from './editor-ops'
import type { DocEdit } from './OptionField'

export interface WeightedFieldProps {
  option: OptionSchema
  title: string
  weights: Record<string, number>
  onEdit: DocEdit
}

/** The values one can add to an option's weights, in the order they are offered. */
function suggestions(option: OptionSchema): string[] {
  switch (option.kind) {
    case 'toggle':
      return ['false', 'true']
    case 'range':
    case 'named-range':
      return [...Object.keys(option.specialNames), ...RANGE_RANDOMS]
    case 'text-choice':
      return [
        ...new Set([...option.choices, ...(typeof option.default === 'string' ? [option.default] : [])]),
      ]
    default:
      return [...option.choices, 'random']
  }
}

export function WeightedField({ option, title, weights, onEdit }: WeightedFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const customId = useId()
  const [custom, setCustom] = useState('')
  const { key } = option
  const present = Object.keys(weights)
  const missing = suggestions(option).filter((value) => !Object.hasOwn(weights, value))
  const takesCustom = option.kind !== 'toggle'
  const labels: Record<string, string> | undefined =
    option.kind === 'toggle'
      ? { true: t('screens.studio.option.on'), false: t('screens.studio.option.off') }
      : undefined
  const nameOf = (value: string): string => labels?.[value] ?? value

  const change = (next: Record<string, number>): void => onEdit((doc) => setWeights(doc, key, next))
  const add = (value: string): void => change({ ...weights, [value]: DEFAULT_WEIGHT })
  const remove = (value: string): void =>
    change(Object.fromEntries(Object.entries(weights).filter(([name]) => name !== value)))

  const addCustom = (event: FormEvent): void => {
    event.preventDefault()
    const value = custom.trim()
    if (value === '' || Object.hasOwn(weights, value)) return
    add(value)
    setCustom('')
  }

  return (
    <div className="weighted-field">
      <WeightSlider
        weights={weights}
        onChange={change}
        label={t('screens.studio.option.weights', { option: title })}
        optionLabels={labels}
      />
      <div
        role="group"
        aria-label={t('screens.studio.option.values', { option: title })}
        className="weighted-field__values"
      >
        {present.map((value) => (
          <button
            key={value}
            type="button"
            className="value-chip"
            data-present=""
            aria-label={t('screens.studio.option.remove', { value: nameOf(value) })}
            onClick={() => remove(value)}
          >
            <span>{nameOf(value)}</span>
            <IconX aria-hidden="true" />
          </button>
        ))}
        {missing.map((value) => (
          <button
            key={value}
            type="button"
            className="value-chip"
            aria-label={t('screens.studio.option.add', { value: nameOf(value) })}
            onClick={() => add(value)}
          >
            <IconPlus aria-hidden="true" />
            <span>{nameOf(value)}</span>
          </button>
        ))}
        {takesCustom && (
          <form className="weighted-field__custom" onSubmit={addCustom}>
            <label htmlFor={customId} className="sr-only">
              {t('screens.studio.option.custom')}
            </label>
            <input
              id={customId}
              className="weighted-field__input"
              value={custom}
              placeholder={t('screens.studio.option.customPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setCustom(event.target.value)}
            />
            <button type="submit" className="value-chip" disabled={custom.trim() === ''}>
              <IconPlus aria-hidden="true" />
              <span>{t('screens.studio.option.customAdd')}</span>
            </button>
          </form>
        )}
      </div>
      <p className="field__hint">{t('screens.studio.option.weightsHint')}</p>
    </div>
  )
}
