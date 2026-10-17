import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 25 replaces this file with the real screen. */
export function InstallScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub eyebrow={t('shell.stub.bonus')} title={t('nav.install')} subtitle={t('nav.hints.install')} />
  )
}
