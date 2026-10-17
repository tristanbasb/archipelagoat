// The wizard's five steps and how a game's status reads, shared by the wizard and its entry screen.
import type { SessionStatus } from '@shared/types'
import type { Status } from '../../design/components'

export const STEP_IDS = ['players', 'check', 'rules', 'generate', 'host'] as const
export type StepNumber = 1 | 2 | 3 | 4 | 5

export const STATUS_PILL: Record<SessionStatus, Status> = {
  draft: 'idle',
  generated: 'ok',
  hosting: 'busy',
  finished: 'idle',
}

/** The Studio, opened on one player file of a session; saving there brings the user back. */
export function studioLink(sessionId: string, fileId: string): string {
  return `/studio?${new URLSearchParams({ session: sessionId, file: fileId }).toString()}`
}
