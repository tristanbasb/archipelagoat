// The Studio with nothing to edit yet: pick a game (or open a YAML).
import { IconFolderOpen } from '@tabler/icons-react'
import type { UseQueryResult } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { GoatError } from '@shared/errors'
import type { StudioGame } from '@shared/types'
import { EmptyState, NeonButton, PixelPanel, Spinner } from '../../design/components'
import { GamePicker, GamesError } from './GamePicker'
import './StudioStart.css'

export interface StudioStartProps {
  games: UseQueryResult<StudioGame[], GoatError>
  /** The game whose schema is being read. */
  picking: string | null
  onPick: (game: StudioGame) => void
  onOpen: () => void
}

export function StudioStart({ games, picking, onPick, onOpen }: StudioStartProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <PixelPanel
      tone="violet"
      glow
      padding="lg"
      eyebrow={t('screens.studio.start.eyebrow')}
      title={t('screens.studio.start.title')}
      className="studio-start"
    >
      <p className="studio-start__body">{t('screens.studio.start.body')}</p>
      {games.isPending && <Spinner label={t('screens.studio.game.loading')} />}
      {games.error && <GamesError error={games.error} onRetry={() => void games.refetch()} />}
      {games.data?.length === 0 && (
        <EmptyState
          title={t('screens.studio.game.noneTitle')}
          body={t('screens.studio.game.noneBody')}
          action={
            <div className="studio-start__links">
              <NeonButton variant="secondary" onClick={() => void navigate('/install')}>
                {t('screens.studio.game.toInstall')}
              </NeonButton>
              <NeonButton variant="ghost" onClick={() => void navigate('/worlds')}>
                {t('nav.worlds')}
              </NeonButton>
            </div>
          }
        />
      )}
      {games.data && games.data.length > 0 && (
        <GamePicker
          games={games.data}
          value={picking}
          onPick={onPick}
          showStatus={false}
          className="studio-start__picker"
        />
      )}
      {picking !== null && (
        <Spinner label={t('screens.studio.start.loading')} className="studio-start__picking" />
      )}
      <div className="studio-start__or" aria-hidden="true">
        <span>{t('screens.studio.start.or')}</span>
      </div>
      <NeonButton variant="ghost" icon={<IconFolderOpen />} onClick={onOpen} className="studio-start__open">
        {t('screens.studio.start.open')}
      </NeonButton>
    </PixelPanel>
  )
}
