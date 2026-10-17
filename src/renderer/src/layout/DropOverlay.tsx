// Files dropped anywhere on the window (outside a screen's own drop zone) go where their type says.
import { IconFileUpload } from '@tabler/icons-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useToast } from '../design/components'
import { sfx } from '../design/sfx'
import { usePortalContainer } from '../design/useEffectsPrefs'
import { useOpenFiles } from '../hooks/useOpenRequests'
import { pathForFile } from '../lib/goat'
import './DropOverlay.css'

const hasFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes('Files')

/** A screen's own Dropzone takes the files dropped on it. */
const overDropzone = (event: DragEvent): boolean =>
  event.target instanceof Element && event.target.closest('.dropzone') !== null

export function DropOverlay(): React.JSX.Element | null {
  const { t } = useTranslation()
  const toast = useToast()
  const openFiles = useOpenFiles()
  const container = usePortalContainer()
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  const onDrop = useEffectEvent((files: File[]) => {
    const paths: string[] = []
    for (const file of files) {
      const path = pathForFile(file)
      if (path) paths.push(path)
      else toast.push({ tone: 'warn', title: t('shell.drop.noPath', { name: file.name }) })
    }
    if (paths.length > 0) {
      sfx.play('confirm')
      openFiles(paths)
    }
  })

  useEffect(() => {
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth.current += 1
      setActive(!overDropzone(event))
    }
    const over = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      // Without this the window would navigate to the dropped file.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setActive(!overDropzone(event))
    }
    const leave = (): void => {
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const end = (): void => {
      depth.current = 0
      setActive(false)
    }
    const drop = (event: DragEvent): void => {
      end()
      if (!hasFiles(event)) return
      const handled = event.defaultPrevented
      event.preventDefault()
      if (!handled) onDrop([...(event.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', drop)
    }
  }, [])

  if (!active) return null
  return createPortal(
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay__frame tone-cyan">
        <IconFileUpload className="drop-overlay__icon" />
        <p className="drop-overlay__title">{t('shell.drop.title')}</p>
        <ul className="drop-overlay__hints">
          <li>
            <code>.apworld</code>
            <span>{t('shell.drop.worlds')}</span>
          </li>
          <li>
            <code>.yaml</code>
            <span>{t('shell.drop.yaml')}</span>
          </li>
          <li>
            <code>.ap…</code>
            <span>{t('shell.drop.patch')}</span>
          </li>
        </ul>
      </div>
    </div>,
    container,
  )
}
