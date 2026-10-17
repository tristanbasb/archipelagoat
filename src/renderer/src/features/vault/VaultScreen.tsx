import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 31 replaces this file with the real screen. */
export function VaultScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub
      eyebrow={t('shell.stub.stage', { n: '06' })}
      title={t('nav.vault')}
      subtitle={t('nav.hints.vault')}
    />
  )
}
