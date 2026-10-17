// The options of the next install: desktop icons (Windows) and, folded away, a custom folder.
import { IconChevronRight, IconFolder, IconRestore } from '@tabler/icons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OS } from '@shared/types'
import { NeonButton, PixelPanel, Toggle, useToast } from '../../design/components'
import { useIpcMutation } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'

export interface InstallOptionsProps {
  os: OS | null
  desktopIcons: boolean
  onDesktopIcons: (on: boolean) => void
  /** Null for the installer's default folder. */
  customDir: string | null
  onCustomDir: (dir: string | null) => void
}

export function InstallOptions({
  os,
  desktopIcons,
  onDesktopIcons,
  customDir,
  onCustomDir,
}: InstallOptionsProps): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  // The advanced part starts unfolded when a folder is already chosen, then follows the user.
  const [openAtFirst] = useState(customDir !== null)
  const pick = useIpcMutation('app:pickPaths', {
    onSuccess: ([dir]) => {
      if (dir) onCustomDir(dir)
    },
    onError: (error) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
  })

  return (
    <PixelPanel title={t('screens.install.options.title')} className="install-options">
      {os === 'win32' && (
        <Toggle
          checked={desktopIcons}
          onChange={onDesktopIcons}
          label={t('screens.install.options.desktopIcons')}
          description={t('screens.install.options.desktopIconsHint')}
        />
      )}
      <details className="install-advanced" open={openAtFirst || undefined}>
        <summary>
          <IconChevronRight className="install-advanced__chevron" aria-hidden="true" />
          {t('screens.install.options.advanced')}
        </summary>
        <div className="install-advanced__body">
          <div className="field">
            <span className="field__label">{t('screens.install.options.dir')}</span>
            <span
              className="install-path"
              data-default={customDir === null || undefined}
              title={customDir ?? undefined}
            >
              <IconFolder aria-hidden="true" />
              <span className="install-path__text">
                {customDir ?? t('screens.install.options.dirDefault')}
              </span>
            </span>
            <span className="field__hint">
              {os === 'linux'
                ? t('screens.install.options.dirHintLinux')
                : t('screens.install.options.dirHintWin')}
            </span>
          </div>
          <div className="install-advanced__actions">
            <NeonButton
              size="sm"
              variant="secondary"
              icon={<IconFolder />}
              loading={pick.isPending}
              onClick={() =>
                pick.mutate({ mode: 'directory', title: t('screens.install.options.pickTitle') })
              }
            >
              {t('screens.install.options.dirPick')}
            </NeonButton>
            {customDir !== null && (
              <NeonButton size="sm" variant="ghost" icon={<IconRestore />} onClick={() => onCustomDir(null)}>
                {t('screens.install.options.dirReset')}
              </NeonButton>
            )}
          </div>
        </div>
      </details>
    </PixelPanel>
  )
}
