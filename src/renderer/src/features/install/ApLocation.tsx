// Which Archipelago the app uses: the detected folder, or one the user points it at.
import { IconFolderSearch, IconInfoCircle, IconRestore } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ApInstall } from '@shared/types'
import { CopyField, NeonButton, PixelPanel, useToast } from '../../design/components'
import { useIpcMutation } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import { canUninstall, DETECT_KEY, isHandPicked } from './install-model'
import { InstallError } from './InstallError'

export function ApLocation({ install }: { install: ApInstall | null }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()

  const setPath = useIpcMutation('ap:setCustomPath', {
    onSuccess: (found, { path }) => {
      queryClient.setQueryData(DETECT_KEY, found)
      toast.push({
        tone: 'ok',
        title:
          path === null ? t('screens.install.location.autoToast') : t('screens.install.location.usedToast'),
      })
    },
  })
  const pick = useIpcMutation('app:pickPaths', {
    onSuccess: ([dir]) => {
      if (dir) setPath.mutate({ path: dir })
    },
    onError: (error) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
  })

  const busy = pick.isPending || setPath.isPending
  const choose = (): void => {
    setPath.reset()
    pick.mutate({ mode: 'directory', title: t('screens.install.location.pickTitle') })
  }
  const notFound = setPath.error?.code === 'AP_NOT_INSTALLED'

  return (
    <PixelPanel title={t('screens.install.location.title')} className="install-location">
      {install ? (
        <CopyField
          label={
            install.appImagePath ? t('screens.install.location.appImage') : t('screens.install.location.path')
          }
          value={install.appImagePath ?? install.root}
          copyLabel={t('common.copy')}
          copiedLabel={t('common.copied')}
        />
      ) : null}
      <p className="install-location__body">
        {install ? t('screens.install.location.installedBody') : t('screens.install.location.missingBody')}
      </p>
      {isHandPicked(install) && (
        <p className="install-note tone-cyan">
          <IconInfoCircle aria-hidden="true" />
          <span>{t('screens.install.location.customNote')}</span>
        </p>
      )}
      {install && !isHandPicked(install) && !canUninstall(install) && (
        <p className="install-note tone-neutral">
          <IconInfoCircle aria-hidden="true" />
          <span>{t('screens.install.location.foreignNote')}</span>
        </p>
      )}
      {setPath.error && (
        <InstallError
          className="install-location__error"
          error={setPath.error}
          title={notFound ? t('screens.install.location.notFoundTitle') : undefined}
          body={notFound ? t('screens.install.location.notFoundBody') : undefined}
        />
      )}
      <div className="install-location__actions">
        <NeonButton size="sm" variant="secondary" icon={<IconFolderSearch />} loading={busy} onClick={choose}>
          {t('screens.install.location.pick')}
        </NeonButton>
        {isHandPicked(install) && (
          <NeonButton
            size="sm"
            variant="ghost"
            icon={<IconRestore />}
            disabled={busy}
            onClick={() => {
              setPath.reset()
              setPath.mutate({ path: null })
            }}
          >
            {t('screens.install.location.auto')}
          </NeonButton>
        )}
      </div>
    </PixelPanel>
  )
}
