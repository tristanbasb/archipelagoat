import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 27 replaces this file with the real screen. */
export function StudioScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub
      eyebrow={t('shell.stub.stage', { n: '04' })}
      title={t('nav.studio')}
      subtitle={t('nav.hints.studio')}
    />
  )
}
