// App lifecycle hooks (ctx.lifecycle). src/main/index.ts wires the Electron events to the controller
// once and for all, so services register hooks without ever touching index.ts.
import { randomUUID } from 'node:crypto'
import type { Lifecycle } from '@main/core/context'
import type { EventBus } from '@main/core/events'
import type { Logger } from '@main/core/logger'
import type { TaskKind } from '@shared/types'

/** The side that src/main/index.ts drives from Electron events. */
export interface LifecycleController extends Lifecycle {
  /** before-quit: early hooks, then late hooks, within the global timeout. Runs once. */
  runBeforeQuit(): Promise<void>
  /** Window close: true lets it close; false means app:quitRequested was emitted. */
  requestClose(): boolean
  /** The renderer finished loading. */
  windowReady(): void
  secondInstance(argv: string[]): void
  openFile(path: string): void
}

export interface LifecycleDeps {
  bus: EventBus
  log: Logger
  /** Starts quitting the app (app.quit()). */
  quit: () => void
  /** Global before-quit timeout, default 20 s. */
  timeoutMs?: number
}

type Phase = 'early' | 'late'

interface ReplayingSignal<T> {
  subscribe: (fn: (value: T) => void) => void
  fire: (value: T) => void
}

/** Calls listeners; until there is one, keeps the calls and replays them to the first listener. */
function replayingSignal<T>(log: Logger, name: string): ReplayingSignal<T> {
  const listeners: ((value: T) => void)[] = []
  const pending: T[] = []
  const call = (fn: (value: T) => void, value: T): void => {
    try {
      fn(value)
    } catch (error) {
      log.error(`${name} listener failed`, error)
    }
  }
  return {
    subscribe: (fn) => {
      listeners.push(fn)
      for (const value of pending.splice(0)) call(fn, value)
    },
    fire: (value) => {
      if (listeners.length === 0) pending.push(value)
      for (const fn of listeners) call(fn, value)
    },
  }
}

export function createLifecycle({ bus, log, quit, timeoutMs = 20_000 }: LifecycleDeps): LifecycleController {
  const quitHooks: { fn: () => Promise<void>; phase: Phase }[] = []
  const closeChecks: (() => { servers: string[]; tasks: TaskKind[] })[] = []
  const readyHooks: (() => void)[] = []
  const secondInstance = replayingSignal<string[]>(log, 'second-instance')
  const openFile = replayingSignal<string>(log, 'open-file')
  let ready = false
  let quitting = false
  let pendingRequest: string | null = null
  let beforeQuit: Promise<void> | null = null

  const runReady = (fn: () => void): void => {
    try {
      fn()
    } catch (error) {
      log.error('window-ready hook failed', error)
    }
  }

  const runPhase = async (phase: Phase): Promise<void> => {
    const hooks = quitHooks.filter((hook) => hook.phase === phase)
    const results = await Promise.allSettled(hooks.map((hook) => Promise.resolve().then(hook.fn)))
    for (const result of results) {
      if (result.status === 'rejected') log.error(`before-quit hook failed (${phase})`, result.reason)
    }
  }

  return {
    onBeforeQuit(fn, opts) {
      quitHooks.push({ fn, phase: opts?.phase ?? 'early' })
    },
    onCloseRequested(fn) {
      closeChecks.push(fn)
    },
    onSecondInstance: secondInstance.subscribe,
    onOpenFile: openFile.subscribe,
    onWindowReady(fn) {
      if (ready) runReady(fn)
      else readyHooks.push(fn)
    },

    confirmQuit(requestId, confirm) {
      if (requestId !== pendingRequest) {
        log.warn('ignoring a stale quit confirmation', { requestId })
        return
      }
      pendingRequest = null
      if (!confirm) return
      quitting = true
      quit()
    },

    runBeforeQuit() {
      if (beforeQuit) return beforeQuit
      quitting = true
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.warn(`before-quit hooks still running after ${timeoutMs} ms, quitting anyway`)
          resolve()
        }, timeoutMs)
      })
      const phases = runPhase('early').then(() => runPhase('late'))
      beforeQuit = Promise.race([phases, timeout]).finally(() => clearTimeout(timer))
      return beforeQuit
    },

    requestClose() {
      if (quitting) return true
      const servers: string[] = []
      const tasks: TaskKind[] = []
      for (const check of closeChecks) {
        try {
          const running = check()
          servers.push(...running.servers)
          tasks.push(...running.tasks)
        } catch (error) {
          log.error('close check failed', error)
        }
      }
      if (servers.length === 0 && tasks.length === 0) return true
      pendingRequest = randomUUID()
      bus.emit('app:quitRequested', {
        requestId: pendingRequest,
        runningServers: servers,
        runningTasks: tasks,
      })
      return false
    },

    windowReady() {
      if (ready) return
      ready = true
      for (const fn of readyHooks.splice(0)) runReady(fn)
    },
    secondInstance: secondInstance.fire,
    openFile: openFile.fire,
  }
}
