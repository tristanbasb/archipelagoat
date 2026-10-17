// The bar under each wizard step: back on the left, next on the right with the reason it is locked.
import { IconChevronLeft, IconChevronRight, IconLock } from '@tabler/icons-react'
import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NeonButton } from '../../design/components'

export interface StepNavProps {
  onBack?: () => void
  onNext?: () => void
  nextDisabled?: boolean
  /** Why next is locked, shown beside it and read with it. */
  blockedReason?: ReactNode
  /** Next is saving: a spinner replaces its label. */
  busy?: boolean
}

export function StepNav({
  onBack,
  onNext,
  nextDisabled = false,
  blockedReason,
  busy = false,
}: StepNavProps): React.JSX.Element {
  const { t } = useTranslation()
  const reasonId = useId()
  const showReason = blockedReason !== undefined && blockedReason !== null && nextDisabled
  return (
    <nav className="step-nav" aria-label={t('screens.session.nav.label')}>
      {onBack ? (
        <NeonButton variant="ghost" icon={<IconChevronLeft />} disabled={busy} onClick={onBack}>
          {t('screens.session.nav.back')}
        </NeonButton>
      ) : (
        <span />
      )}
      <div className="step-nav__end">
        {showReason && (
          <p id={reasonId} className="step-nav__reason">
            <IconLock aria-hidden="true" />
            <span>{blockedReason}</span>
          </p>
        )}
        {onNext && (
          <NeonButton
            variant="primary"
            className="step-nav__next"
            disabled={nextDisabled}
            loading={busy}
            loadingLabel={t('screens.session.nav.saving')}
            aria-describedby={showReason ? reasonId : undefined}
            onClick={onNext}
          >
            {t('screens.session.nav.next')}
            <IconChevronRight className="step-nav__chevron" aria-hidden="true" />
          </NeonButton>
        )}
      </div>
    </nav>
  )
}
