import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 24 replaces this file with the real screen. */
export function HomeScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub
      eyebrow={t('shell.stub.stage', { n: '01' })}
      title={t('nav.home')}
      subtitle={t('nav.hints.home')}
    />
  )
}
