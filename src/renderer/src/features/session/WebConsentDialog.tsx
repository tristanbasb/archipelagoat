// The consent asked before every archipelago.gg hosting (spec §6.2): the zip holds the game's
// passwords in plain text, and anyone with the link can reach the room.
import { IconCheck, IconCloudUpload, IconKey, IconLink, IconLockOpen } from '@tabler/icons-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, NeonButton } from '../../design/components'
import { sfx } from '../../design/sfx'
import './WebConsentDialog.css'

export interface WebConsentDialogProps {
  open: boolean
  /** The game has a players' or an admin password. */
  hasPassword: boolean
  acknowledged: boolean
  onAcknowledge: (checked: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

export function WebConsentDialog({
  open,
  hasPassword,
  acknowledged,
  onAcknowledge,
  onConfirm,
  onCancel,
}: WebConsentDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const ackId = useId()
  return (
    <Modal
      open={open}
      onClose={onCancel}
      closeLabel={t('common.closeDialog')}
      tone="yellow"
      size="md"
      eyebrow={t('screens.session.consent.eyebrow')}
      title={t('screens.session.consent.title')}
      footer={
        <>
          <NeonButton variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </NeonButton>
          <NeonButton icon={<IconCloudUpload />} disabled={!acknowledged} onClick={onConfirm}>
            {t('screens.session.consent.confirm')}
          </NeonButton>
        </>
      }
    >
      <div className="consent">
        <p className="consent__intro">{t('screens.session.consent.intro')}</p>
        <ul className="consent__points">
          <li className="tone-pink">
            <IconKey className="consent__icon" aria-hidden="true" />
            <span>
              {t('screens.session.consent.passwords')}{' '}
              <strong>
                {hasPassword
                  ? t('screens.session.consent.passwordsSet')
                  : t('screens.session.consent.passwordsNone')}
              </strong>
            </span>
          </li>
          <li className="tone-yellow">
            <IconLink className="consent__icon" aria-hidden="true" />
            <span>{t('screens.session.consent.public')}</span>
          </li>
          <li className="tone-neutral">
            <IconLockOpen className="consent__icon" aria-hidden="true" />
            <span>{t('screens.session.consent.eachTime')}</span>
          </li>
        </ul>
        <label className="consent__ack pixel-border tone-yellow" htmlFor={ackId}>
          <input
            id={ackId}
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => {
              sfx.play('blip')
              onAcknowledge(event.target.checked)
            }}
          />
          <span className="consent__box" aria-hidden="true">
            <IconCheck />
          </span>
          <span>{t('screens.session.consent.ack')}</span>
        </label>
      </div>
    </Modal>
  )
}
