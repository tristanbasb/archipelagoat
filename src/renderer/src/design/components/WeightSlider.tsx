import { useId } from 'react'
import { cssVars, cx, NEON_SERIES, toneClass } from '../classes'
import { NumberField } from './Slider'
import './WeightSlider.css'

export interface WeightSliderProps {
  /** Weight of each value of the option (Archipelago's weighted YAML). */
  weights: Record<string, number>
  /** Called with the whole map when one weight changes. */
  onChange: (weights: Record<string, number>) => void
  /** Names the group. */
  label?: string
  /** Display names of the values; the raw value is shown otherwise. */
  optionLabels?: Record<string, string>
  /** Top of the ranges; the number fields accept more. */
  max?: number
  className?: string
}

/** Rounded share of each weight, in percent (0 everywhere when they are all 0). */
export function weightPercents(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((sum, weight) => sum + Math.max(0, weight), 0)
  return Object.fromEntries(
    Object.entries(weights).map(([key, weight]) => [
      key,
      total > 0 ? Math.round((Math.max(0, weight) / total) * 100) : 0,
    ]),
  )
}

/** One range per value with its weight and its resulting probability, over a stacked bar. */
export function WeightSlider({
  weights,
  onChange,
  label,
  optionLabels,
  max = 100,
  className,
}: WeightSliderProps): React.JSX.Element {
  const id = useId()
  const entries = Object.entries(weights)
  const percents = weightPercents(weights)
  const nameOf = (key: string): string => optionLabels?.[key] ?? key
  const toneOf = (index: number): string => toneClass(NEON_SERIES[index % NEON_SERIES.length] ?? 'violet')
  const set = (key: string, weight: number): void => onChange({ ...weights, [key]: weight })

  return (
    <div role="group" aria-label={label} className={cx('weights', className)}>
      <div className="weights__bar pixel-border" aria-hidden="true">
        {entries.map(([key, weight], index) =>
          weight > 0 ? (
            <span
              key={key}
              className={cx('weights__share', toneOf(index))}
              style={cssVars({ '--share': weight })}
            />
          ) : null,
        )}
      </div>
      {entries.map(([key, weight], index) => {
        const nameId = `${id}-${index}`
        const percent = percents[key] ?? 0
        const fill = (Math.min(max, Math.max(0, weight)) / max) * 100
        return (
          <div key={key} role="group" aria-labelledby={nameId} className={cx('weights__row', toneOf(index))}>
            <span className="weights__chip" aria-hidden="true" />
            <span id={nameId} className="weights__name" title={nameOf(key)}>
              {nameOf(key)}
            </span>
            <input
              type="range"
              className="range"
              min={0}
              max={max}
              step={1}
              value={Math.min(max, weight)}
              aria-labelledby={nameId}
              aria-valuetext={`${weight} (${percent}%)`}
              style={cssVars({ '--fill': `${fill}%` })}
              onChange={(event) => set(key, Number(event.target.value))}
            />
            <NumberField
              value={weight}
              min={0}
              integer
              labelledBy={nameId}
              onCommit={(next) => set(key, next)}
            />
            <output className="weights__percent" data-zero={percent === 0 || undefined}>
              {percent}%
            </output>
          </div>
        )
      })}
    </div>
  )
}
