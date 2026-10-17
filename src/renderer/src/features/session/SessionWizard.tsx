import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 28 replaces this file with the real screen. */
export function SessionWizard(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub
      eyebrow={t('shell.stub.stage', { n: '02' })}
      title={t('nav.session')}
      subtitle={t('nav.hints.session')}
    />
  )
}
