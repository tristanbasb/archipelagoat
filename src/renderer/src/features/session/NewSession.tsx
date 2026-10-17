// /session/new: name a new game, or pick up one already started.
import { IconChevronRight, IconDeviceGamepad2, IconPlayerPlay, IconUsersGroup } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { SessionSummary } from '@shared/types'
import { ErrorPanel, NeonButton, PixelPanel, StatusPill, Stepper } from '../../design/components'
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
  const recent = (sessions.data ?? [])
    .filter((session) => session.status !== 'finished')
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RESUME_MAX)
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
    </div>
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
