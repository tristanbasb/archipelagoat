import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 26 replaces this file with the real screen. */
export function WorldsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub
      eyebrow={t('shell.stub.stage', { n: '05' })}
      title={t('nav.worlds')}
      subtitle={t('nav.hints.worlds')}
    />
  )
}
