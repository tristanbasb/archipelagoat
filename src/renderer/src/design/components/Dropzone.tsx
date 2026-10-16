import { IconFileUpload } from '@tabler/icons-react'
import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { cx } from '../classes'
import { sfx } from '../sfx'
import { NeonButton } from './NeonButton'
import './Dropzone.css'

export interface DropzoneProps {
  /** Accepted extensions, e.g. ['.yaml', '.yml']; empty accepts every file. */
  accept: readonly string[]
  /** Absolute paths of the accepted files dropped. */
  onFiles: (paths: string[]) => void
  /** Opens the file picker. */
  onBrowse: () => void
  /** Names of the dropped files that were refused (wrong extension, or no path on disk). */
  onReject?: (names: string[]) => void
  title: ReactNode
  hint?: ReactNode
  browseLabel: string
  icon?: ReactNode
  disabled?: boolean
  className?: string
}

function accepts(accept: readonly string[], name: string): boolean {
  const lower = name.toLowerCase()
  return accept.length === 0 || accept.some((extension) => lower.endsWith(extension.toLowerCase()))
}

const hasFiles = (event: DragEvent): boolean => [...event.dataTransfer.types].includes('Files')

/** A drop target for files, with a browse button. Paths come from window.goat.pathForFile. */
export function Dropzone({
  accept,
  onFiles,
  onBrowse,
  onReject,
  title,
  hint,
  browseLabel,
  icon,
  disabled = false,
  className,
}: DropzoneProps): React.JSX.Element {
  const id = useId()
  const [active, setActive] = useState(false)
  // dragenter/dragleave also fire for every child crossed; count them to know when we really left.
  const depth = useRef(0)

  const onDragEnter = (event: DragEvent): void => {
    if (disabled || !hasFiles(event)) return
    event.preventDefault()
    depth.current += 1
    setActive(true)
  }

  const onDragOver = (event: DragEvent): void => {
    if (disabled || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (): void => {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setActive(false)
  }

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    depth.current = 0
    setActive(false)
    if (disabled) return
    const paths: string[] = []
    const rejected: string[] = []
    for (const file of event.dataTransfer.files) {
      const path = accepts(accept, file.name) ? window.goat.pathForFile(file) : ''
      if (path) paths.push(path)
      else rejected.push(file.name)
    }
    if (rejected.length > 0) {
      sfx.play('error')
      onReject?.(rejected)
    }
    if (paths.length > 0) {
      sfx.play('confirm')
      onFiles(paths)
    }
  }

  return (
    <div
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
      className={cx('dropzone tone-cyan', disabled && 'dropzone--disabled', className)}
      data-active={active || undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="dropzone__icon" aria-hidden="true">
        {icon ?? <IconFileUpload />}
      </span>
      <p id={`${id}-title`} className="dropzone__title">
        {title}
      </p>
      {hint !== undefined && (
        <p id={`${id}-hint`} className="dropzone__hint">
          {hint}
        </p>
      )}
      <NeonButton variant="secondary" size="sm" disabled={disabled} onClick={onBrowse}>
        {browseLabel}
      </NeonButton>
    </div>
  )
}
