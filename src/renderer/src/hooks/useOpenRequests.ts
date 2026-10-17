// Files and archipelago:// links handed to the app by the system (cold start, second instance,
// file association) or dropped on the window, sent to the screen that handles them.
import { useEffect, useEffectEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import type { GoatApi } from '@shared/goat-api'
import type { OpenRequest } from '@shared/types'
import { useToast } from '../design/components'
import { routeDroppedFile } from '../lib/drop-routing'
import { describeError } from '../lib/errors'
import { invoke, subscribe } from '../lib/goat'
import { useUiStore } from '../stores/ui'
import { useIpcMutation } from './useIpc'

export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** The session open in the wizard, if any: dropped YAML files are added to it. */
export function useActiveSessionId(): string | null {
  const { pathname } = useLocation()
  const id = matchPath('/session/:id', pathname)?.params.id
  return id && id !== 'new' ? id : null
}

/** Adds player files to a session, then says what was added and what was ignored. */
export function useSessionImport(): (sessionId: string, paths: string[]) => void {
  const toast = useToast()
  const { t } = useTranslation()
  const addFiles = useIpcMutation('session:addFiles', {
    invalidates: ['session:get', 'session:validate', 'session:list'],
    onSuccess: ({ ignored }, { paths }) => {
      const added = paths.filter((path) => !ignored.includes(path))
      if (added.length > 0) {
        toast.push({
          tone: 'ok',
          title:
            added.length === 1
              ? t('shell.drop.addedOne', { name: fileName(added[0] ?? '') })
              : t('shell.drop.added', { count: added.length }),
        })
      }
      if (ignored.length > 0) {
        toast.push({
          tone: 'warn',
          title: t('shell.drop.ignored', { names: ignored.map(fileName).join(', ') }),
        })
      }
    },
    onError: (error) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
  })
  return (id, paths) => addFiles.mutate({ id, paths })
}

/** Opens files the way their type asks: install a world, import or edit a YAML, join with a patch… */
export function useOpenFiles(): (paths: string[]) => void {
  const navigate = useNavigate()
  const activeSessionId = useActiveSessionId()
  const importIntoSession = useSessionImport()
  const toast = useToast()
  const { t } = useTranslation()
  const askAbout = useUiStore((state) => state.askAbout)

  return (paths) => {
    const routed = paths.map((path) => ({ path, route: routeDroppedFile(path, { activeSessionId }) }))
    for (const { path, route } of routed) {
      if (!route) toast.push({ tone: 'warn', title: t('shell.drop.unsupported', { name: fileName(path) }) })
    }

    const imports = routed.filter(({ route }) => route?.intent === 'session-import').map(({ path }) => path)
    if (imports.length > 0 && activeSessionId) importIntoSession(activeSessionId, imports)

    // Several worlds go to the worlds screen together (one `install` parameter each).
    const worlds = routed.filter(({ route }) => route?.intent === 'world-install').map(({ path }) => path)
    const singles = routed.filter(
      ({ route }) => route && !['session-import', 'world-install'].includes(route.intent),
    )
    if (worlds.length > 0) {
      void navigate(`/worlds?${worlds.map((path) => `install=${encodeURIComponent(path)}`).join('&')}`)
    } else if (singles[0]?.route) {
      const [{ path, route }] = singles
      if (route.intent === 'ask') askAbout(path)
      else void navigate(route.to)
    }
    for (const { path } of worlds.length > 0 ? singles : singles.slice(1)) {
      toast.push({ tone: 'warn', title: t('shell.drop.oneAtATime', { name: fileName(path) }) })
    }
  }
}

interface Drain {
  goat: GoatApi
  requests: Promise<OpenRequest[]>
  handled: boolean
}

let drain: Drain | null = null

/**
 * The requests queued in the main process before the window could take them. Draining empties the
 * queue, so it happens once per bridge and every mount (React StrictMode mounts twice) shares it.
 */
function pendingRequests(): Drain {
  if (drain?.goat !== window.goat) {
    drain = {
      goat: window.goat,
      requests: invoke('app:pendingOpenRequests', undefined).catch(() => []),
      handled: false,
    }
  }
  return drain
}

/** Mounted once by the layout: handles the queued requests, then each new one as it arrives. */
export function useOpenRequests(): void {
  const navigate = useNavigate()
  const openFiles = useOpenFiles()
  // Files opened together (a multi-selection in the file manager) are routed together.
  const handle = useEffectEvent((requests: OpenRequest[]) => {
    const files = requests.filter((request) => request.kind === 'file').map((request) => request.value)
    if (files.length > 0) openFiles(files)
    const uri = requests.findLast((request) => request.kind === 'uri')
    if (uri) void navigate(`/join?input=${encodeURIComponent(uri.value)}`)
  })

  useEffect(() => {
    let live = true
    const off = subscribe('app:openRequest', (request) => handle([request]))
    const pending = pendingRequests()
    void pending.requests.then((requests) => {
      if (!live || pending.handled) return
      pending.handled = true
      handle(requests)
    })
    return () => {
      live = false
      off()
    }
  }, [])
}
