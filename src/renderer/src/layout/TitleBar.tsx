// The custom title bar (titleBarStyle 'hidden'): 36 px, draggable, with room kept on the right for
// the native window buttons that titleBarOverlay draws over the page.
import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useMatches } from 'react-router-dom'
import { GoatMark, Wordmark } from './Logo'
import './TitleBar.css'

/** What a route tells the shell about itself (react-router `handle`). */
export interface RouteHandle {
  /** i18n key of the screen name, shown in the title bar and the window title. */
  titleKey: string
}

interface WindowControlsOverlayLike extends EventTarget {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
}

interface Insets {
  left: number
  right: number
}

function overlay(): WindowControlsOverlayLike | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay
}

/** Space taken by the native buttons, from the Window Controls Overlay API; null without it. */
function readInsets(): Insets | null {
  const controls = overlay()
  if (!controls) return null
  if (!controls.visible) return { left: 0, right: 0 }
  const area = controls.getTitlebarAreaRect()
  return { left: Math.max(0, area.x), right: Math.max(0, window.innerWidth - area.x - area.width) }
}

function useTitlebarInsets(): Insets | null {
  const [insets, setInsets] = useState(readInsets)
  useEffect(() => {
    const update = (): void => setInsets(readInsets())
    const controls = overlay()
    controls?.addEventListener('geometrychange', update)
    window.addEventListener('resize', update)
    return () => {
      controls?.removeEventListener('geometrychange', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return insets
}

function useScreenTitle(): string | null {
  const { t } = useTranslation()
  const key = useMatches()
    .map((match) => (match.handle as RouteHandle | undefined)?.titleKey)
    .filter((titleKey): titleKey is string => typeof titleKey === 'string')
    .at(-1)
  return key ? t(key) : null
}

export function TitleBar(): React.JSX.Element {
  const title = useScreenTitle()
  const insets = useTitlebarInsets()

  useEffect(() => {
    document.title = title ? `${title} · ArchipelaGOAT` : 'ArchipelaGOAT'
  }, [title])

  // Without the API, CSS falls back to the titlebar-area env() variables.
  const style = insets
    ? ({ '--controls-left': `${insets.left}px`, '--controls-right': `${insets.right}px` } as CSSProperties)
    : undefined

  return (
    <header className="title-bar" style={style}>
      <span className="title-bar__brand">
        <GoatMark size={20} className="title-bar__mark tone-violet" />
        <Wordmark className="title-bar__wordmark" />
      </span>
      {title && (
        <>
          <span className="title-bar__sep" aria-hidden="true" />
          <span className="title-bar__screen">{title}</span>
        </>
      )}
    </header>
  )
}
