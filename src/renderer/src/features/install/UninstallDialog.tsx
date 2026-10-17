// Confirms an uninstall, with the "delete my data too" choice (off by default).
import { IconAlertTriangle, IconCheck, IconShieldLock, IconTrash } from '@tabler/icons-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OS } from '@shared/types'
import { Modal, NeonButton } from '../../design/components'
import { sfx } from '../../design/sfx'

export interface UninstallDialogProps {
  open: boolean
  os: OS | null
  onCancel: () => void
  onConfirm: (purgeUserData: boolean) => void
}

export function UninstallDialog({ open, os, onCancel, onConfirm }: UninstallDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const [purge, setPurge] = useState(false)
  // Each opening starts with the box unchecked.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setPurge(false)
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      closeLabel={t('common.closeDialog')}
      tone="pink"
      size="sm"
      eyebrow={t('screens.install.uninstall.dialog.eyebrow')}
      title={t('screens.install.uninstall.dialog.title')}
      footer={
        <>
          <NeonButton variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </NeonButton>
          <NeonButton variant="danger" icon={<IconTrash />} onClick={() => onConfirm(purge)}>
            {purge
              ? t('screens.install.uninstall.dialog.confirmPurge')
              : t('screens.install.uninstall.dialog.confirm')}
          </NeonButton>
        </>
      }
    >
      <div className="install-uninstall">
        <p>{t('screens.install.uninstall.dialog.body')}</p>
        {os === 'win32' && (
          <p className="install-note tone-cyan">
            <IconShieldLock aria-hidden="true" />
            <span>{t('screens.install.uninstall.dialog.uac')}</span>
          </p>
        )}
        <div className="install-check tone-pink">
          <label className="install-check__label" htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              checked={purge}
              aria-describedby={`${id}-hint`}
              onChange={(event) => {
                sfx.play('blip')
                setPurge(event.target.checked)
              }}
            />
            <span className="install-check__box" aria-hidden="true">
              <IconCheck />
            </span>
            {t('screens.install.uninstall.dialog.purge')}
          </label>
          <span id={`${id}-hint`} className="install-check__hint">
            {t('screens.install.uninstall.dialog.purgeHint')}
          </span>
        </div>
        {purge && (
          <p className="install-note tone-pink">
            <IconAlertTriangle aria-hidden="true" />
            <span>{t('screens.install.uninstall.dialog.purgeWarning')}</span>
          </p>
        )}
      </div>
    </Modal>
  )
}
