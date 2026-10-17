// Every screen of the app, under the layout. Hash routes, so the built file:// page can deep-link.
// Tasks 24-32 replace the screen files; this table does not change.
import { lazy, Suspense } from 'react'
import { createHashRouter, Navigate, type RouteObject } from 'react-router-dom'
import { DoctorScreen } from './features/doctor/DoctorScreen'
import { HomeScreen } from './features/home/HomeScreen'
import { LiveGameScreen } from './features/host/LiveGameScreen'
import { InstallScreen } from './features/install/InstallScreen'
import { JoinScreen } from './features/join/JoinScreen'
import { SessionWizard } from './features/session/SessionWizard'
import { SettingsScreen } from './features/settings/SettingsScreen'
import { StudioScreen } from './features/studio/StudioScreen'
import { VaultScreen } from './features/vault/VaultScreen'
import { WorldsScreen } from './features/worlds/WorldsScreen'
import { AppLayout } from './layout/AppLayout'
import { RouteErrorFallback } from './layout/ScreenBoundary'
import type { RouteHandle } from './layout/TitleBar'

// The design system gallery is a developer tool: its own chunk, routed in unpackaged builds only.
const Gallery = lazy(() => import('./features/dev/Gallery').then((module) => ({ default: module.Gallery })))

const handle = (titleKey: string): RouteHandle => ({ titleKey })

export interface AppRoutesOptions {
  /** Unpackaged build: adds /dev/gallery. */
  devTools: boolean
}

export function appRoutes({ devTools }: AppRoutesOptions): RouteObject[] {
  const screens: RouteObject[] = [
    { index: true, element: <HomeScreen />, handle: handle('nav.home') },
    { path: 'doctor', element: <DoctorScreen />, handle: handle('nav.doctor') },
    { path: 'install', element: <InstallScreen />, handle: handle('nav.install') },
    { path: 'worlds', element: <WorldsScreen />, handle: handle('nav.worlds') },
    { path: 'studio', element: <StudioScreen />, handle: handle('nav.studio') },
    // The wizard: /session/new, then /session/:id?step=1..5.
    { path: 'session/new', element: <SessionWizard />, handle: handle('nav.session') },
    { path: 'session/:id', element: <SessionWizard />, handle: handle('nav.session') },
    { path: 'play/:sessionId', element: <LiveGameScreen />, handle: handle('nav.play') },
    { path: 'join', element: <JoinScreen />, handle: handle('nav.join') },
    { path: 'vault', element: <VaultScreen />, handle: handle('nav.vault') },
    { path: 'settings', element: <SettingsScreen />, handle: handle('nav.settings') },
  ]
  if (devTools) {
    screens.push({
      path: 'dev/gallery',
      element: (
        <Suspense fallback={null}>
          <Gallery />
        </Suspense>
      ),
      handle: handle('nav.gallery'),
    })
  }
  screens.push({ path: '*', element: <Navigate to="/" replace /> })
  return [{ path: '/', element: <AppLayout />, errorElement: <RouteErrorFallback />, children: screens }]
}

export function createAppRouter(options: AppRoutesOptions): ReturnType<typeof createHashRouter> {
  return createHashRouter(appRoutes(options))
}
