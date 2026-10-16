import { z } from 'zod'
import type { TaskProgress } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

export const tasksChannels = {
  'tasks:list': channel(voidInput)<TaskProgress[]>(),
  /** A no-op for a task that already ended. */
  'tasks:cancel': channel(z.strictObject({ taskId: nonEmpty }))<void>(),
}
