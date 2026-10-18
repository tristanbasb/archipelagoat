// The stage codes the main tasks report in task:progress, and their labels for the displays that
// show any task (status bar, trust screen, readiness checklist). The generation's stages have their
// texts under `stages`; every other task's under `taskStages`, where `taskStages.<kind>.<stage>`
// gives a task its own text for a stage another task names the same (the measure's `generate`).
import type { TFunction } from 'i18next'
import { GENERATE_STAGE_IDS } from '@shared/codes'
import type { TaskProgress } from '@shared/types'

/** Every stage a main task passes to progress(), besides the generation's (GENERATE_STAGE_IDS). */
export const TASK_STAGES = [
  // world-prepare (Task 10)
  'download',
  'inspect',
  // ap-install (Task 9), after its own download
  'verify',
  'backup',
  'quarantine',
  'install',
  'detect',
  // ap-uninstall (Task 9)
  'uninstall',
  // templates (Task 12)
  'scan',
  'generate',
  'done',
  // rom-scan (Task 18)
  'list',
  'hash',
  // bizhawk-install (Task 19), besides its download
  'release',
  'extract',
  // webhost-host (Task 17)
  'upload',
  'room',
  'wake',
  'port',
  // measure (0.2), besides generate and done; profiles (0.2) passes prepare, generate and done
  'prepare',
  'read',
  // ready (0.2), besides download, inspect, install and done
  'templates',
  'profile',
  'validate',
  'deliver',
] as const

function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value)
}

/** The label of the stage a task is at; null before its first progress or for a stage without one. */
export function stageLabel(
  progress: Pick<TaskProgress, 'kind' | 'stage'> | null,
  t: TFunction,
): string | null {
  if (!progress) return null
  const { kind, stage } = progress
  if (kind === 'generate' && isOneOf(GENERATE_STAGE_IDS, stage)) return t(`stages.${stage}`)
  if (isOneOf(TASK_STAGES, stage)) return t([`taskStages.${kind}.${stage}`, `taskStages.${stage}`])
  return null
}

/** The task's name, with its stage when that has a label ("Installing BizHawk · Downloading"). */
export function taskLabel(progress: Pick<TaskProgress, 'kind' | 'stage'>, t: TFunction): string {
  const kind = t(`tasks.kinds.${progress.kind}`)
  const stage = stageLabel(progress, t)
  return stage ? t('tasks.withStage', { kind, stage }) : kind
}
