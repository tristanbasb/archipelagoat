// The status bar: Archipelago version, server state, running tasks, health check and language.
import { IconLanguage, IconStethoscope } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import type { ApInstall, Lang, ServerState, SessionSummary } from '@shared/types'
import { Spinner, StatusPill, type Status } from '../design/components'
import { useEvent } from '../hooks/useEvent'
import { useIpcQuery } from '../hooks/useIpc'
import { useConfig } from '../stores/config'
import { useTasksStore, type TaskEntry } from '../stores/tasks'
import './StatusBar.css'

interface Pill {
  status: Status
  label: string
  /** Where clicking it leads, if anywhere. */
  to?: string
  hint?: string
}

function useApPill(): Pill {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const ap = useIpcQuery('ap:detect', undefined)
  useEvent('ap:installed', () => void queryClient.invalidateQueries({ queryKey: ['ap:detect'] }))
  const base = { to: '/install', hint: t('shell.status.apHint') }
  if (ap.isPending) return { ...base, status: 'busy', label: t('shell.status.apChecking') }
  if (ap.isError) return { ...base, status: 'idle', label: t('shell.status.apUnavailable') }
  return { ...base, ...apStatus(ap.data, t) }
}

function apStatus(install: ApInstall | null, t: TFunction): Omit<Pill, 'to'> {
  if (!install) return { status: 'error', label: t('shell.status.apMissing') }
  if (!install.version) return { status: 'warn', label: t('shell.status.apUnknownVersion') }
  // The app targets the 0.6 series; anything else works less well.
  const status: Status = install.version.startsWith('0.6.') ? 'ok' : 'warn'
  return { status, label: t('shell.status.apVersion', { version: install.version }) }
}

function useServerPill(): Pill {
  const { t } = useTranslation()
  const [servers, setServers] = useState<Record<string, ServerState>>({})
  const sessions = useIpcQuery('session:list', undefined)
  useEvent('server:state', (state) => {
    setServers((current) => {
      const next = { ...current }
      if (state.status === 'stopped') delete next[state.sessionId]
      else next[state.sessionId] = state
      return next
    })
  })

  const local = Object.values(servers)
  const hint = t('shell.status.serverHint')
  const ready = local.find((server) => server.status === 'ready')
  if (ready) {
    return {
      status: 'ok',
      label: t('shell.status.serverLocal', { port: ready.port }),
      to: `/play/${ready.sessionId}`,
      hint,
    }
  }
  const busy = local.find((server) => server.status === 'starting' || server.status === 'stopping')
  if (busy)
    return { status: 'busy', label: t('shell.status.serverStarting'), to: `/play/${busy.sessionId}`, hint }
  const crashed = local.find((server) => server.status === 'crashed')
  if (crashed)
    return { status: 'error', label: t('shell.status.serverCrashed'), to: `/play/${crashed.sessionId}`, hint }
  const web = (sessions.data ?? []).find(
    (session: SessionSummary) => session.status === 'hosting' && session.hostingMode === 'web',
  )
  if (web) return { status: 'info', label: t('shell.status.serverWeb'), to: `/play/${web.id}`, hint }
  return { status: 'idle', label: t('shell.status.serverOff') }
}

function PillItem({ pill }: { pill: Pill }): React.JSX.Element {
  const navigate = useNavigate()
  const content = <StatusPill status={pill.status} label={pill.label} />
  if (!pill.to) return <span className="status-bar__item">{content}</span>
  const to = pill.to
  return (
    <button
      type="button"
      className="status-bar__item status-bar__button"
      title={pill.hint}
      onClick={() => void navigate(to)}
    >
      {content}
    </button>
  )
}

function RunningTasks(): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const running = useTasksStore(
    useShallow((state) =>
      Object.values(state.tasks).filter(
        (task): task is TaskEntry & { kind: NonNullable<TaskEntry['kind']> } =>
          task.status === 'running' && task.kind !== null,
      ),
    ),
  )
  const [first, ...others] = running
  if (!first) return null
  const percent = first.progress?.percent ?? null
  const format = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 0 })
  return (
    <span
      className="status-bar__item status-bar__task tone-violet"
      title={t('tasks.running', { count: running.length })}
    >
      <Spinner size="sm" />
      <span className="status-bar__task-label">{t(`tasks.kinds.${first.kind}`)}</span>
      {percent !== null && (
        <>
          <span className="status-bar__meter" aria-hidden="true">
            <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
          </span>
          <span className="status-bar__percent">{format.format(percent / 100)}</span>
        </>
      )}
      {others.length > 0 && (
        <span className="status-bar__more">{t('shell.status.tasksMore', { count: others.length })}</span>
      )}
    </span>
  )
}

function LanguageButton(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const config = useConfig()
  const current = (i18n.language === 'en' ? 'en' : 'fr') satisfies Lang
  const other: Lang = current === 'fr' ? 'en' : 'fr'
  return (
    <button
      type="button"
      className="status-bar__item status-bar__button status-bar__lang"
      aria-label={t('shell.status.language', { language: t(`languages.${current}`) })}
      title={t('shell.status.language', { language: t(`languages.${current}`) })}
      onClick={() => void config.set({ language: other }).catch(() => undefined)}
    >
      <IconLanguage aria-hidden="true" />
      <span>{current.toUpperCase()}</span>
    </button>
  )
}

export function StatusBar(): React.JSX.Element {
  const { t } = useTranslation()
  const ap = useApPill()
  const server = useServerPill()
  const info = useIpcQuery('app:getInfo', undefined, { staleTime: Infinity })

  return (
    <footer className="status-bar" aria-label={t('shell.status.label')}>
      <div className="status-bar__group">
        <PillItem pill={ap} />
        <PillItem pill={server} />
        <RunningTasks />
      </div>
      <div className="status-bar__group">
        <Link to="/doctor" className="status-bar__item status-bar__button status-bar__link">
          <IconStethoscope aria-hidden="true" />
          <span>{t('shell.status.doctor')}</span>
        </Link>
        <LanguageButton />
        {info.data && (
          <span className="status-bar__version">
            {t('shell.status.version', { version: info.data.version })}
          </span>
        )}
      </div>
    </footer>
  )
}
