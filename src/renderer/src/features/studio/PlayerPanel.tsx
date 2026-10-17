// The top card of the Studio: who plays (name, description) and what (the game, its presets).
import { IconUser } from '@tabler/icons-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { EditorDoc, Issue, StudioGame } from '@shared/types'
import { PixelPanel } from '../../design/components'
import { GamePicker } from './GamePicker'
import { IssueText } from './IssueList'
import type { DocEdit } from './OptionField'
import { PresetMenu } from './PresetMenu'
import './PlayerPanel.css'

/** Archipelago's limit on a slot name. */
export const MAX_NAME = 16

/** The element id of the name field, which an issue about the name focuses. */
export const NAME_FIELD_ID = 'studio-player-name'

export interface PlayerPanelProps {
  doc: EditorDoc
  onEdit: DocEdit
  nameIssues: readonly Issue[]
  games: StudioGame[]
  onPickGame: (game: StudioGame) => void
  /** The game's presets; null without a schema. */
  presets: string[] | null
  onPreset: (preset: string | null) => void
}

export function PlayerPanel({
  doc,
  onEdit,
  nameIssues,
  games,
  onPickGame,
  presets,
  onPreset,
}: PlayerPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const descriptionId = useId()
  const length = doc.name.trim().length
  const over = length > MAX_NAME && !/\{[^}]*\}/.test(doc.name)
  const knownGame = doc.game === '' || games.some((game) => game.game === doc.game)
  const gameList = knownGame
    ? games
    : [{ game: doc.game, installed: false, schemaSource: 'none' as const }, ...games]

  return (
    <PixelPanel
      tone="violet"
      glow
      padding="md"
      eyebrow={t('screens.studio.player.eyebrow')}
      title={t('screens.studio.player.title')}
      className="player-panel"
    >
      <div className="player-panel__grid">
        <div className="field player-panel__name">
          <label htmlFor={NAME_FIELD_ID} className="field__label">
            {t('screens.studio.player.name')}
          </label>
          <div
            className="input-frame pixel-border tone-yellow"
            data-invalid={over || nameIssues.length > 0 || undefined}
          >
            <IconUser aria-hidden="true" className="player-panel__icon" />
            <input
              id={NAME_FIELD_ID}
              className="input"
              value={doc.name}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={over || nameIssues.some((issue) => issue.severity === 'error')}
              aria-describedby={`${NAME_FIELD_ID}-hint`}
              onChange={(event) => {
                const name = event.target.value
                onEdit((current) => ({ ...current, name }))
              }}
            />
            <span className="player-panel__count" data-over={over || undefined} aria-hidden="true">
              {length}/{MAX_NAME}
            </span>
          </div>
          <div id={`${NAME_FIELD_ID}-hint`} className="field__hint">
            {nameIssues.length > 0 ? (
              <ul className="player-panel__issues">
                {nameIssues.map((issue, index) => (
                  <li key={index} data-severity={issue.severity}>
                    <IssueText issue={issue} />
                  </li>
                ))}
              </ul>
            ) : over ? (
              <span className="player-panel__over">{t('screens.studio.player.nameTooLong')}</span>
            ) : (
              t('screens.studio.player.nameHint')
            )}
          </div>
        </div>

        <GamePicker
          games={gameList}
          value={doc.game === '' ? null : doc.game}
          onPick={onPickGame}
          className="player-panel__game"
        />

        <div className="field player-panel__description">
          <label htmlFor={descriptionId} className="field__label">
            {t('screens.studio.player.description')}
          </label>
          <div className="input-frame pixel-border tone-yellow">
            <input
              id={descriptionId}
              className="input"
              value={doc.description}
              placeholder={t('screens.studio.player.descriptionPlaceholder')}
              autoComplete="off"
              onChange={(event) => {
                const description = event.target.value
                onEdit((current) => ({ ...current, description }))
              }}
            />
          </div>
        </div>

        {presets !== null && (
          <PresetMenu presets={presets} onApply={onPreset} className="player-panel__presets" />
        )}
      </div>
      {doc.game === '' && Object.hasOwn(doc.extraRoot, 'game') && (
        <p className="player-panel__multi">{t('screens.studio.game.multi')}</p>
      )}
    </PixelPanel>
  )
}
