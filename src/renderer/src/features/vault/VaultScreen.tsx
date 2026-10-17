// The Émulateurs et ROMs screen (spec §4.2.8): the ROM vault (scan, recognised and unknown ROMs,
// "apply to Archipelago"), BizHawk, and the games whose ROM Archipelago recognises. The app never
// provides, links to or shares a ROM: the vault only keeps references to the user's own files.
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconDeviceGamepad2,
  IconDisc,
  IconFilePlus,
  IconFileUnknown,
  IconFolderSearch,
  IconListCheck,
  IconPlugConnected,
  IconRefresh,
  IconShieldLock,
  IconX,
} from '@tabler/icons-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GoatError } from '@shared/errors'
import type { RomRecord, VaultApplyResult } from '@shared/types'
import {
  EmptyState,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  ProgressBar,
  Spinner,
  StatTile,
  useToast,
} from '../../design/components'
import { useEvent } from '../../hooks/useEvent'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useTask } from '../../hooks/useTask'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { describeError } from '../../lib/errors'
import { invoke } from '../../lib/goat'
import { BizhawkCard, bizhawkStatus } from './BizhawkCard'
import { errorPanelProps } from './error-props'
import { RomList, splitPath } from './RomList'
import { foundKeys, SupportedGames } from './SupportedGames'
import { useRunningTask } from './useRunningTask'
import './VaultScreen.css'

/** The extensions the vault scans (spec §3.12), for the file dialog. */
const ROM_EXTENSIONS = [
  'sfc',
  'smc',
  'gb',
  'gbc',
  'gba',
  'nes',
  'z64',
  'n64',
  'v64',
  'bin',
  'sms',
  'gen',
  'md',
  'iso',
  'srl',
]

export function VaultScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const records = useIpcQuery('vault:list', undefined)
  const table = useIpcQuery('vault:table', undefined, { staleTime: Infinity })
  const bizhawk = useIpcQuery('bizhawk:state', undefined)

  const list = records.data ?? []
  const recognised = list.filter((record) => record.game !== null).length
  const found = foundKeys(list)
  const covered = table.data?.filter((entry) => found.has(entry.settingsKey)).length
  const status = bizhawk.data ? bizhawkStatus(bizhawk.data) : null
  const none = t('screens.vault.stats.none')

  return (
    <div className="vault-screen">
      <ScreenHeader
        eyebrow={t('screens.vault.eyebrow')}
        title={t('nav.vault')}
        subtitle={t('screens.vault.subtitle')}
      />

      <div className="vault-legal tone-yellow">
        <span className="vault-legal__icon" aria-hidden="true">
          <IconShieldLock />
        </span>
        <p className="vault-legal__text">
          <strong className="vault-legal__title">{t('screens.vault.legal.title')}</strong>{' '}
          <span className="vault-legal__body">{t('screens.vault.legal.body')}</span>
        </p>
      </div>

      <div className="vault-screen__stats">
        <StatTile
          tone="green"
          icon={<IconDisc />}
          label={t('screens.vault.stats.recognised')}
          value={records.data ? recognised : none}
        />
        <StatTile
          tone="yellow"
          icon={<IconFileUnknown />}
          label={t('screens.vault.stats.unknown')}
          value={records.data ? list.length - recognised : none}
        />
        <StatTile
          tone="violet"
          icon={<IconListCheck />}
          label={t('screens.vault.stats.covered')}
          value={
            records.data && table.data
              ? t('screens.vault.stats.coveredValue', { found: covered ?? 0, total: table.data.length })
              : none
          }
        />
        <StatTile
          tone="cyan"
          icon={<IconDeviceGamepad2 />}
          label={t('screens.vault.stats.bizhawk')}
          value={status ? t(`screens.vault.bizhawk.status.${status}`) : none}
        />
      </div>

      <div className="vault-screen__grid">
        <RomVault records={records} recognised={recognised} />
        <BizhawkCard />
      </div>

      <SupportedGames records={list} />
    </div>
  )
}

interface RomVaultProps {
  records: UseQueryResult<RomRecord[], GoatError>
  recognised: number
}

/** The vault panel: scan folders or files, apply to Archipelago, and the ROMs found. */
function RomVault({ records, recognised }: RomVaultProps): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [scanId, setScanId] = useState<string | null>(null)
  const runningScanId = useRunningTask('rom-scan')
  const scan = useTask(runningScanId ?? scanId)
  const scanning = scan.status === 'running'

  const toastError = (error: unknown): void => {
    const { title, body } = describeError(error, t)
    toast.push({ tone: 'error', title, body })
  }

  // A scan (this one or one started elsewhere) adds to the vault, even when it fails halfway.
  const refreshVault = ({ kind }: { kind: string }): void => {
    if (kind === 'rom-scan') void queryClient.invalidateQueries({ queryKey: ['vault:list'] })
  }
  useEvent('task:done', refreshVault)
  useEvent('task:failed', refreshVault)

  const startScan = useIpcMutation('vault:scan', { onSuccess: ({ taskId }) => setScanId(taskId) })
  const apply = useIpcMutation('vault:apply', {
    onSuccess: ({ applied, skipped }) => {
      toast.push(
        skipped.length > 0
          ? {
              tone: 'warn',
              title: t('screens.vault.apply.partial'),
              body: t('screens.vault.apply.partialBody', {
                applied: applied.length,
                skipped: skipped.length,
              }),
            }
          : {
              tone: 'ok',
              title: t('screens.vault.apply.done'),
              body: t('screens.vault.apply.doneBody', { count: applied.length }),
            },
      )
    },
  })
  const remove = useIpcMutation('vault:remove', {
    invalidates: ['vault:list'],
    onSuccess: (_, { path }) =>
      toast.push({ tone: 'info', title: t('screens.vault.vault.removed', { name: splitPath(path).name }) }),
    onError: toastError,
  })

  const pickAndScan = async (mode: 'directory' | 'files'): Promise<void> => {
    try {
      const paths = await invoke(
        'app:pickPaths',
        mode === 'directory'
          ? { mode, title: t('screens.vault.vault.pickFolderTitle') }
          : {
              mode,
              title: t('screens.vault.vault.pickFilesTitle'),
              filters: [
                { name: t('screens.vault.vault.romFilter'), extensions: ROM_EXTENSIONS },
                { name: t('screens.vault.vault.allFiles'), extensions: ['*'] },
              ],
            },
      )
      if (paths.length > 0) startScan.mutate({ paths })
    } catch (error) {
      toastError(error)
    }
  }

  const cancelScan = (): void => {
    const taskId = runningScanId ?? scanId
    if (taskId) void invoke('tasks:cancel', { taskId }).catch(toastError)
  }

  const scanBusy = scanning || startScan.isPending
  const scanError =
    startScan.error ?? (scan.status === 'failed' && scan.error?.code !== 'TASK_CANCELLED' ? scan.error : null)
  const scanResult =
    scan.status === 'done' && Array.isArray(scan.result) ? (scan.result as RomRecord[]) : null

  return (
    <PixelPanel
      tone="green"
      eyebrow={t('screens.vault.vault.eyebrow')}
      title={t('screens.vault.vault.title')}
      actions={
        <>
          <NeonButton
            size="sm"
            variant="ghost"
            icon={<IconFilePlus />}
            disabled={scanBusy}
            onClick={() => void pickAndScan('files')}
          >
            {t('screens.vault.vault.addFiles')}
          </NeonButton>
          <NeonButton
            size="sm"
            variant="secondary"
            icon={<IconFolderSearch />}
            loading={scanBusy}
            onClick={() => void pickAndScan('directory')}
          >
            {t('screens.vault.vault.scanFolder')}
          </NeonButton>
        </>
      }
      className="rom-vault"
    >
      {scanning && (
        <div className="rom-vault__scan">
          <ProgressBar
            percent={scan.progress?.percent ?? null}
            label={t('screens.vault.scan.running')}
            tone="green"
            segments={24}
          />
          <NeonButton size="sm" variant="ghost" icon={<IconX />} onClick={cancelScan}>
            {t('screens.vault.scan.cancel')}
          </NeonButton>
        </div>
      )}

      {scanResult && (
        <div className="rom-vault__summary" role="status">
          <IconCircleCheck className="rom-vault__summary-icon" aria-hidden="true" />
          <p>
            <strong>{t('screens.vault.scan.done')}</strong>{' '}
            <span>
              {t('screens.vault.scan.doneBody', {
                recognised: scanResult.filter((record) => record.game !== null).length,
                unknown: scanResult.filter((record) => record.game === null).length,
              })}
            </span>
          </p>
          <button
            type="button"
            className="rom-vault__dismiss"
            aria-label={t('screens.vault.scan.dismiss')}
            onClick={() => setScanId(null)}
          >
            <IconX aria-hidden="true" />
          </button>
        </div>
      )}

      {scanError && <ErrorPanel {...errorPanelProps(scanError, t)} />}

      {records.isPending && (
        <Spinner label={t('screens.vault.vault.loading')} className="rom-vault__loading" />
      )}

      {records.isError && (
        <ErrorPanel
          {...errorPanelProps(records.error, t)}
          actions={
            <NeonButton
              size="sm"
              variant="secondary"
              icon={<IconRefresh />}
              onClick={() => void records.refetch()}
            >
              {t('common.retry')}
            </NeonButton>
          }
        />
      )}

      {records.data && recognised > 0 && (
        <div className="rom-vault__apply tone-violet">
          <div className="rom-vault__apply-text">
            <p className="rom-vault__apply-count">{t('screens.vault.apply.ready', { count: recognised })}</p>
            <p className="rom-vault__apply-hint">{t('screens.vault.apply.hint')}</p>
          </div>
          <NeonButton
            icon={<IconPlugConnected />}
            loading={apply.isPending}
            loadingLabel={t('screens.vault.apply.applying')}
            disabled={scanBusy}
            onClick={() => apply.mutate()}
          >
            {t('screens.vault.apply.action')}
          </NeonButton>
        </div>
      )}

      {apply.error && <ErrorPanel {...errorPanelProps(apply.error, t)} />}
      {apply.data && <ApplyResult result={apply.data} onDismiss={() => apply.reset()} />}

      {records.data &&
        (records.data.length === 0 ? (
          !scanning && (
            <EmptyState
              tone="green"
              icon={<IconDisc />}
              title={t('screens.vault.vault.emptyTitle')}
              body={t('screens.vault.vault.emptyBody')}
              action={
                <NeonButton
                  icon={<IconFolderSearch />}
                  disabled={scanBusy}
                  onClick={() => void pickAndScan('directory')}
                >
                  {t('screens.vault.vault.emptyAction')}
                </NeonButton>
              }
            />
          )
        ) : (
          <RomList
            records={records.data}
            onRemove={(record) => remove.mutate({ path: record.path })}
            removing={remove.isPending ? (remove.variables?.path ?? null) : null}
          />
        ))}
    </PixelPanel>
  )
}

interface ApplyResultProps {
  result: VaultApplyResult
  onDismiss: () => void
}

/** What "apply to Archipelago" wrote, and what it skipped and why. */
function ApplyResult({ result, onDismiss }: ApplyResultProps): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const appliedId = useId()
  const skippedId = useId()
  return (
    <section className="apply-result" aria-labelledby={titleId}>
      <header className="apply-result__head">
        <h3 id={titleId} className="apply-result__title">
          {t('screens.vault.apply.resultTitle')}
        </h3>
        <button
          type="button"
          className="rom-vault__dismiss"
          aria-label={t('screens.vault.apply.dismiss')}
          onClick={onDismiss}
        >
          <IconX aria-hidden="true" />
        </button>
      </header>
      <div className="apply-result__columns">
        {result.applied.length > 0 && (
          <div className="apply-result__group tone-green">
            <h4 id={appliedId} className="apply-result__group-title">
              <IconCircleCheck aria-hidden="true" />
              {t('screens.vault.apply.applied', { count: result.applied.length })}
            </h4>
            <ul className="apply-result__list" aria-labelledby={appliedId}>
              {result.applied.map((item) => (
                <li key={item.key} className="apply-result__item">
                  <span className="apply-result__game">{item.game}</span>
                  <code className="apply-result__key">{item.key}</code>
                  <span className="apply-result__path" title={item.path}>
                    {item.path}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {result.skipped.length > 0 && (
          <div className="apply-result__group tone-yellow">
            <h4 id={skippedId} className="apply-result__group-title">
              <IconAlertTriangle aria-hidden="true" />
              {t('screens.vault.apply.skipped', { count: result.skipped.length })}
            </h4>
            <ul className="apply-result__list" aria-labelledby={skippedId}>
              {result.skipped.map((item, index) => (
                <li key={`${item.game}-${index}`} className="apply-result__item">
                  <span className="apply-result__game">{item.game}</span>
                  <span className="apply-result__reason">{t(`errors.${item.reason}`)}</span>
                  <span className="apply-result__help">{t(`errors.help.${item.reason}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
