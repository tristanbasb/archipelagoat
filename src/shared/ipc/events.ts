// Payload type of each push event (main → renderer). The names come from ./event-names.ts.
import type {
  ApInstall,
  AppConfig,
  OpenRequest,
  QuitRequest,
  ServerEvent,
  ServerState,
  TaskDone,
  TaskFailed,
  TaskLog,
  TaskProgress,
} from '../types'
import type { EventName } from './event-names'

export type { EventName } from './event-names'

export type EventPayloads = {
  'task:progress': TaskProgress
  'task:log': TaskLog
  'task:done': TaskDone
  'task:failed': TaskFailed
  'server:state': ServerState
  'server:event': { sessionId: string; event: ServerEvent }
  'server:log': { sessionId: string; line: string }
  'app:openRequest': OpenRequest
  'app:quitRequested': QuitRequest
  'config:changed': AppConfig
  'worlds:changed': null
  /**
   * The install the app uses changed: installed or updated by the app, or installed, updated or
   * removed outside it (null when none is left).
   */
  'ap:installed': ApInstall | null
}

// Compile-time guard: EventPayloads has exactly the names of EVENT_NAMES, no more, no less.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type AssertTrue<T extends true> = T
export type EventPayloadsCoverEventNames = AssertTrue<Exactly<keyof EventPayloads, EventName>>
