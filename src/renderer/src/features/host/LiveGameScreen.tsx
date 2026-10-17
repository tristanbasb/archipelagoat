import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 29 replaces this file with the real screen. */
export function LiveGameScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return <ScreenStub eyebrow={t('shell.stub.live')} title={t('nav.play')} subtitle={t('nav.hints.play')} />
}
