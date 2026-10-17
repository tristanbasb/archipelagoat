// The frame around every screen: title bar, rail, the screen itself, status bar, and the overlays
// that can appear anywhere (boot, drop, quit, file choice, CRT).
import { Suspense, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { CRTOverlay, Spinner } from '../design/components'
import { BootScreen } from '../features/boot/BootScreen'
import { useEventInvalidation } from '../hooks/useEventInvalidation'
import { useOpenRequests } from '../hooks/useOpenRequests'
import { useShortcuts } from '../hooks/useShortcuts'
import { useTaskEndToasts } from '../hooks/useTaskEndToasts'
import { useConfig } from '../stores/config'
import { DropOverlay } from './DropOverlay'
import { FileChoiceDialog } from './FileChoiceDialog'
import { QuitConfirm } from './QuitConfirm'
import { NAV_ITEMS, Rail } from './Rail'
import { ScreenBoundary } from './ScreenBoundary'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import './AppLayout.css'

/** Ctrl+1…7 open the rail entries, in order. */
const railShortcuts = (navigate: (to: string) => void): Record<string, () => void> =>
  Object.fromEntries(NAV_ITEMS.map((item, index) => [`Ctrl+${index + 1}`, () => navigate(item.to)]))

export function AppLayout(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const config = useConfig()
  const mainRef = useRef<HTMLElement>(null)
  const [bootDone, setBootDone] = useState(false)

  useOpenRequests()
  useEventInvalidation()
  useTaskEndToasts()
  useShortcuts(railShortcuts((to) => void navigate(to)))

  // A new screen starts at its top.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [pathname])

  // The transition replays when the section changes (/session/new → /session/abc stays put).
  const section = pathname.split('/')[1] ?? ''
  const showBoot = config.loaded && !config.firstRunDone && !bootDone

  return (
    <div className="app-shell">
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>
        {t('shell.skipToContent')}
      </button>
      <TitleBar />
      <div className="app-shell__body">
        <Rail />
        <main ref={mainRef} className="app-main grid-bg" tabIndex={-1}>
          <span key={`flash-${section}`} className="app-main__flash" aria-hidden="true" />
          <div key={section} className="app-main__screen">
            <ScreenBoundary resetKey={pathname}>
              <Suspense fallback={<Spinner label={t('common.loading')} className="app-main__loading" />}>
                <Outlet />
              </Suspense>
            </ScreenBoundary>
          </div>
        </main>
      </div>
      <StatusBar />
      <CRTOverlay />
      <DropOverlay />
      <QuitConfirm />
      <FileChoiceDialog />
      {showBoot && (
        <BootScreen
          onDone={() => {
            setBootDone(true)
            void config.set({ firstRunDone: true }).catch(() => undefined)
          }}
        />
      )}
    </div>
  )
}
