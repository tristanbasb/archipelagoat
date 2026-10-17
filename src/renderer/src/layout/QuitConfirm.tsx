// Closing the window while servers or tasks run: the main process asks (app:quitRequested), the user
// answers here (app:confirmQuit).
import { IconLoader2, IconServer2 } from '@tabler/icons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuitRequest } from '@shared/types'
import { Modal, NeonButton } from '../design/components'
import { useEvent } from '../hooks/useEvent'
import { useIpcMutation, useIpcQuery } from '../hooks/useIpc'
import './QuitConfirm.css'

export function QuitConfirm(): React.JSX.Element {
  const { t } = useTranslation()
  const [request, setRequest] = useState<QuitRequest | null>(null)
  const [quitting, setQuitting] = useState(false)
  const confirmQuit = useIpcMutation('app:confirmQuit')
  const sessions = useIpcQuery('session:list', undefined, {
    enabled: (request?.runningServers.length ?? 0) > 0,
  })

  useEvent('app:quitRequested', (next) => {
    setQuitting(false)
    setRequest(next)
  })

  const answer = (confirm: boolean): void => {
    if (!request) return
    confirmQuit.mutate({ requestId: request.requestId, confirm })
    if (confirm) setQuitting(true)
    else setRequest(null)
  }

  const names = new Map((sessions.data ?? []).map((session) => [session.id, session.name]))
  const servers = request?.runningServers ?? []
  const tasks = request?.runningTasks ?? []

  return (
    <Modal
      open={request !== null}
      onClose={() => answer(false)}
      dismissible={!quitting}
      closeLabel={t('common.closeDialog')}
      tone="pink"
      size="sm"
      eyebrow={t('shell.quit.eyebrow')}
      title={t('shell.quit.title')}
      footer={
        <>
          <NeonButton variant="secondary" onClick={() => answer(false)} disabled={quitting}>
            {t('shell.quit.stay')}
          </NeonButton>
          <NeonButton
            variant="danger"
            onClick={() => answer(true)}
            loading={quitting}
            loadingLabel={t('shell.quit.quitting')}
          >
            {t('shell.quit.quit')}
          </NeonButton>
        </>
      }
    >
      <div className="quit-confirm">
        <p>{t('shell.quit.body')}</p>
        {servers.length > 0 && (
          <section className="quit-confirm__group" aria-label={t('shell.quit.servers')}>
            <h3>{t('shell.quit.servers')}</h3>
            <ul>
              {servers.map((id) => (
                <li key={id}>
                  <IconServer2 aria-hidden="true" />
                  <span>{names.get(id) ?? id}</span>
                </li>
              ))}
            </ul>
            <p className="quit-confirm__note">{t('shell.quit.serversNote')}</p>
          </section>
        )}
        {tasks.length > 0 && (
          <section className="quit-confirm__group" aria-label={t('shell.quit.tasks')}>
            <h3>{t('shell.quit.tasks')}</h3>
            <ul>
              {tasks.map((kind, index) => (
                <li key={`${kind}-${index}`}>
                  <IconLoader2 aria-hidden="true" />
                  <span>{t(`tasks.kinds.${kind}`)}</span>
                </li>
              ))}
            </ul>
            <p className="quit-confirm__note">{t('shell.quit.tasksNote')}</p>
          </section>
        )}
      </div>
    </Modal>
  )
}
