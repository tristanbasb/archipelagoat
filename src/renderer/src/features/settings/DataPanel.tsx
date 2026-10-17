// The app's own folders: open any of them (app:openPath), and empty the three caches
// (app:clearData) after a confirmation.
import {
  IconBooks,
  IconDatabase,
  IconDownload,
  IconFileText,
  IconFolderOpen,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '@shared/types'
import { cx, toneClass, type Tone } from '../../design/classes'
import { Modal, NeonButton, PixelPanel, useToast } from '../../design/components'
import { useIpcMutation } from '../../hooks/useIpc'
import { useErrorToast } from './feedback'
import { PathText } from './parts'

type ClearTarget = 'downloads' | 'catalog' | 'logs'
type FolderId = 'dataRoot' | 'userData' | ClearTarget

interface Folder {
  id: FolderId
  icon: ReactNode
  tone: Tone
  path: string
  /** What app:clearData empties for this folder, if it can be emptied. */
  clears: ClearTarget | null
}

function folders(info: AppInfo): Folder[] {
  const sep = info.os === 'win32' ? '\\' : '/'
  const inData = (name: ClearTarget): string => `${info.dataRoot.replace(/[\\/]+$/, '')}${sep}${name}`
  return [
    { id: 'dataRoot', icon: <IconDatabase />, tone: 'violet', path: info.dataRoot, clears: null },
    { id: 'userData', icon: <IconSettings />, tone: 'cyan', path: info.userData, clears: null },
    {
      id: 'downloads',
      icon: <IconDownload />,
      tone: 'green',
      path: inData('downloads'),
      clears: 'downloads',
    },
    { id: 'catalog', icon: <IconBooks />, tone: 'yellow', path: inData('catalog'), clears: 'catalog' },
    { id: 'logs', icon: <IconFileText />, tone: 'magenta', path: inData('logs'), clears: 'logs' },
  ]
}

export function DataPanel({ info }: { info: AppInfo }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const showError = useErrorToast()
  const [confirm, setConfirm] = useState<ClearTarget | null>(null)
  const open = useIpcMutation('app:openPath', { onError: showError })
  const clear = useIpcMutation('app:clearData')
  const k = (key: string): string => t(`screens.settings.data.${key}`)

  const runClear = (target: ClearTarget): void => {
    clear.mutate(
      { targets: [target] },
      {
        onSuccess: () => toast.push({ tone: 'ok', title: k(`targets.${target}.done`) }),
        onError: showError,
        onSettled: () => setConfirm(null),
      },
    )
  }

  return (
    <PixelPanel eyebrow={k('eyebrow')} title={k('title')} tone="neutral">
      <ul className="settings-folders">
        {folders(info).map(({ clears, ...folder }) => (
          <li key={folder.id} className="settings-folder">
            <span className={cx('settings-row__icon', toneClass(folder.tone))} aria-hidden="true">
              {folder.icon}
            </span>
            <div className="settings-folder__text">
              <span className="settings-folder__label">{k(`targets.${folder.id}.label`)}</span>
              <span className="settings-folder__hint">{k(`targets.${folder.id}.hint`)}</span>
            </div>
            <PathText path={folder.path} className="settings-folder__path" />
            <div className="settings-folder__actions">
              <NeonButton
                size="sm"
                variant="ghost"
                icon={<IconFolderOpen />}
                aria-label={k(`targets.${folder.id}.open`)}
                onClick={() => open.mutate({ path: folder.path })}
              >
                {k('open')}
              </NeonButton>
              {clears && (
                <NeonButton
                  size="sm"
                  variant="danger"
                  icon={<IconTrash />}
                  aria-label={k(`targets.${clears}.clear`)}
                  onClick={() => setConfirm(clears)}
                >
                  {k('clear')}
                </NeonButton>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Modal
        open={confirm !== null}
        onClose={() => {
          if (!clear.isPending) setConfirm(null)
        }}
        eyebrow={k('confirmEyebrow')}
        title={
          confirm ? t('screens.settings.data.confirmTitle', { action: k(`targets.${confirm}.clear`) }) : ''
        }
        closeLabel={t('common.closeDialog')}
        tone="pink"
        size="sm"
        footer={
          <>
            <NeonButton variant="ghost" disabled={clear.isPending} onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </NeonButton>
            <NeonButton
              variant="danger"
              icon={<IconTrash />}
              loading={clear.isPending}
              onClick={() => confirm && runClear(confirm)}
            >
              {k('clear')}
            </NeonButton>
          </>
        }
      >
        {confirm && <p>{k(`targets.${confirm}.confirm`)}</p>}
      </Modal>
    </PixelPanel>
  )
}
