// A dropped or opened .zip can be a slot's patch file or a bundle of player files: the user says which.
import { IconFileZip, IconPlugConnected, IconUsersGroup } from '@tabler/icons-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Modal, NeonButton } from '../design/components'
import { fileName, useActiveSessionId, useSessionImport } from '../hooks/useOpenRequests'
import { useUiStore } from '../stores/ui'
import './FileChoiceDialog.css'

export function FileChoiceDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const path = useUiStore((state) => state.pendingChoice)
  const clear = useUiStore((state) => state.clearChoice)
  const sessionId = useActiveSessionId()
  const importIntoSession = useSessionImport()

  // The choice dies with the layout (a new window starts clean).
  useEffect(() => clear, [clear])

  const join = (): void => {
    if (!path) return
    clear()
    void navigate(`/join?input=${encodeURIComponent(path)}`)
  }
  const addToSession = (): void => {
    if (!path || !sessionId) return
    clear()
    importIntoSession(sessionId, [path])
  }

  return (
    <Modal
      open={path !== null}
      onClose={clear}
      closeLabel={t('common.closeDialog')}
      tone="cyan"
      size="sm"
      title={t('shell.choice.title')}
      footer={
        <NeonButton variant="ghost" onClick={clear}>
          {t('common.cancel')}
        </NeonButton>
      }
    >
      <div className="file-choice">
        <p className="file-choice__file">
          <IconFileZip aria-hidden="true" />
          <span>{t('shell.choice.body', { name: fileName(path ?? '') })}</span>
        </p>
        <div className="file-choice__options">
          <NeonButton variant="secondary" icon={<IconPlugConnected />} onClick={join}>
            {t('shell.choice.join')}
          </NeonButton>
          {sessionId && (
            <NeonButton variant="secondary" icon={<IconUsersGroup />} onClick={addToSession}>
              {t('shell.choice.session')}
            </NeonButton>
          )}
        </div>
      </div>
    </Modal>
  )
}
