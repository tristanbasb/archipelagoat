import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 30 replaces this file with the real screen. */
export function JoinScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub
      eyebrow={t('shell.stub.stage', { n: '03' })}
      title={t('nav.join')}
      subtitle={t('nav.hints.join')}
    />
  )
}
