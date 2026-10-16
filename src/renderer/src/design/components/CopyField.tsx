import { IconCheck, IconCopy, IconEye, IconEyeOff } from '@tabler/icons-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { cx } from '../classes'
import { sfx } from '../sfx'
import './CopyField.css'

/** Shown instead of a secret; always the same length, so it says nothing about the secret. */
const MASK = '••••••••••'
const COPIED_FOR_MS = 1600

interface CopyFieldBase {
  value: string
  label: ReactNode
  copyLabel: string
  /** Replaces the copy label for a moment after a copy. */
  copiedLabel: string
  className?: string
}

export type CopyFieldProps = CopyFieldBase &
  (
    | { secret?: false; revealLabel?: never; hideLabel?: never }
    | {
        /** Masks the value until revealed; the copy button still copies it. */
        secret: true
        revealLabel: string
        hideLabel: string
      }
  )

/** A read-only value with a copy button (addresses, passwords, room links). */
export function CopyField(props: CopyFieldProps): React.JSX.Element {
  const { value, label, copyLabel, copiedLabel, className } = props
  const id = useId()
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const masked = props.secret === true && !revealed

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_FOR_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    const done = (): void => {
      sfx.play('coin')
      setCopied(true)
    }
    try {
      void navigator.clipboard.writeText(value).then(done, () => sfx.play('error'))
    } catch {
      // No clipboard API (should not happen in Electron).
      sfx.play('error')
    }
  }

  return (
    <div className={cx('field copy-field', className)}>
      <span id={`${id}-label`} className="field__label">
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        className="input-frame pixel-border copy-field__frame"
      >
        <code className="copy-field__value" data-masked={masked || undefined}>
          {masked ? MASK : value}
        </code>
        {props.secret === true && (
          <button
            type="button"
            className="copy-field__icon-btn"
            aria-label={revealed ? props.hideLabel : props.revealLabel}
            onClick={() => setRevealed((shown) => !shown)}
          >
            {revealed ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
          </button>
        )}
        <button
          type="button"
          className="copy-field__copy tone-green"
          data-copied={copied || undefined}
          onClick={copy}
        >
          {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
          <span>{copied ? copiedLabel : copyLabel}</span>
        </button>
      </div>
    </div>
  )
}
