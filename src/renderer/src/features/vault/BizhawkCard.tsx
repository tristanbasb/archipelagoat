// BizHawk: its state, its prerequisites (with the command to copy on Linux), installing the pinned
// version, adopting an existing folder, and pointing Archipelago at it.
import { useQueryClient } from '@tanstack/react-query'
import {
  IconCheck,
  IconDeviceGamepad2,
  IconDownload,
  IconExternalLink,
  IconFolderOpen,
  IconPlugConnected,
  IconRefresh,
  IconUnlink,
  IconX,
} from '@tabler/icons-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BIZHAWK_TAG } from '@shared/data/ap-constants'
import type { BizhawkState } from '@shared/types'
import {
  CopyField,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  ProgressBar,
  Spinner,
  StatusPill,
  useToast,
  type Status,
} from '../../design/components'
import { useEvent } from '../../hooks/useEvent'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useTask } from '../../hooks/useTask'
import { describeError } from '../../lib/errors'
import { invoke } from '../../lib/goat'
import { errorPanelProps } from './error-props'
import { useRunningTask } from './useRunningTask'
import './BizhawkCard.css'

export type BizhawkStatus = 'ready' | 'missing' | 'prereqs' | 'configure'

/** Where BizHawk stands, the first thing left to do first. */
export function bizhawkStatus(state: BizhawkState): BizhawkStatus {
  if (!state.installed) return 'missing'
  if (state.prereqs.some((prereq) => !prereq.ok)) return 'prereqs'
  if (!state.configuredInAp) return 'configure'
  return 'ready'
}

const BIZHAWK_PILL: Record<BizhawkStatus, Status> = {
  ready: 'ok',
  missing: 'idle',
  prereqs: 'warn',
  configure: 'warn',
}

/** '2.11.1.0' (a Windows file version) is 2.11.1. */
const sameVersion = (a: string, b: string): boolean => a.replace(/(\.0)+$/, '') === b.replace(/(\.0)+$/, '')

/**
 * Whether to offer the pinned version: nothing installed, or another version. A managed install is
 * the pinned one even when its version cannot be read; an external one of unknown version may not be.
 */
function offersPinned(state: BizhawkState): boolean {
  if (!state.installed) return true
  if (state.version === null) return !state.managed
  return !sameVersion(state.version, BIZHAWK_TAG)
}

const STATE_KEY = ['bizhawk:state', undefined] as const

type PrereqKind = 'version' | 'mono' | 'lua' | 'lsb' | 'openal' | 'vcredist'

/** What a prerequisite is for, from its technical name; null for a name the screen does not know. */
function prereqKind(name: string): PrereqKind | null {
  const id = name.toLowerCase()
  if (id.includes('version')) return 'version'
  if (id.includes('mono')) return 'mono'
  if (id.includes('lua')) return 'lua'
  if (id.includes('lsb')) return 'lsb'
  if (id.includes('openal')) return 'openal'
  if (id.includes('vc') || id.includes('visual')) return 'vcredist'
  return null
}

const isLink = (hint: string): boolean => /^https:\/\//i.test(hint)

function isBizhawkState(value: unknown): value is BizhawkState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BizhawkState).installed === 'boolean' &&
    Array.isArray((value as BizhawkState).prereqs)
  )
}

export function BizhawkCard(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const query = useIpcQuery('bizhawk:state', undefined)
  const [installId, setInstallId] = useState<string | null>(null)
  const runningId = useRunningTask('bizhawk-install')
  const install = useTask(runningId ?? installId)
  const installing = install.status === 'running'

  const showState = (next: BizhawkState): void => {
    queryClient.setQueryData(STATE_KEY, next)
  }

  const toastError = (error: unknown): void => {
    const { title, body } = describeError(error, t)
    toast.push({ tone: 'error', title, body })
  }

  // Whoever started it (this card, the Join screen), a finished install brings the new state.
  useEvent('task:done', ({ kind, result }) => {
    if (kind !== 'bizhawk-install') return
    const next = isBizhawkState(result) ? result : null
    if (next) showState(next)
    else void queryClient.invalidateQueries({ queryKey: ['bizhawk:state'] })
    toast.push({
      tone: 'ok',
      title: t('screens.vault.bizhawk.installed', { version: next?.version ?? BIZHAWK_TAG }),
    })
  })

  const startInstall = useIpcMutation('bizhawk:install', { onSuccess: ({ taskId }) => setInstallId(taskId) })
  const configure = useIpcMutation('bizhawk:configureAp', {
    onSuccess: (next) => {
      showState(next)
      toast.push({ tone: 'ok', title: t('screens.vault.bizhawk.configuredToast') })
    },
  })
  const setPath = useIpcMutation('bizhawk:setPath', {
    onSuccess: (next, input) => {
      showState(next)
      toast.push({
        tone: 'ok',
        title: t(input?.path ? 'screens.vault.bizhawk.chosen' : 'screens.vault.bizhawk.forgotten'),
      })
    },
  })

  /** A new action replaces the error of the previous one. */
  const clearErrors = (): void => {
    startInstall.reset()
    configure.reset()
    setPath.reset()
    if (install.status === 'failed') setInstallId(null)
  }

  const choose = async (): Promise<void> => {
    try {
      const [path] = await invoke('app:pickPaths', {
        mode: 'directory',
        title: t('screens.vault.bizhawk.chooseTitle'),
      })
      if (!path) return
      clearErrors()
      setPath.mutate({ path })
    } catch (error) {
      toastError(error)
    }
  }

  const cancelInstall = (): void => {
    const taskId = runningId ?? installId
    if (taskId) void invoke('tasks:cancel', { taskId }).catch(toastError)
  }

  const state = query.data
  const status = state ? bizhawkStatus(state) : null
  const installError =
    install.status === 'failed' && install.error?.code !== 'TASK_CANCELLED' ? install.error : null
  const actionError = startInstall.error ?? installError ?? configure.error ?? setPath.error
  const busy = installing || startInstall.isPending || configure.isPending || setPath.isPending

  return (
    <PixelPanel
      tone="cyan"
      eyebrow={t('screens.vault.bizhawk.eyebrow')}
      title={t('screens.vault.bizhawk.title')}
      actions={
        status && (
          <StatusPill status={BIZHAWK_PILL[status]} label={t(`screens.vault.bizhawk.status.${status}`)} />
        )
      }
      glow={status === 'ready'}
      className="bizhawk-card"
    >
      <div className="bizhawk-card__hero">
        <span className="bizhawk-card__icon" aria-hidden="true">
          <IconDeviceGamepad2 />
        </span>
        <p className="bizhawk-card__lead">{t('screens.vault.bizhawk.lead')}</p>
      </div>

      {query.isPending && <Spinner label={t('screens.vault.bizhawk.loading')} />}

      {query.isError && (
        <ErrorPanel
          {...errorPanelProps(query.error, t)}
          actions={
            <NeonButton
              size="sm"
              variant="secondary"
              icon={<IconRefresh />}
              onClick={() => void query.refetch()}
            >
              {t('common.retry')}
            </NeonButton>
          }
        />
      )}

      {state && (
        <>
          {state.installed ? (
            <dl className="bizhawk-card__facts">
              <dt>{t('screens.vault.bizhawk.version')}</dt>
              <dd>{state.version ?? t('screens.vault.bizhawk.versionUnknown')}</dd>
              {state.path !== null && (
                <>
                  <dt>{t('screens.vault.bizhawk.path')}</dt>
                  <dd className="bizhawk-card__path">{state.path}</dd>
                </>
              )}
              <dt>{t('screens.vault.bizhawk.source')}</dt>
              <dd>{t(state.managed ? 'screens.vault.bizhawk.managed' : 'screens.vault.bizhawk.external')}</dd>
              <dt>{t('screens.vault.bizhawk.archipelago')}</dt>
              <dd className="bizhawk-card__ap" data-ok={state.configuredInAp || undefined}>
                {state.configuredInAp ? <IconCheck aria-hidden="true" /> : <IconX aria-hidden="true" />}
                <span>
                  {t(
                    state.configuredInAp
                      ? 'screens.vault.bizhawk.configured'
                      : 'screens.vault.bizhawk.notConfigured',
                  )}
                </span>
              </dd>
            </dl>
          ) : (
            <p className="bizhawk-card__missing">
              {t('screens.vault.bizhawk.missingBody', { version: BIZHAWK_TAG })}
            </p>
          )}

          <Prereqs
            prereqs={state.prereqs}
            rechecking={query.isFetching}
            onRecheck={() => void query.refetch()}
            onOpen={(url) => void invoke('app:openExternal', { url }).catch(toastError)}
          />
        </>
      )}

      {installing && (
        <div className="bizhawk-card__progress">
          <ProgressBar
            percent={install.progress?.percent ?? null}
            label={t('screens.vault.bizhawk.installing')}
            tone="cyan"
            segments={16}
          />
          <NeonButton size="sm" variant="ghost" icon={<IconX />} onClick={cancelInstall}>
            {t('screens.vault.bizhawk.cancel')}
          </NeonButton>
        </div>
      )}

      {actionError && <ErrorPanel {...errorPanelProps(actionError, t)} />}

      {state && (
        <div className="bizhawk-card__actions">
          {state.installed && !state.configuredInAp && (
            <>
              <NeonButton
                icon={<IconPlugConnected />}
                loading={configure.isPending}
                disabled={busy}
                onClick={() => {
                  clearErrors()
                  configure.mutate()
                }}
              >
                {t('screens.vault.bizhawk.configure')}
              </NeonButton>
              <p className="bizhawk-card__hint">{t('screens.vault.bizhawk.configureHint')}</p>
            </>
          )}
          {offersPinned(state) && !installing && (
            <NeonButton
              variant={state.installed ? 'secondary' : 'primary'}
              icon={<IconDownload />}
              loading={startInstall.isPending}
              disabled={busy}
              onClick={() => {
                clearErrors()
                startInstall.mutate()
              }}
            >
              {t(
                state.installed && state.managed
                  ? 'screens.vault.bizhawk.update'
                  : 'screens.vault.bizhawk.install',
                {
                  version: BIZHAWK_TAG,
                },
              )}
            </NeonButton>
          )}
          <NeonButton
            variant="ghost"
            icon={<IconFolderOpen />}
            loading={setPath.isPending}
            disabled={busy}
            onClick={() => void choose()}
          >
            {t('screens.vault.bizhawk.choose')}
          </NeonButton>
          {state.installed && !state.managed && (
            <NeonButton
              variant="ghost"
              icon={<IconUnlink />}
              disabled={busy}
              onClick={() => {
                clearErrors()
                setPath.mutate({ path: null })
              }}
            >
              {t('screens.vault.bizhawk.forget')}
            </NeonButton>
          )}
        </div>
      )}
    </PixelPanel>
  )
}

interface PrereqsProps {
  prereqs: BizhawkState['prereqs']
  rechecking: boolean
  onRecheck: () => void
  onOpen: (url: string) => void
}

function Prereqs({ prereqs, rechecking, onRecheck, onOpen }: PrereqsProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const titleId = useId()
  if (prereqs.length === 0) return null
  const missing = prereqs.filter((prereq) => !prereq.ok)
  // Linux gives one command for every missing package: show each distinct hint once.
  const hints = [...new Set(missing.map((prereq) => prereq.hint?.trim() ?? '').filter((hint) => hint !== ''))]

  return (
    <div className="bizhawk-card__prereqs">
      <h3 id={titleId} className="bizhawk-card__subtitle">
        {t('screens.vault.bizhawk.prereqs')}
      </h3>
      <ul className="bizhawk-prereqs" aria-labelledby={titleId}>
        {prereqs.map((prereq) => {
          const kind = prereqKind(prereq.name)
          return (
            <li key={prereq.name} className="bizhawk-prereq" data-ok={prereq.ok || undefined}>
              <span className="bizhawk-prereq__icon" aria-hidden="true">
                {prereq.ok ? <IconCheck /> : <IconX />}
              </span>
              <span className="bizhawk-prereq__name">
                <code>{prereq.name}</code>
                {kind && (
                  <span className="bizhawk-prereq__desc">
                    {t(`screens.vault.bizhawk.prereqKinds.${kind}`)}
                  </span>
                )}
              </span>
              <span className="bizhawk-prereq__state">
                {t(prereq.ok ? 'screens.vault.bizhawk.prereqOk' : 'screens.vault.bizhawk.prereqMissing')}
              </span>
            </li>
          )
        })}
      </ul>

      {hints.map((hint) =>
        isLink(hint) ? (
          <div key={hint} className="bizhawk-card__fix">
            <p className="bizhawk-card__hint">{t('screens.vault.bizhawk.linkHint')}</p>
            <NeonButton
              size="sm"
              variant="secondary"
              icon={<IconExternalLink />}
              onClick={() => onOpen(hint)}
            >
              {t('screens.vault.bizhawk.openPage')}
            </NeonButton>
          </div>
        ) : (
          <div key={hint} className="bizhawk-card__fix">
            <CopyField
              className="bizhawk-card__command"
              label={t('screens.vault.bizhawk.command')}
              value={hint}
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
            />
            <p className="bizhawk-card__hint">{t('screens.vault.bizhawk.commandHint')}</p>
          </div>
        ),
      )}

      {missing.length > 0 && (
        <NeonButton size="sm" variant="ghost" icon={<IconRefresh />} loading={rechecking} onClick={onRecheck}>
          {t('screens.vault.bizhawk.recheck')}
        </NeonButton>
      )}
    </div>
  )
}
