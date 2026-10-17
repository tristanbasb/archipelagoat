// The game of the YAML: a search among the games Archipelago knows (studio:games), with where their
// option schema comes from. An installed game without a template (a custom world, usually) offers to
// have Archipelago write the templates (ap:regenerateTemplates, a task).
import { IconRefresh, IconTemplate, IconWorldDownload } from '@tabler/icons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { GoatError } from '@shared/errors'
import type { StudioGame } from '@shared/types'
import { Badge, Combobox, ErrorPanel, NeonButton, ProgressBar, type Tone } from '../../design/components'
import { useEvent } from '../../hooks/useEvent'
import { useIpcMutation } from '../../hooks/useIpc'
import { useTask } from '../../hooks/useTask'
import { describeError } from '../../lib/errors'
import { stageLabel } from '../../lib/task-stages'
import { useTasksStore } from '../../stores/tasks'
import './GamePicker.css'

/** The element id around the game field, which an issue about the game focuses. */
export const GAME_FIELD_ID = 'studio-game-field'

const SOURCE_TONE: Record<StudioGame['schemaSource'], Tone> = { local: 'green', site: 'cyan', none: 'yellow' }

export interface GamePickerProps {
  games: StudioGame[]
  value: string | null
  onPick: (game: StudioGame) => void
  /** Shows where the picked game's schema comes from. */
  showStatus?: boolean
  className?: string
}

export function GamePicker({
  games,
  value,
  onPick,
  showStatus = true,
  className,
}: GamePickerProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const picked = games.find((game) => game.game === value)
  const hint = (game: StudioGame): string | undefined => {
    if (!game.installed) return t('screens.studio.game.notInstalled')
    if (game.schemaSource !== 'local') return t(`screens.studio.game.source.${game.schemaSource}`)
    return undefined
  }

  return (
    <div id={GAME_FIELD_ID} className={className}>
      <Combobox
        label={t('screens.studio.game.label')}
        placeholder={t('screens.studio.game.placeholder')}
        emptyLabel={t('screens.studio.game.empty')}
        value={value}
        options={games.map((game) => ({ value: game.game, label: game.game, hint: hint(game) }))}
        onChange={(name) => {
          const game = games.find((entry) => entry.game === name)
          if (game && game.game !== value) onPick(game)
        }}
      />
      {showStatus && picked && (
        <div className="game-picker__status">
          <Badge tone={SOURCE_TONE[picked.schemaSource]} icon={<IconTemplate />}>
            {t(`screens.studio.game.source.${picked.schemaSource}`)}
          </Badge>
          {!picked.installed && (
            <>
              <Badge tone="yellow">{t('screens.studio.game.notInstalled')}</Badge>
              <button
                type="button"
                className="game-picker__link"
                onClick={() => void navigate('/worlds?tab=catalog')}
              >
                <IconWorldDownload aria-hidden="true" />
                {t('screens.studio.game.toWorlds')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The id of a templates task running, wherever it was started. */
function useRunningTemplates(): string | null {
  return useTasksStore((state) => {
    for (const task of Object.values(state.tasks)) {
      if (task.kind === 'templates' && task.status === 'running') return task.taskId
    }
    return null
  })
}

export interface TemplateOfferProps {
  game: string
  /** The templates were written (by this offer or elsewhere). */
  onGenerated: () => void
  /** Options are still editable as YAML meanwhile. */
  hasOptions: boolean
}

export function TemplateOffer({ game, onGenerated, hasOptions }: TemplateOfferProps): React.JSX.Element {
  const { t } = useTranslation()
  const [taskId, setTaskId] = useState<string | null>(null)
  const running = useRunningTemplates()
  const task = useTask(running ?? taskId)
  const start = useIpcMutation('ap:regenerateTemplates', { onSuccess: (ref) => setTaskId(ref.taskId) })
  useEvent('task:done', ({ kind }) => {
    if (kind === 'templates') onGenerated()
  })

  const busy = start.isPending || task.status === 'running'
  const failure = start.error ?? (task.status === 'failed' ? task.error : null)
  const described = failure ? describeError(failure, t) : null

  return (
    <div className="template-offer pixel-border tone-yellow">
      <span className="template-offer__icon" aria-hidden="true">
        <IconTemplate />
      </span>
      <div className="template-offer__main">
        <h3 className="template-offer__title">{t('screens.studio.templates.title', { game })}</h3>
        <p className="template-offer__body">{t('screens.studio.templates.body')}</p>
        {hasOptions && <p className="template-offer__body">{t('screens.studio.templates.fallback')}</p>}
        {busy ? (
          <ProgressBar
            tone="yellow"
            percent={task.progress?.percent ?? null}
            label={stageLabel(task.progress, t) ?? t('screens.studio.templates.generating')}
            className="template-offer__progress"
          />
        ) : (
          <NeonButton
            variant="secondary"
            icon={<IconRefresh />}
            className="template-offer__action"
            onClick={() => start.mutate()}
          >
            {t('screens.studio.templates.generate')}
          </NeonButton>
        )}
        {described && !busy && (
          <ErrorPanel
            title={t('screens.studio.templates.failed')}
            body={`${described.title} ${described.body}`}
            detail={described.detail}
            detailLabel={t('common.technicalDetails')}
            headingLevel={4}
          />
        )}
      </div>
    </div>
  )
}

/** Loading or failing to load the list of games. */
export function GamesError({ error, onRetry }: { error: GoatError; onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const described = describeError(error, t)
  return (
    <ErrorPanel
      title={t('screens.studio.game.loadError')}
      body={`${described.title} ${described.body}`}
      detail={described.detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        <NeonButton variant="secondary" size="sm" icon={<IconRefresh />} onClick={onRetry}>
          {t('common.retry')}
        </NeonButton>
      }
    />
  )
}
