// Install, update or uninstall Archipelago: the installed and latest versions, the install options,
// which folder the app uses, the release notes, and the progress of the install task.
import { IconRefresh, IconTrash } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toAppErrorData } from '@shared/errors'
import type { ApInstall, ApRelease, TaskRef } from '@shared/types'
import { ConfirmDialog, NeonButton, PixelPanel, Spinner } from '../../design/components'
import { useEvent } from '../../hooks/useEvent'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useTask } from '../../hooks/useTask'
import { invoke } from '../../lib/goat'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { useConfig } from '../../stores/config'
import { useTasksStore, type TaskEntry } from '../../stores/tasks'
import { ApLocation } from './ApLocation'
import { apState, canUninstall, DETECT_KEY, offerFor, RELEASE_KEY } from './install-model'
import { InstallError } from './InstallError'
import { flowStatus, InstallFlow, type Flow, type InstallInput } from './InstallFlow'
import { InstallHero, type LatestStatus } from './InstallHero'
import { InstallOptions } from './InstallOptions'
import { UninstallDialog } from './UninstallDialog'
import './InstallScreen.css'

function isRunningApTask(task: TaskEntry): boolean {
  return task.status === 'running' && (task.kind === 'ap-install' || task.kind === 'ap-uninstall')
}

export function InstallScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const config = useConfig()
  const os = useIpcQuery('app:getInfo', undefined, { staleTime: Infinity }).data?.os ?? null
  const detect = useIpcQuery('ap:detect', undefined)
  const release = useIpcQuery('ap:latestRelease', {})
  const refresh = useIpcMutation('ap:latestRelease', {
    onSuccess: (latest) => queryClient.setQueryData(RELEASE_KEY, latest),
  })
  useEvent('ap:installed', (install) => queryClient.setQueryData(DETECT_KEY, install))

  // Null follows the app setting.
  const [desktopIcons, setDesktopIcons] = useState<boolean | null>(null)
  const [customDir, setCustomDir] = useState<string | null>(null)
  const [uninstallOpen, setUninstallOpen] = useState(false)
  /** The install waiting for the user to accept a file without a published checksum. */
  const [unverified, setUnverified] = useState<InstallInput | null>(null)
  const [flow, setFlow] = useState<Flow | null>(null)
  const task = useTask(flow?.taskId ?? null)
  const status = flow ? flowStatus(flow, task) : null

  // An install or uninstall that was already running when the screen opened is followed too.
  const runningId = useTasksStore((state) => Object.values(state.tasks).find(isRunningApTask)?.taskId ?? null)
  const runningKind = useTasksStore((state) => (runningId ? state.tasks[runningId]?.kind : null) ?? null)
  if (!flow && runningId) {
    const base = { token: {}, taskId: runningId, startError: null }
    setFlow(
      runningKind === 'ap-uninstall'
        ? { ...base, kind: 'uninstall', purge: null }
        : { ...base, kind: 'install', input: null, target: null, update: false },
    )
  }

  // Once the task ends, the detected install changed (or may have, after a failure).
  const ended = status === 'done' || status === 'failed' ? flow?.taskId : null
  const result = task.result
  useEffect(() => {
    if (!ended) return
    if (status === 'done') queryClient.setQueryData(DETECT_KEY, (result as ApInstall | null) ?? null)
    void queryClient.invalidateQueries({ queryKey: DETECT_KEY })
  }, [ended, status, result, queryClient])

  const installed = detect.data ?? null
  const latest: ApRelease | null = release.data ?? null
  const releaseError = refresh.error ?? release.error
  const latestStatus: LatestStatus = latest ? 'ok' : releaseError ? 'error' : 'loading'
  const state = apState(installed, latest?.version ?? null)
  const offer = offerFor(state, installed)

  const begin = (next: Flow, call: () => Promise<TaskRef>): void => {
    setFlow(next)
    const mine = (current: Flow | null): current is Flow => current?.token === next.token
    call().then(
      ({ taskId }) => setFlow((current) => (mine(current) ? { ...current, taskId } : current)),
      (error: unknown) =>
        setFlow((current) => (mine(current) ? { ...current, startError: toAppErrorData(error) } : current)),
    )
  }

  const install = (input: InstallInput): void =>
    begin(
      {
        token: {},
        taskId: null,
        startError: null,
        kind: 'install',
        input,
        target: latest?.version ?? null,
        update: offer === 'update',
      },
      () => invoke('ap:install', input),
    )

  const uninstall = (purge: boolean): void =>
    begin({ token: {}, taskId: null, startError: null, kind: 'uninstall', purge }, () =>
      invoke('ap:uninstall', { purgeUserData: purge }),
    )

  const installInput = (): InstallInput => ({
    desktopIcons: desktopIcons ?? config.desktopIcons,
    ...(customDir ? { customDir } : {}),
  })
  // The file this system installs from: without a SHA-256 from GitHub, only its size can be checked.
  const asset = os === 'win32' ? latest?.windows : os === 'linux' ? latest?.linuxTarGz : null
  const offerInstall = (): void => {
    const input = installInput()
    if (asset?.sha256 === null) setUnverified(input)
    else install(input)
  }

  const retry = (): void => {
    if (!flow) return
    if (flow.kind === 'install') install(flow.input ?? installInput())
    else if (flow.purge !== null) uninstall(flow.purge)
    else {
      setFlow(null)
      setUninstallOpen(true)
    }
  }

  const checkUpdates = (): void => refresh.mutate({ force: true })

  return (
    <>
      <ScreenHeader
        eyebrow={t('screens.install.eyebrow')}
        title={t('screens.install.title')}
        subtitle={t('screens.install.subtitle')}
        actions={
          flow || !detect.isSuccess ? undefined : (
            <NeonButton
              variant="secondary"
              icon={<IconRefresh />}
              loading={refresh.isPending}
              loadingLabel={t('screens.install.checking')}
              onClick={checkUpdates}
            >
              {t('screens.install.checkUpdates')}
            </NeonButton>
          )
        }
      />

      {flow ? (
        <InstallFlow flow={flow} task={task} os={os} onRetry={retry} onDismiss={() => setFlow(null)} />
      ) : detect.isPending ? (
        <div className="install-detecting pixel-border tone-violet">
          <Spinner label={t('screens.install.detecting')} />
        </div>
      ) : detect.isError ? (
        <InstallError error={detect.error} onRetry={() => void detect.refetch()} headingLevel={2} />
      ) : (
        <div className="install-screen">
          <InstallHero
            state={state}
            installed={installed}
            latest={latest}
            latestStatus={latestStatus}
            os={os}
            offer={offer}
            onOffer={offerInstall}
          />
          {releaseError && <InstallError error={releaseError} onRetry={checkUpdates} />}
          <div className="install-grid">
            <div className="install-grid__column">
              {offer && (
                <InstallOptions
                  os={os}
                  desktopIcons={desktopIcons ?? config.desktopIcons}
                  onDesktopIcons={setDesktopIcons}
                  customDir={customDir}
                  onCustomDir={setCustomDir}
                />
              )}
              {latest && latest.notes.trim() !== '' && <ReleaseNotes release={latest} />}
            </div>
            <div className="install-grid__column">
              <ApLocation install={installed} />
              {installed && canUninstall(installed) && (
                <PixelPanel
                  tone="pink"
                  title={t('screens.install.uninstall.title')}
                  className="install-danger"
                >
                  <p className="install-danger__body">{t('screens.install.uninstall.body')}</p>
                  <NeonButton
                    variant="danger"
                    size="sm"
                    icon={<IconTrash />}
                    onClick={() => setUninstallOpen(true)}
                  >
                    {t('screens.install.uninstall.button')}
                  </NeonButton>
                </PixelPanel>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={unverified !== null}
        tone="yellow"
        eyebrow={t('screens.install.unverified.eyebrow')}
        title={t('screens.install.unverified.title')}
        confirmLabel={t('screens.install.unverified.confirm')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.closeDialog')}
        onCancel={() => setUnverified(null)}
        onConfirm={() => {
          const input = unverified
          setUnverified(null)
          if (input) install({ ...input, allowUnverified: true })
        }}
      >
        <p>{t('screens.install.unverified.body', { file: asset?.name ?? '' })}</p>
        <p className="confirm-dialog__note">{t('screens.install.unverified.note')}</p>
      </ConfirmDialog>
      <UninstallDialog
        open={uninstallOpen}
        os={os}
        onCancel={() => setUninstallOpen(false)}
        onConfirm={(purge) => {
          setUninstallOpen(false)
          uninstall(purge)
        }}
      />
    </>
  )
}

/** The notes of a release are plain text: shown as they are, never as HTML. */
function ReleaseNotes({ release }: { release: ApRelease }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <PixelPanel
      title={t('screens.install.notes.title', { version: release.version })}
      className="install-notes"
    >
      <pre
        className="install-notes__text"
        role="region"
        tabIndex={0}
        aria-label={t('screens.install.notes.label', { version: release.version })}
      >
        {release.notes.trim()}
      </pre>
    </PixelPanel>
  )
}
