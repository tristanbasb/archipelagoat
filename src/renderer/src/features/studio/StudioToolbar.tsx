// The Studio's action bar, sticky over the editor: the file being edited and whether it is saved,
// then New, Open, Export, Add to a game (or back to it) and Save.
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconFileCode,
  IconFileExport,
  IconFilePlus,
  IconFolderOpen,
  IconUsersGroup,
  IconUsersPlus,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { NeonButton, StatusPill, type Status } from '../../design/components'
import { sourceFileName, type StudioSource } from './studio-draft'
import './StudioToolbar.css'

export interface StudioToolbarProps {
  source: StudioSource
  dirty: boolean
  /** A save, an export or an addition is running. */
  busy: boolean
  saving: boolean
  onNew: () => void
  onOpen: () => void
  onExport: () => void
  onAddToSession: () => void
  onSave: () => void
  onBackToSession: () => void
}

export function StudioToolbar({
  source,
  dirty,
  busy,
  saving,
  onNew,
  onOpen,
  onExport,
  onAddToSession,
  onSave,
  onBackToSession,
}: StudioToolbarProps): React.JSX.Element {
  const { t } = useTranslation()
  const status: { status: Status; label: string } = dirty
    ? { status: 'warn', label: t('screens.studio.source.unsaved') }
    : source.kind === 'new'
      ? { status: 'idle', label: t('screens.studio.source.new') }
      : { status: 'ok', label: t('screens.studio.source.saved') }
  const name =
    source.kind === 'file'
      ? sourceFileName(source)
      : t(source.kind === 'session' ? 'screens.studio.source.session' : 'screens.studio.source.new')

  return (
    <div role="group" aria-label={t('screens.studio.actions.label')} className="studio-toolbar pixel-border">
      <div className="studio-toolbar__source">
        <span className="studio-toolbar__icon" aria-hidden="true">
          {source.kind === 'session' ? <IconUsersGroup /> : <IconFileCode />}
        </span>
        <span className="studio-toolbar__file" title={source.kind === 'file' ? source.path : undefined}>
          {name}
        </span>
        {(dirty || source.kind !== 'new') && <StatusPill status={status.status} label={status.label} />}
      </div>
      <div className="studio-toolbar__actions">
        <NeonButton variant="ghost" size="sm" icon={<IconFilePlus />} disabled={busy} onClick={onNew}>
          {t('screens.studio.actions.new')}
        </NeonButton>
        <NeonButton variant="ghost" size="sm" icon={<IconFolderOpen />} disabled={busy} onClick={onOpen}>
          {t('screens.studio.actions.open')}
        </NeonButton>
        <NeonButton
          variant="secondary"
          size="sm"
          icon={<IconFileExport />}
          disabled={busy}
          onClick={onExport}
        >
          {t('screens.studio.actions.export')}
        </NeonButton>
        {source.kind === 'session' ? (
          <NeonButton
            variant="secondary"
            size="sm"
            icon={<IconArrowLeft />}
            disabled={busy}
            onClick={onBackToSession}
          >
            {t('screens.studio.actions.backToSession')}
          </NeonButton>
        ) : (
          <NeonButton
            variant="secondary"
            size="sm"
            icon={<IconUsersPlus />}
            disabled={busy}
            onClick={onAddToSession}
          >
            {t('screens.studio.actions.addToSession')}
          </NeonButton>
        )}
        <NeonButton
          size="sm"
          icon={<IconDeviceFloppy />}
          loading={saving}
          loadingLabel={t('screens.studio.actions.saving')}
          disabled={busy}
          aria-keyshortcuts="Control+S"
          title={t('screens.studio.actions.shortcut')}
          onClick={onSave}
        >
          {source.kind === 'session'
            ? t('screens.studio.actions.saveAndBack')
            : t('screens.studio.actions.save')}
        </NeonButton>
      </div>
    </div>
  )
}
