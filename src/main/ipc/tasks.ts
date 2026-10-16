// tasks:* handlers.
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerTaskHandlers(register: RegisterHandler, { ctx }: ServiceContainer): void {
  register('tasks:list', () => Promise.resolve(ctx.tasks.list()))

  register('tasks:cancel', ({ taskId }) => {
    ctx.tasks.cancel(taskId)
    return Promise.resolve()
  })
}
