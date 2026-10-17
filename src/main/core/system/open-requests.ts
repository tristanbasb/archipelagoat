// Links and files handed to the app by the system (spec §3.15): the launch argv, the argv of a second
// launch (single-instance app) and the files the OS opens with it. They wait in a queue until the
// renderer drains it (`app:pendingOpenRequests`); after that, once the window is ready, each new one
// is pushed as an `app:openRequest` event.
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpenRequest } from '@shared/types'
import type { Lifecycle } from '../context'
import type { EventBus } from '../events'

const ARCHIPELAGO_URI = /^archipelago:\/\//i
const FILE_URL = /^file:\/\//i

const isFile = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false

/** A file the OS opened, or null: an absolute path or a `file://` url (a `%u` of the Linux entry). */
function fileRequest(arg: string): OpenRequest | null {
  let file = arg
  if (FILE_URL.test(arg)) {
    try {
      file = fileURLToPath(arg)
    } catch {
      return null
    }
  }
  // Relative to which folder? A second launch does not say, so nothing is guessed.
  if (!path.isAbsolute(file) || !isFile(file)) return null
  return { kind: 'file', value: file }
}

/**
 * The requests of a command line: `archipelago://…` links and existing files. Skips the executable,
 * the entry point Electron runs when `defaultApp` (development, Playwright), and every `--` switch,
 * Chromium's included (it adds its own, in any position).
 */
export function parseArgvRequests(argv: string[], defaultApp: boolean): OpenRequest[] {
  const requests: OpenRequest[] = []
  for (const arg of argv.slice(defaultApp ? 2 : 1)) {
    if (arg.startsWith('--')) continue
    if (ARCHIPELAGO_URI.test(arg)) {
      requests.push({ kind: 'uri', value: arg })
      continue
    }
    const file = fileRequest(arg)
    if (file) requests.push(file)
  }
  return requests
}

export interface OpenRequestsDeps {
  bus: Pick<EventBus, 'emit'>
  lifecycle: Pick<Lifecycle, 'onSecondInstance' | 'onOpenFile' | 'onWindowReady'>
  /** The launch argv (`process.argv`). */
  argv: string[]
  /** `process.defaultApp`: Electron runs an entry point, which argv[1] names. */
  defaultApp: boolean
}

export interface OpenRequests {
  /** The requests waiting for the renderer, removed from the queue. */
  drain(): OpenRequest[]
}

export function createOpenRequests({ bus, lifecycle, argv, defaultApp }: OpenRequestsDeps): OpenRequests {
  const queue = parseArgvRequests(argv, defaultApp)
  let windowReady = false
  // The renderer subscribes to app:openRequest before it drains: from then on an event reaches it.
  let drained = false
  const live = (): boolean => windowReady && drained

  const flush = (): void => {
    for (const request of queue.splice(0)) bus.emit('app:openRequest', request)
  }
  const add = (requests: OpenRequest[]): void => {
    queue.push(...requests)
    if (live()) flush()
  }

  lifecycle.onSecondInstance((secondArgv) => add(parseArgvRequests(secondArgv, defaultApp)))
  lifecycle.onOpenFile((file) => add([fileRequest(file)].filter((r): r is OpenRequest => r !== null)))
  lifecycle.onWindowReady(() => {
    windowReady = true
    if (live()) flush()
  })

  return {
    drain() {
      drained = true
      return queue.splice(0)
    },
  }
}
