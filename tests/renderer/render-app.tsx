// Renders the real app (or one piece of it) for renderer tests, on top of the goat mock.
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { render, screen, type RenderResult } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { AppConfig, AppInfo, Lang } from '@shared/types'
import { App } from '@renderer/App'
import { ToastProvider } from '@renderer/design/components'
import { EffectsProvider } from '@renderer/design/useEffectsPrefs'
import { createQueryClient } from '@renderer/hooks/useIpc'
import { i18n } from '@renderer/i18n'
import { installGoatMock, type GoatHandlers, type GoatMock } from './goat-mock'

export interface RenderAppOptions {
  /** Hash route to start on, e.g. '/join'. */
  route?: string
  handlers?: GoatHandlers
  config?: Partial<AppConfig>
  info?: Partial<AppInfo>
  /** Waits for the main navigation (true by default). */
  waitForShell?: boolean
}

export interface RenderAppResult extends RenderResult {
  goat: GoatMock
  user: UserEvent
  queryClient: QueryClient
}

afterEach(() => {
  window.location.hash = ''
})

/** The whole app, hash router included, starting on `route`. */
export async function renderApp(options: RenderAppOptions = {}): Promise<RenderAppResult> {
  window.location.hash = `#${options.route ?? '/'}`
  const goat = installGoatMock(options.handlers, { config: options.config, info: options.info })
  const queryClient = createQueryClient()
  const user = userEvent.setup()
  const result = render(<App queryClient={queryClient} />)
  if (options.waitForShell !== false) await screen.findByRole('navigation', { name: 'Navigation principale' })
  return { ...result, goat, user, queryClient }
}

export interface RenderWithProvidersOptions {
  route?: string
  lang?: Lang
  queryClient?: QueryClient
}

/** One component inside the app providers (queries, i18n, effects, toasts, a memory router). */
export async function renderWithProviders(
  ui: ReactNode,
  options: RenderWithProvidersOptions = {},
): Promise<RenderResult & { user: UserEvent; queryClient: QueryClient }> {
  await i18n.changeLanguage(options.lang ?? 'fr')
  const queryClient = options.queryClient ?? createQueryClient()
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [options.route ?? '/'] })
  const user = userEvent.setup()
  const result = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <EffectsProvider effects={{ crt: false, glow: false, animations: false, sounds: false }}>
          <ToastProvider label="Notifications" closeLabel="Fermer">
            <RouterProvider router={router} />
          </ToastProvider>
        </EffectsProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  )
  return { ...result, user, queryClient }
}
