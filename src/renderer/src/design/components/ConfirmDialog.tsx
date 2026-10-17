import { useEffect, useRef, type ReactNode } from 'react'
import type { Tone } from '../classes'
import { Modal } from './Modal'
import { NeonButton } from './NeonButton'
import './ConfirmDialog.css'

export interface ConfirmDialogProps {
  open: boolean
  title: ReactNode
  eyebrow?: ReactNode
  /** What the action does, and what it leaves behind. */
  children?: ReactNode
  confirmLabel: string
  cancelLabel: string
  /** Accessible name of the close button. */
  closeLabel: string
  onConfirm: () => void
  onCancel: () => void
  tone?: Tone
  /** `danger` for an action that takes something away. */
  confirmVariant?: 'primary' | 'danger'
  confirmIcon?: ReactNode
}

/**
 * A modal that asks before an action. The confirm button answers once per opening: a double click or
 * a key held down while the dialog fades out never runs the action twice.
 */
export function ConfirmDialog({
  open,
  title,
  eyebrow,
  children,
  confirmLabel,
  cancelLabel,
  closeLabel,
  onConfirm,
  onCancel,
  tone = 'violet',
  confirmVariant = 'primary',
  confirmIcon,
}: ConfirmDialogProps): React.JSX.Element {
  const answered = useRef(false)
  useEffect(() => {
    if (open) answered.current = false
  }, [open])

  const confirm = (): void => {
    if (answered.current) return
    answered.current = true
    onConfirm()
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      closeLabel={closeLabel}
      tone={tone}
      size="sm"
      eyebrow={eyebrow}
      title={title}
      footer={
        <>
          <NeonButton variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </NeonButton>
          <NeonButton variant={confirmVariant} icon={confirmIcon} onClick={confirm}>
            {confirmLabel}
          </NeonButton>
        </>
      }
    >
      {children !== undefined && <div className="confirm-dialog">{children}</div>}
    </Modal>
  )
}
