// Small pieces shared by the settings panels.
import { IconRefresh } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cx, toneClass, type Tone } from '../../design/classes'
import { ErrorPanel, NeonButton } from '../../design/components'
import { describeError } from '../../lib/errors'

/** A setting with its icon tile in front. */
export function SettingRow({
  icon,
  tone,
  children,
}: {
  icon: ReactNode
  tone: Tone
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <span className={cx('settings-row__icon', toneClass(tone))} aria-hidden="true">
        {icon}
      </span>
      <div className="settings-row__main">{children}</div>
    </div>
  )
}

/** An IPC error, translated, with a retry button when the failed call can be repeated. */
export function SettingsError({
  error,
  onRetry,
}: {
  error: unknown
  onRetry?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { title, body, detail } = describeError(error, t)
  return (
    <ErrorPanel
      className="settings-error"
      title={title}
      body={body}
      detail={detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        onRetry && (
          <NeonButton size="sm" variant="secondary" icon={<IconRefresh />} onClick={onRetry}>
            {t('common.retry')}
          </NeonButton>
        )
      }
    />
  )
}

/** A file system path, selectable, wrapped anywhere rather than cut. */
export function PathText({ path, className }: { path: string; className?: string }): React.JSX.Element {
  return <code className={cx('settings-path', className)}>{path}</code>
}
