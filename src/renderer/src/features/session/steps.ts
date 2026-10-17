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
