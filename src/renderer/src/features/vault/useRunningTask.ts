import type { TaskKind } from '@shared/types'
import { useTasksStore } from '../../stores/tasks'

/**
 * The id of a running task of this kind, wherever it started (another screen, or this one before
 * the user left it), so the screen shows its progress instead of offering to start it again.
 */
export function useRunningTask(kind: TaskKind): string | null {
  return useTasksStore((state) => {
    for (const task of Object.values(state.tasks)) {
      if (task.kind === kind && task.status === 'running') return task.taskId
    }
    return null
  })
}
