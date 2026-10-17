// Settings (spec §4.2.9): appearance, Archipelago's folder, system integration, the GitHub token,
// the app's data folders, and About.
import { useTranslation } from 'react-i18next'
import { useIpcQuery } from '../../hooks/useIpc'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { AboutPanel } from './AboutPanel'
import { ApPathPanel } from './ApPathPanel'
import { DataPanel } from './DataPanel'
import { DisplayPanel, EffectsPanel } from './DisplayPanels'
import { IntegrationPanel } from './IntegrationPanel'
import { SecretsPanel } from './SecretsPanel'
import './SettingsScreen.css'

export function SettingsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  // The shell loaded it before showing any screen: this reads the cache.
  const { data: info } = useIpcQuery('app:getInfo', undefined, { staleTime: Infinity })

  return (
    <>
      <ScreenHeader
        eyebrow={t('screens.settings.eyebrow')}
        title={t('nav.settings')}
        subtitle={t('screens.settings.subtitle')}
      />
      <div className="settings__grid">
        <DisplayPanel locale={info?.locale ?? navigator.language} />
        <EffectsPanel />
        <ApPathPanel />
        {info && <IntegrationPanel os={info.os} />}
        <div className="settings__wide">
          <SecretsPanel />
        </div>
        {info && (
          <>
            <div className="settings__wide">
              <DataPanel info={info} />
            </div>
            <div className="settings__wide">
              <AboutPanel info={info} />
            </div>
          </>
        )}
      </div>
    </>
  )
}
