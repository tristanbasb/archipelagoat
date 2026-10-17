// "Ajouter à une partie": the games being set up (session:list), one click to copy the YAML in.
import { IconChevronRight, IconPlus, IconUsersGroup } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { SessionSummary } from '@shared/types'
import { EmptyState, ErrorPanel, Modal, NeonButton, Spinner, StatusPill } from '../../design/components'
import { useIpcQuery } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import './SessionPicker.css'

/** A player can still join these games (a generated one is generated again). */
const OPEN_STATUSES: ReadonlySet<SessionSummary['status']> = new Set(['draft', 'generated'])

export interface SessionPickerProps {
  open: boolean
  onClose: () => void
  onPick: (session: SessionSummary) => void
  /** The session being added to. */
  busyId: string | null
}

export function SessionPicker({ open, onClose, onPick, busyId }: SessionPickerProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const sessions = useIpcQuery('session:list', undefined, { enabled: open })
  const list = (sessions.data ?? [])
    .filter((session) => OPEN_STATUSES.has(session.status))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const failure = sessions.error ? describeError(sessions.error, t) : null
  const date = (iso: string): string =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso))

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={busyId === null}
      closeLabel={t('common.closeDialog')}
      tone="cyan"
      eyebrow={t('screens.studio.session.eyebrow')}
      title={t('screens.studio.session.title')}
    >
      <p className="session-picker__body">{t('screens.studio.session.body')}</p>
      {sessions.isPending && <Spinner label={t('common.loading')} className="session-picker__loading" />}
      {failure && (
        <ErrorPanel
          title={failure.title}
          body={failure.body}
          detail={failure.detail}
          detailLabel={t('common.technicalDetails')}
        />
      )}
      {sessions.data && list.length === 0 && (
        <EmptyState
          tone="cyan"
          icon={<IconUsersGroup />}
          title={t('screens.studio.session.empty')}
          body={t('screens.studio.session.emptyBody')}
          action={
            <NeonButton variant="secondary" icon={<IconPlus />} onClick={() => void navigate('/session/new')}>
              {t('screens.studio.session.create')}
            </NeonButton>
          }
        />
      )}
      {list.length > 0 && (
        <ul className="session-picker__list" aria-label={t('screens.studio.session.listLabel')}>
          {list.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="session-row pixel-border"
                disabled={busyId !== null}
                aria-busy={busyId === session.id || undefined}
                onClick={() => onPick(session)}
              >
                <span className="session-row__icon" aria-hidden="true">
                  <IconUsersGroup />
                </span>
                <span className="session-row__text">
                  <span className="session-row__name">{session.name}</span>
                  <span className="session-row__meta">
                    {t('screens.studio.session.players', { count: session.playerCount })} ·{' '}
                    {date(session.updatedAt)}
                  </span>
                </span>
                <StatusPill
                  status={session.status === 'draft' ? 'idle' : 'ok'}
                  label={t(`screens.studio.session.status.${session.status}`)}
                />
                {busyId === session.id ? (
                  <Spinner size="sm" label={t('screens.studio.session.adding')} />
                ) : (
                  <IconChevronRight aria-hidden="true" className="session-row__go" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
