import { useId } from 'react'
import { cssVars, cx, toneClass, type Tone } from '../classes'
import './ProgressBar.css'

export interface ProgressBarProps {
  /** 0 to 100, or null while the progress is unknown. */
  percent: number | null
  /** Number of segments of the life bar. */
  segments?: number
  label: string
  /** Spoken value instead of the percentage (e.g. "12 MB of 80 MB"). */
  valueText?: string
  tone?: Tone
  className?: string
}

/** A segmented progress bar, like an arcade life bar. */
export function ProgressBar({
  percent,
  segments = 20,
  label,
  valueText,
  tone = 'violet',
  className,
}: ProgressBarProps): React.JSX.Element {
  const labelId = useId()
  const value = percent === null ? null : Math.min(100, Math.max(0, percent))
  const lit = value === null ? 0 : Math.floor((value / 100) * segments + 1e-9)
  return (
    <div className={cx('progress', toneClass(tone), className)}>
      <div className="progress__head">
        <span id={labelId} className="progress__label">
          {label}
        </span>
        {value !== null && (
          <span className="progress__value" aria-hidden="true">
            {Math.round(value)}%
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null ? undefined : Math.round(value)}
        aria-valuetext={valueText}
        data-indeterminate={value === null || undefined}
        className="progress__track pixel-border"
        style={cssVars({ '--segments': segments })}
      >
        {Array.from({ length: segments }, (_, index) => (
          <span
            key={index}
            className="progress__segment"
            data-segment={index < lit ? 'lit' : index === lit && value !== null && value > 0 ? 'next' : 'off'}
            style={cssVars({ '--i': index })}
          />
        ))}
      </div>
    </div>
  )
}
