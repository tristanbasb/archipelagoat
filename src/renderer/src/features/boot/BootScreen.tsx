// The arcade boot sequence of the first launch: about two seconds, any key or click skips it.
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { sfx } from '../../design/sfx'
import { useEffectsPrefs, usePortalContainer } from '../../design/useEffectsPrefs'
import { GoatMark, IslandMark, Wordmark } from '../../layout/Logo'
import './BootScreen.css'

export interface BootScreenProps {
  onDone: () => void
  /** How long the sequence runs before it ends by itself. */
  durationMs?: number
}

const LINES = ['islands', 'goat', 'worlds'] as const
/** The fade out after the sequence, when animations are on. */
const LEAVE_MS = 280

export function BootScreen({ onDone, durationMs = 2000 }: BootScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const { animations } = useEffectsPrefs()
  const container = usePortalContainer()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [leaving, setLeaving] = useState(false)
  const done = useEffectEvent(() => onDone())
  const leaveDelay = useEffectEvent(() => (animations ? LEAVE_MS : 0))

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.focus()
    let left = false
    let leaveTimer: number | undefined
    const finish = (): void => {
      if (left) return
      left = true
      setLeaving(true)
      sfx.play('coin')
      leaveTimer = window.setTimeout(() => done(), leaveDelay())
    }
    const timer = window.setTimeout(finish, durationMs)
    // Capture phase: the key that skips the boot does nothing else (no shortcut behind it).
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      finish()
    }
    window.addEventListener('keydown', onKey, true)
    dialog?.addEventListener('pointerdown', finish)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(leaveTimer)
      window.removeEventListener('keydown', onKey, true)
      dialog?.removeEventListener('pointerdown', finish)
    }
  }, [durationMs])

  return createPortal(
    <div
      ref={dialogRef}
      className="boot grid-bg"
      role="dialog"
      aria-modal="true"
      aria-label={t('boot.label')}
      tabIndex={-1}
      data-leaving={leaving || undefined}
    >
      <div className="boot__screen">
        <div className="boot__logo tone-violet">
          <div className="boot__sky" aria-hidden="true">
            <IslandMark kind="palm" size={84} className="boot__island boot__island--left tone-green" />
            <IslandMark kind="rock" size={52} className="boot__island boot__island--right tone-green" />
            <IslandMark kind="palm" size={46} className="boot__island boot__island--far tone-green" />
          </div>
          <GoatMark size={112} className="boot__mark" />
          <Wordmark className="boot__wordmark" />
          <p className="boot__unofficial">{t('common.unofficial')}</p>
        </div>

        <ul className="boot__lines" aria-hidden="true">
          {LINES.map((line, index) => (
            <li key={line} style={{ animationDelay: `${450 + index * 260}ms` }}>
              <span className="boot__prompt">&gt;</span>
              <span className="boot__line-text">{t(`boot.lines.${line}`)}</span>
              <span className="boot__dots" />
              <span className="boot__ok">{t('boot.lines.ok')}</span>
            </li>
          ))}
        </ul>

        <div className="boot__bar tone-cyan" aria-hidden="true">
          <span />
        </div>

        <p className="boot__start t-display">{t('boot.pressStart')}</p>
        <p className="boot__skip">{t('boot.skip')}</p>
      </div>
    </div>,
    container,
  )
}
