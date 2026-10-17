import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 32 replaces this file with the real screen. */
export function SettingsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub
      eyebrow={t('shell.stub.stage', { n: '07' })}
      title={t('nav.settings')}
      subtitle={t('nav.hints.settings')}
    />
  )
}
