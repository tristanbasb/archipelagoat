// The worlds screen (spec §4.2.3): the installed APWorlds and the community catalog, in two tabs.
// Installs go through useWorldInstall (trust screen first); `?install=<path>` (one per file, from
// a drop or a file opened with the app) queues file installs, one after the other. The lists
// refresh on `worlds:changed` through the app layout, which invalidates WORLD_QUERIES.
import { IconFileImport, IconPackages, IconWorldDownload } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { NeonButton, Tabs } from '../../design/components'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useWorldInstall } from '../../hooks/useWorldInstall'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { useConfig } from '../../stores/config'
import { CatalogGrid } from './CatalogGrid'
import { InstalledList } from './InstalledList'
import { visibleEntries } from './model'
import { useErrorToast } from './useErrorToast'
import './WorldsScreen.css'

type Tab = 'installed' | 'catalog'

export function WorldsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const { start, dialog } = useWorldInstall()
  const { showAfterDark } = useConfig()
  const showError = useErrorToast()
  const tab: Tab = params.get('tab') === 'catalog' ? 'catalog' : 'installed'

  // The counts of the tabs. The catalog is only read from the cache: its tab fetches it.
  const worlds = useIpcQuery('worlds:list', undefined)
  const catalog = useIpcQuery('catalog:list', {}, { enabled: false })

  const pick = useIpcMutation('app:pickPaths', {
    onSuccess: (paths) => {
      for (const path of paths) void start({ kind: 'file', path })
    },
    onError: showError,
  })

  const showTab = (next: Tab): void => {
    setParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (next === 'catalog') params.set('tab', 'catalog')
        else params.delete('tab')
        return params
      },
      { replace: true },
    )
  }

  // Install requests: each set is started once, in order (useWorldInstall queues them). The URL
  // keeps them while they are on screen; once they are all settled, they leave it, so that the same
  // file can be opened again and going back in history does not start them twice.
  const requests = JSON.stringify(params.getAll('install'))
  const consumed = useRef<string | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const paths = JSON.parse(requests) as string[]
    if (paths.length === 0) {
      consumed.current = null
      return
    }
    if (consumed.current === requests) return
    consumed.current = requests
    void Promise.all(paths.map((path) => start({ kind: 'file', path }))).then(() => {
      // Left the screen meanwhile: the installs were given up, the URL is not ours any more.
      if (!mounted.current) return
      setParams(
        (current) => {
          if (JSON.stringify(current.getAll('install')) !== requests) return current
          const next = new URLSearchParams(current)
          next.delete('install')
          return next
        },
        { replace: true },
      )
    })
  }, [requests, start, setParams])

  return (
    <div className="worlds-screen">
      <ScreenHeader
        eyebrow={t('screens.worlds.eyebrow')}
        title={t('nav.worlds')}
        subtitle={t('screens.worlds.subtitle')}
        actions={
          <div className="worlds-screen__actions">
            <NeonButton
              variant="secondary"
              icon={<IconFileImport />}
              loading={pick.isPending}
              onClick={() =>
                pick.mutate({
                  mode: 'files',
                  title: t('screens.worlds.pickTitle'),
                  filters: [{ name: t('screens.worlds.pickFilter'), extensions: ['apworld'] }],
                })
              }
            >
              {t('screens.worlds.pickFile')}
            </NeonButton>
            <span className="worlds-screen__hint">{t('screens.worlds.dropHint')}</span>
          </div>
        }
      />

      <Tabs<Tab>
        label={t('screens.worlds.tabs.label')}
        value={tab}
        onChange={showTab}
        tabs={[
          {
            id: 'installed',
            label: t('screens.worlds.tabs.installed'),
            icon: <IconPackages aria-hidden="true" />,
            badge: worlds.data?.length,
          },
          {
            id: 'catalog',
            label: t('screens.worlds.tabs.catalog'),
            icon: <IconWorldDownload aria-hidden="true" />,
            badge: catalog.data ? visibleEntries(catalog.data.entries, showAfterDark).length : undefined,
          },
        ]}
      >
        {tab === 'installed' ? (
          <InstalledList onBrowseCatalog={() => showTab('catalog')} />
        ) : (
          <CatalogGrid onInstall={(entry) => void start({ kind: 'catalog', id: entry.id })} />
        )}
      </Tabs>

      {dialog}
    </div>
  )
}
