import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { NeonButton, type NeonButtonProps } from '../../design/components'
import { sfx } from '../../design/sfx'

const COPIED_FOR_MS = 1600

export interface CopyButtonProps extends Pick<NeonButtonProps, 'variant' | 'size' | 'className'> {
  /** What lands in the clipboard; read at click time. */
  value: () => string
  label: string
  /** Replaces the label for a moment after a copy. */
  copiedLabel: string
  /** Accessible name when the visible label is not enough (it must start with the label). */
  'aria-label'?: string
}

/** A button that copies a text and says so for a moment, like CopyField's button. */
export function CopyButton({
  value,
  label,
  copiedLabel,
  variant = 'ghost',
  size = 'sm',
  className,
  'aria-label': ariaLabel,
}: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_FOR_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    navigator.clipboard.writeText(value()).then(
      () => {
        sfx.play('coin')
        setCopied(true)
      },
      () => sfx.play('error'),
    )
  }

  return (
    <NeonButton
      variant={variant}
      size={size}
      className={className}
      sound={false}
      aria-label={ariaLabel}
      icon={copied ? <IconCheck /> : <IconCopy />}
      onClick={copy}
    >
      {copied ? copiedLabel : label}
    </NeonButton>
  )
}
