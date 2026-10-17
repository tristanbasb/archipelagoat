// What the player needs before JOUER: Archipelago, the game's world, its ROM and the emulator.
// Every missing item offers the action that fixes it, after which the plan is checked again.
import { IconAlertTriangle, IconArchive, IconCheck, IconMinus, IconRefresh, IconX } from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toAppErrorData, type AppErrorData } from '@shared/errors'
import type { BizhawkState, CheckItem, JoinPlan, WorldSource } from '@shared/types'
import { Badge, ErrorPanel, NeonButton, PixelPanel, ProgressBar, useToast } from '../../design/components'
import { cx, toneClass, type Tone } from '../../design/classes'
import { sfx } from '../../design/sfx'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useTask } from '../../hooks/useTask'
import { useWorldInstall } from '../../hooks/useWorldInstall'
import { describeError } from '../../lib/errors'
import { STEP_FOCUS_PANEL } from './step-focus'
import { useTaskOutcome } from './task-outcome'
import './ReadinessChecklist.css'

type CheckKey = keyof JoinPlan['checklist']
const CHECK_KEYS: readonly CheckKey[] = ['ap', 'world', 'rom', 'emulator']

type RowState = CheckItem['status'] | 'vault'

const ROW_TONE: Record<RowState, Tone> = {
  ok: 'green',
  missing: 'pink',
  warning: 'yellow',
  na: 'neutral',
  vault: 'cyan',
}

const ROW_ICON: Record<RowState, ReactNode> = {
  ok: <IconCheck />,
  missing: <IconX />,
  warning: <IconAlertTriangle />,
  na: <IconMinus />,
  vault: <IconArchive />,
}

type ActionId = 'installAp' | 'installWorld' | 'scanRoms' | 'installBizhawk' | 'configureBizhawk'

/** The action that fixes a check, by its code. */
const ACTIONS: Partial<Record<string, ActionId>> = {
  'ap-missing': 'installAp',
  'world-missing': 'installWorld',
  'rom-missing': 'scanRoms',
  'rom-bad-hash': 'scanRoms',
  'emulator-missing': 'installBizhawk',
  'emulator-not-configured': 'configureBizhawk',
}

/** A ROM only the vault has is no blocker: join:play writes it into Archipelago's settings first. */
const FROM_VAULT = 'rom-apply-from-vault'

const rowState = (item: CheckItem): RowState => (item.code === FROM_VAULT ? 'vault' : item.status)

const satisfied = (item: CheckItem): boolean => item.status !== 'missing' || item.code === FROM_VAULT

export interface ReadinessChecklistProps {
  plan: JoinPlan
  /** Checks the plan again (join:refresh); rejects with the error data when that fails. */
  onRefresh: () => Promise<void>
}

interface Busy {
  key: CheckKey
  action: ActionId
  taskId: string | null
}

export function ReadinessChecklist({ plan, onRefresh }: ReadinessChecklistProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const wait = useTaskOutcome()
  const worldInstall = useWorldInstall()
  const pickPaths = useIpcMutation('app:pickPaths')
  const vaultScan = useIpcMutation('vault:scan')
  const bizhawkInstall = useIpcMutation('bizhawk:install')
  const bizhawkConfigure = useIpcMutation('bizhawk:configureAp')
  const game = plan.slot?.game ?? plan.manifest?.game ?? null
  // The catalog is read only when a world is missing: it is where the install comes from.
  const catalog = useIpcQuery(
    'catalog:list',
    {},
    { enabled: game !== null && plan.checklist.world.code === 'world-missing' },
  )
  const [busy, setBusy] = useState<Busy | null>(null)
  const [failure, setFailure] = useState<{ key: CheckKey; error: AppErrorData } | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const task = useTask(busy?.taskId ?? null)

  /** The catalog entry of the game when it has a release to download, or an .apworld the player picks. */
  const worldSource = async (): Promise<WorldSource | null> => {
    if (game !== null) {
      const snapshot = catalog.data ?? (await catalog.refetch()).data
      const entry = snapshot?.entries.find(
        (candidate) => candidate.game === game && candidate.latest !== null,
      )
      if (entry) return { kind: 'catalog', id: entry.id }
      toast.push({ tone: 'info', title: t('screens.join.checklist.worldNotInCatalog', { game }) })
    }
    const [path] = await pickPaths.mutateAsync({
      mode: 'file',
      title: t('screens.join.checklist.worldFileTitle'),
      filters: [{ name: t('screens.join.checklist.worldFilter'), extensions: ['apworld'] }],
    })
    return path ? { kind: 'file', path } : null
  }

  /** Runs an action; true when something changed and the plan must be checked again. */
  const perform = async (
    action: Exclude<ActionId, 'installAp'>,
    track: (taskId: string | null) => void,
  ): Promise<boolean> => {
    switch (action) {
      case 'installWorld': {
        const source = await worldSource()
        return source ? (await worldInstall.start(source)).installed : false
      }
      case 'scanRoms': {
        const paths = await pickPaths.mutateAsync({
          mode: 'directory',
          title: t('screens.join.checklist.scanTitle'),
        })
        if (paths.length === 0) return false
        const { taskId } = await vaultScan.mutateAsync({ paths })
        track(taskId)
        await wait(taskId)
        return true
      }
      case 'installBizhawk': {
        const { taskId } = await bizhawkInstall.mutateAsync()
        track(taskId)
        const state = (await wait(taskId)) as BizhawkState
        track(null)
        // The emulator only counts once Archipelago knows where it is.
        if (!state.configuredInAp) await bizhawkConfigure.mutateAsync()
        return true
      }
      case 'configureBizhawk':
        await bizhawkConfigure.mutateAsync()
        return true
    }
  }

  const run = async (key: CheckKey, action: ActionId): Promise<void> => {
    // Archipelago is installed from its own screen.
    if (action === 'installAp') {
      void navigate('/install')
      return
    }
    setBusy({ key, action, taskId: null })
    setFailure(null)
    try {
      const changed = await perform(action, (taskId) => setBusy({ key, action, taskId }))
      if (changed) await onRefresh()
    } catch (error) {
      sfx.play('error')
      setFailure({ key, error: toAppErrorData(error) })
    } finally {
      setBusy(null)
    }
  }

  const recheck = async (): Promise<void> => {
    setRechecking(true)
    try {
      await onRefresh()
    } catch (error) {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    } finally {
      setRechecking(false)
    }
  }

  const done = CHECK_KEYS.filter((key) => satisfied(plan.checklist[key])).length

  return (
    <PixelPanel
      {...STEP_FOCUS_PANEL}
      className="readiness"
      tone={plan.ready ? 'green' : 'neutral'}
      eyebrow={t('screens.join.checklist.eyebrow')}
      title={t('screens.join.checklist.title')}
      actions={
        <>
          <Badge tone={plan.ready ? 'green' : 'yellow'}>
            {t('screens.join.checklist.count', { ok: done, total: CHECK_KEYS.length })}
          </Badge>
          <NeonButton
            variant="ghost"
            size="sm"
            icon={<IconRefresh />}
            loading={rechecking}
            disabled={busy !== null}
            onClick={() => void recheck()}
          >
            {t('screens.join.checklist.refresh')}
          </NeonButton>
        </>
      }
    >
      <ul className="readiness__list">
        {CHECK_KEYS.map((key) => {
          const item = plan.checklist[key]
          const state = rowState(item)
          const action = item.status === 'ok' || item.status === 'na' ? undefined : ACTIONS[item.code]
          const running = busy?.key === key
          const progress = running && busy.taskId !== null ? task.progress : null
          const error = failure?.key === key ? describeError(failure.error, t) : null
          return (
            <li key={key} className={cx('check-row', toneClass(ROW_TONE[state]))} data-state={state}>
              <span className="check-row__icon" aria-hidden="true">
                {ROW_ICON[state]}
              </span>
              <div className="check-row__text">
                <span className="check-row__title">
                  {t(`screens.join.checklist.items.${key}`)}
                  <span className="sr-only"> ({t(`screens.join.checklist.status.${state}`)})</span>
                </span>
                <span className="check-row__detail">{t(`checks.${item.code}`, item.params)}</span>
              </div>
              {action !== undefined && (
                <NeonButton
                  className="check-row__action"
                  variant={action === 'installAp' ? 'primary' : 'secondary'}
                  size="sm"
                  loading={running}
                  loadingLabel={t(`screens.join.checklist.busy.${action}`)}
                  disabled={busy !== null && !running}
                  onClick={() => void run(key, action)}
                >
                  {t(`screens.join.checklist.actions.${action}`)}
                </NeonButton>
              )}
              {progress && (
                <ProgressBar
                  className="check-row__progress"
                  percent={progress.percent}
                  label={t(`tasks.kinds.${progress.kind}`)}
                  segments={24}
                  tone="cyan"
                />
              )}
              {error && (
                <ErrorPanel
                  className="check-row__error"
                  headingLevel={3}
                  title={error.title}
                  body={error.body}
                  detail={error.detail}
                  detailLabel={t('common.technicalDetails')}
                />
              )}
            </li>
          )
        })}
      </ul>
      {worldInstall.dialog}
    </PixelPanel>
  )
}
