// The app root: queries, i18n, then (once the config and app info are in) effects, toasts and the
// router. The language follows the config, or the system locale when it says `auto`.
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { RouterProvider } from 'react-router-dom'
import { ToastProvider } from './design/components'
import { EffectsProvider } from './design/useEffectsPrefs'
import { createQueryClient, useIpcQuery } from './hooks/useIpc'
import { i18n, resolveLanguage } from './i18n'
import { createAppRouter } from './router'
import { useConfig } from './stores/config'
import { retainTaskEvents } from './stores/tasks'

export interface AppProps {
  /** Tests pass their own client; the app makes one. */
  queryClient?: QueryClient
}

export function App({ queryClient }: AppProps): React.JSX.Element {
  const [client] = useState(() => queryClient ?? createQueryClient())
  return (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AppShell />
      </I18nextProvider>
    </QueryClientProvider>
  )
}

function AppShell(): React.JSX.Element | null {
  const { t, i18n: instance } = useTranslation()
  const info = useIpcQuery('app:getInfo', undefined, { staleTime: Infinity })
  const config = useConfig()

  // Task events are kept from the start, so no task's first events are ever missed.
  useEffect(() => retainTaskEvents(), [])

  const ready = config.loaded && !info.isPending
  const lang = resolveLanguage(config.language, info.data?.locale ?? navigator.language)

  // Before the first paint, so the first frame is already in the right language.
  useLayoutEffect(() => {
    if (!ready) return
    if (instance.language !== lang) void instance.changeLanguage(lang)
    document.documentElement.lang = lang
  }, [ready, lang, instance])

  if (!ready) return null
  return (
    <EffectsProvider effects={config.effects}>
      <ToastProvider label={t('common.notifications')} closeLabel={t('common.close')}>
        <AppRouter devTools={info.data ? !info.data.isPackaged : false} />
      </ToastProvider>
    </EffectsProvider>
  )
}

function AppRouter({ devTools }: { devTools: boolean }): React.JSX.Element {
  const [router] = useState(() => createAppRouter({ devTools }))
  return <RouterProvider router={router} />
}
