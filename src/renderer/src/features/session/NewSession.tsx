// /session/new: name a new game, pick up one already started, or reach any game (finished ones
// included) and delete one, which moves its folder to the app's backups.
import {
  IconChevronRight,
  IconDeviceGamepad2,
  IconPlayerPlay,
  IconTrash,
  IconUsersGroup,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { SessionSummary } from '@shared/types'
import {
  ConfirmDialog,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  StatusPill,
  Stepper,
  useToast,
} from '../../design/components'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { describeError } from '../../lib/errors'
import { STATUS_PILL, STEP_IDS } from './steps'

const RESUME_MAX = 6

export function NewSession(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const nameId = useId()
  const [name, setName] = useState(() =>
    t('screens.session.new.defaultName', {
      date: new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'long' }).format(new Date()),
    }),
  )
  const sessions = useIpcQuery('session:list', undefined)
  const create = useIpcMutation('session:create', {
    invalidates: ['session:list'],
    onSuccess: (session) => {
      queryClient.setQueryData(['session:get', { id: session.id }], session)
      void navigate(`/session/${session.id}?step=1`, { replace: true })
    },
  })

  const trimmed = name.trim()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (trimmed && !create.isPending) create.mutate({ name: trimmed })
  }
  const all = (sessions.data ?? []).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const recent = all.filter((session) => session.status !== 'finished').slice(0, RESUME_MAX)
  const failure = create.error ? describeError(create.error, t) : null

  return (
    <div className="wizard">
      <ScreenHeader
        eyebrow={t('screens.session.new.eyebrow')}
        title={t('nav.session')}
        subtitle={t('nav.hints.session')}
      />
      <Stepper
        className="wizard__stepper"
        label={t('screens.session.stepsLabel')}
        current=""
        steps={STEP_IDS.map((sid) => ({ id: sid, label: t(`screens.session.steps.${sid}`) }))}
      />
      <div className="new-session" data-resume={recent.length > 0 || undefined}>
        <PixelPanel
          tone="violet"
          glow
          padding="lg"
          eyebrow={t('screens.session.new.eyebrow')}
          title={t('screens.session.new.title')}
          className="new-session__create"
        >
          <form className="new-session__form" onSubmit={submit}>
            <p className="new-session__body">{t('screens.session.new.body')}</p>
            <div className="field">
              <label htmlFor={nameId} className="field__label">
                {t('screens.session.new.nameLabel')}
              </label>
              <div className="input-frame pixel-border tone-yellow">
                <IconDeviceGamepad2 className="new-session__field-icon" aria-hidden="true" />
                <input
                  id={nameId}
                  className="input"
                  value={name}
                  maxLength={80}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>
            <NeonButton
              type="submit"
              size="lg"
              icon={<IconPlayerPlay />}
              disabled={!trimmed}
              loading={create.isPending}
              loadingLabel={t('screens.session.new.creating')}
              className="new-session__submit"
            >
              {t('screens.session.new.create')}
            </NeonButton>
            {failure && (
              <ErrorPanel
                title={failure.title}
                body={failure.body}
                detail={failure.detail}
                detailLabel={t('common.technicalDetails')}
              />
            )}
          </form>
        </PixelPanel>

        {recent.length > 0 && (
          <PixelPanel
            tone="cyan"
            padding="md"
            eyebrow={t('screens.session.new.resumeEyebrow')}
            title={t('screens.session.new.resumeTitle')}
            className="new-session__resume"
          >
            <ul className="resume-list">
              {recent.map((session) => (
                <ResumeRow key={session.id} session={session} />
              ))}
            </ul>
          </PixelPanel>
        )}
      </div>
      {all.length > 0 && <AllGames sessions={all} />}
    </div>
  )
}

/** Every game, finished ones included, with the way to delete one (moved to the app's backups). */
function AllGames({ sessions }: { sessions: SessionSummary[] }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const remove = useIpcMutation('session:delete', {
    invalidates: ['session:list'],
    onError: (error) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
  })
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })
  return (
    <PixelPanel
      tone="neutral"
      padding="md"
      eyebrow={t('screens.session.new.allEyebrow')}
      title={t('screens.session.new.allTitle', { count: sessions.length })}
      className="all-games"
    >
      <ul className="all-games__list" aria-label={t('screens.session.new.allLabel')}>
        {sessions.map((session) => (
          <li key={session.id} className="all-games__row pixel-border">
            <span className="all-games__name">{session.name}</span>
            <span className="all-games__meta">
              {t('screens.session.new.players', { count: session.playerCount })}
              {' · '}
              {t('screens.session.new.updated', { date: format.format(new Date(session.updatedAt)) })}
            </span>
            <StatusPill
              status={STATUS_PILL[session.status]}
              label={t(`screens.session.status.${session.status}`)}
            />
            <NeonButton
              variant="ghost"
              size="sm"
              aria-label={t('screens.session.new.openGame', { name: session.name })}
              onClick={() =>
                void navigate(session.status === 'hosting' ? `/play/${session.id}` : `/session/${session.id}`)
              }
            >
              {t('screens.session.new.open')}
            </NeonButton>
            <button
              type="button"
              className="icon-btn icon-btn--danger"
              aria-label={t('screens.session.new.delete', { name: session.name })}
              disabled={remove.isPending && remove.variables.id === session.id}
              onClick={() => setDeleting(session)}
            >
              <IconTrash aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={deleting !== null}
        tone="pink"
        eyebrow={t('screens.session.new.deleteEyebrow')}
        title={t('screens.session.new.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('screens.session.new.deleteConfirm')}
        confirmVariant="danger"
        confirmIcon={<IconTrash />}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.closeDialog')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const session = deleting
          setDeleting(null)
          if (!session) return
          remove.mutate(
            { id: session.id },
            {
              onSuccess: () =>
                toast.push({ tone: 'info', title: t('screens.session.new.deleted', { name: session.name }) }),
            },
          )
        }}
      >
        <p>{t('screens.session.new.deleteBody')}</p>
        {deleting?.status === 'hosting' && (
          <p className="confirm-dialog__note">{t('screens.session.new.deleteLive')}</p>
        )}
      </ConfirmDialog>
    </PixelPanel>
  )
}

function ResumeRow({ session }: { session: SessionSummary }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const live = session.status === 'hosting'
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
    new Date(session.updatedAt),
  )
  return (
    <li>
      <button
        type="button"
        className="resume-row pixel-border"
        onClick={() => void navigate(live ? `/play/${session.id}` : `/session/${session.id}`)}
      >
        <span className="resume-row__icon" aria-hidden="true">
          <IconUsersGroup />
        </span>
        <span className="resume-row__text">
          <span className="resume-row__name">{session.name}</span>
          <span className="resume-row__meta">
            {t('screens.session.new.players', { count: session.playerCount })}
            {' · '}
            {t('screens.session.new.updated', { date })}
          </span>
        </span>
        <StatusPill
          status={STATUS_PILL[session.status]}
          label={t(`screens.session.status.${session.status}`)}
        />
        <span className="resume-row__go">
          {live ? t('screens.session.new.watch') : t('screens.session.new.resume')}
          <IconChevronRight aria-hidden="true" />
        </span>
      </button>
    </li>
  )
}
