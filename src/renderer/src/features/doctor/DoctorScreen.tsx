import { useTranslation } from 'react-i18next'
import { ScreenStub } from '../../layout/ScreenStub'

/** Placeholder until Task 24 replaces this file with the real screen. */
export function DoctorScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScreenStub eyebrow={t('shell.stub.bonus')} title={t('nav.doctor')} subtitle={t('nav.hints.doctor')} />
  )
}
