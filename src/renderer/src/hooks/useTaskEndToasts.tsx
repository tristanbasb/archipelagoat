// A toast when a task ends (spec §4.1): a generation, an install, a hosting on archipelago.gg or a ROM
// scan that finishes or fails while another screen is open is not missed. The screen that owns the
// task shows its end itself: no toast while it is the current route. A failure reads as its
// translated error; a cancelled task (the user's own doing) says nothing. The toast leads to the
// screen that owns the task. The app shell calls this once, for its whole life.
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import type { AppErrorData } from '@shared/errors'
import type { TaskKind } from '@shared/types'
import { useToast } from '../design/components'
import { sessionOfTask } from '../features/session/wizard-runs'
import { describeError } from '../lib/errors'
import { useEvent } from './useEvent'

interface Owner {
  /** Where the toast leads. */
  to: string
  /** The routes that already show how the task ended. */
  shows: (pathname: string) => boolean
}

/**
 * Tasks whose end is never toasted: one asked along the way by its own dialog (useWorldInstall),
 * which tells how it ends, and the refinement of a game's profiles, which runs in the background
 * unasked. Ruling 23: its failures are expected (no ROM, no template yet), so the main process only
 * logs them, and the profiles stay heuristic (« non mesuré »).
 */
const SILENT: ReadonlySet<TaskKind> = new Set(['world-prepare', 'profiles'])

const screen = (path: string): Owner => ({
  to: path,
  shows: (pathname) => pathname === path || pathname.startsWith(`${path}/`),
})

/** The screen that owns a task; null when none can be told (a session no wizard knows). */
export function taskOwner(kind: TaskKind, taskId: string, failed: boolean): Owner | null {
  switch (kind) {
    case 'ap-install':
    case 'ap-uninstall':
      return screen('/install')
    case 'rom-scan':
    case 'bizhawk-install':
      return screen('/vault')
    case 'join-prepare':
      return screen('/join')
    case 'templates':
      return screen('/studio')
    case 'ready':
      // Asked from the « Jeu prêt » dialog of the worlds screen, which tells how it ended.
      return screen('/worlds')
    case 'measure':
      // Asked from the Checks panel of a session's check step (a measure, or a search for settings),
      // which tells how it ended; elsewhere the toast leads to the sessions.
      return { to: '/session/new', shows: (pathname) => pathname.startsWith('/session/') }
    case 'generate':
    case 'webhost-host': {
      const id = sessionOfTask(taskId)
      if (id === null) return null
      const wizard = `/session/${id}`
      const live = `/play/${id}`
      // A room that is up is played on the live screen; anything else is seen in the wizard.
      const to = kind === 'webhost-host' && !failed ? live : `${wizard}?step=${kind === 'generate' ? 4 : 5}`
      return { to, shows: (pathname) => pathname === wizard || pathname === live }
    }
    default:
      return null
  }
}

export function useTaskEndToasts(): void {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const announce = (kind: TaskKind, taskId: string, error: AppErrorData | null): void => {
    if (SILENT.has(kind) || error?.code === 'TASK_CANCELLED') return
    const owner = taskOwner(kind, taskId, error !== null)
    if (owner?.shows(pathname)) return
    const action = owner ? { label: t('tasks.open'), onClick: () => void navigate(owner.to) } : undefined
    if (error === null) {
      toast.push({ tone: 'ok', title: t(`tasks.done.${kind}`), ...(action ? { action } : {}) })
      return
    }
    const { title, body } = describeError(error, t)
    toast.push({
      tone: 'error',
      title: t('tasks.failed', { kind: t(`tasks.kinds.${kind}`) }),
      body: (
        <>
          <strong>{title}</strong> {body}
        </>
      ),
      // An error stays until it is read.
      duration: 0,
      ...(action ? { action } : {}),
    })
  }

  useEvent('task:done', ({ kind, taskId }) => announce(kind, taskId, null))
  useEvent('task:failed', ({ kind, taskId, error }) => announce(kind, taskId, error))
}
