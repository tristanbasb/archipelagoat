// The trust screen of an APWorld install: where it comes from, who made it, its checksum, what it
// replaces, and an explicit "I understand" before anything is installed (an APWorld is code).
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconFileCode,
  IconShieldExclamation,
} from '@tabler/icons-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppErrorData } from '@shared/errors'
import type { TaskProgress, TrustTier, WorldInfo, WorldInstallPlan, WorldSource } from '@shared/types'
import {
  Badge,
  ErrorPanel,
  Modal,
  NeonButton,
  ProgressBar,
  TrustBadge,
  useToast,
} from '../../design/components'
import type { Tone } from '../../design/classes'
import { sfx } from '../../design/sfx'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import { stageLabel } from '../../lib/task-stages'
import './TrustDialog.css'

export interface TrustDialogProps {
  open: boolean
  /** Null while the world is being inspected. */
  plan: WorldInstallPlan | null
  progress?: TaskProgress | null
  /** The inspection failed (no plan), or the install did (with a plan). */
  error?: AppErrorData | null
  installing?: boolean
  /** Installs waiting after this one. */
  queued?: number
  onConfirm: () => void
  onCancel: () => void
}

const TIER_TONE: Record<TrustTier, Tone> = {
  core: 'green',
  'indexed-verified': 'cyan',
  'wiki-release': 'yellow',
  unknown: 'pink',
}

const COPIED_FOR_MS = 1600

function shortHash(sha256: string): string {
  return sha256.length > 24 ? `${sha256.slice(0, 12)}…${sha256.slice(-8)}` : sha256
}

function sourceValue(source: WorldSource): string {
  if (source.kind === 'file') return source.path
  if (source.kind === 'url') return source.url
  return source.id
}

type Conflict = WorldInstallPlan['conflicts'][number]

/**
 * How a conflict names the installed world: its file, then its game and version when known. A
 * world id is a hash of its path, never shown: null when the world is not in the list.
 */
function conflictName(conflict: Conflict, worlds: readonly WorldInfo[]): string | null {
  const world = worlds.find((item) => item.id === conflict.worldId)
  if (!world) return null
  const details = [world.game, conflict.version].filter(Boolean).join(' ')
  return details ? `${world.fileName} (${details})` : world.fileName
}

export function TrustDialog({
  open,
  plan,
  progress = null,
  error = null,
  installing = false,
  queued = 0,
  onConfirm,
  onCancel,
}: TrustDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  // The installed worlds name the conflicts; loaded while the new one is inspected.
  const worlds = useIpcQuery('worlds:list', undefined, { enabled: open })
  // The acknowledgement belongs to one plan: a new plan starts unchecked.
  const [ackedPlan, setAckedPlan] = useState<string | null>(null)
  const acked = plan !== null && ackedPlan === plan.planId
  const failedToPrepare = error !== null && plan === null

  const game = plan ? (plan.manifest?.game ?? plan.module) : null
  const tone: Tone = failedToPrepare ? 'pink' : plan ? TIER_TONE[plan.trust] : 'violet'
  const footer = failedToPrepare ? (
    <NeonButton variant="secondary" onClick={onCancel}>
      {t('common.close')}
    </NeonButton>
  ) : (
    <>
      {queued > 0 && (
        <span className="trust-dialog__queued">{t('worldInstall.queued', { count: queued })}</span>
      )}
      <NeonButton variant="ghost" onClick={onCancel} disabled={installing}>
        {t('common.cancel')}
      </NeonButton>
      {plan && (
        <NeonButton
          variant="primary"
          disabled={!acked}
          loading={installing}
          loadingLabel={t('worldInstall.installing')}
          onClick={onConfirm}
        >
          {t('worldInstall.install')}
        </NeonButton>
      )}
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onCancel}
      dismissible={!installing}
      closeLabel={t('common.closeDialog')}
      tone={tone}
      size="md"
      eyebrow={t('worldInstall.eyebrow')}
      title={game ? t('worldInstall.title', { game }) : t('worldInstall.titlePending')}
      footer={footer}
    >
      {failedToPrepare ? (
        <PrepareError error={error} />
      ) : plan ? (
        <PlanReview
          plan={plan}
          worlds={worlds.data ?? []}
          error={error}
          acked={acked}
          onAck={(checked) => setAckedPlan(checked ? plan.planId : null)}
        />
      ) : (
        <div className="trust-dialog__preparing">
          <ProgressBar
            percent={progress?.percent ?? null}
            label={stageLabel(progress, t) ?? t('worldInstall.preparing')}
            segments={16}
            tone="violet"
          />
        </div>
      )}
    </Modal>
  )
}

function PrepareError({ error }: { error: AppErrorData }): React.JSX.Element {
  const { t } = useTranslation()
  const { title, body, detail } = describeError(error, t)
  return <ErrorPanel title={title} body={body} detail={detail} detailLabel={t('common.technicalDetails')} />
}

interface PlanReviewProps {
  plan: WorldInstallPlan
  /** The installed worlds, to name the conflicts. */
  worlds: readonly WorldInfo[]
  error: AppErrorData | null
  acked: boolean
  onAck: (checked: boolean) => void
}

function PlanReview({ plan, worlds, error, acked, onAck }: PlanReviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const ackId = useId()
  const manifest = plan.manifest
  const authors = manifest?.authors.length ? manifest.authors.join(', ') : t('worldInstall.authorsUnknown')
  const apRange = [
    manifest?.minimumApVersion && t('worldInstall.apMin', { version: manifest.minimumApVersion }),
    manifest?.maximumApVersion && t('worldInstall.apMax', { version: manifest.maximumApVersion }),
  ].filter(Boolean)
  const described = error ? describeError(error, t) : null

  return (
    <div className="trust-dialog">
      <div className="trust-dialog__badges">
        <TrustBadge
          tier={plan.trust}
          label={t(`trust.${plan.trust}.label`)}
          description={t(`trust.${plan.trust}.description`)}
        />
        <Badge tone="neutral" icon={<IconFileCode />} outline title={t('worldInstall.version')}>
          {manifest?.worldVersion ?? t('worldInstall.versionUnknown')}
        </Badge>
      </div>

      <dl className="trust-dialog__facts">
        <dt>{t('worldInstall.source')}</dt>
        <dd>
          <span className="trust-dialog__kind">{t(`worldInstall.sourceKinds.${plan.source.kind}`)}</span>
          <span className="trust-dialog__path" title={sourceValue(plan.source)}>
            {sourceValue(plan.source)}
          </span>
        </dd>
        <dt>{t('worldInstall.authors')}</dt>
        <dd>{authors}</dd>
        <dt>{t('worldInstall.file')}</dt>
        <dd className="trust-dialog__mono">{plan.targetFileName}</dd>
        <dt>{t('worldInstall.archipelago')}</dt>
        <dd>{apRange.length > 0 ? apRange.join(' · ') : t('worldInstall.apAny')}</dd>
        <dt>{t('worldInstall.sha256')}</dt>
        <dd>
          <HashChip sha256={plan.sha256} />
        </dd>
        {plan.homepage && (
          <>
            <dt>{t('worldInstall.homepage')}</dt>
            <dd>
              <ExternalLink url={plan.homepage} />
            </dd>
          </>
        )}
      </dl>

      {plan.conflicts.length > 0 && (
        <section className="trust-dialog__notes tone-yellow" aria-label={t('worldInstall.conflicts')}>
          <h3>{t('worldInstall.conflicts')}</h3>
          <ul>
            {plan.conflicts.map((conflict) => {
              const oldName = conflictName(conflict, worlds)
              const newName = plan.targetFileName
              const replaces = conflict.winner === 'new'
              return (
                <li key={conflict.worldId}>
                  <IconAlertTriangle aria-hidden="true" />
                  <span>
                    {oldName === null
                      ? t(replaces ? 'worldInstall.replacesUnknown' : 'worldInstall.keepsUnknown', {
                          newName,
                        })
                      : t(replaces ? 'worldInstall.replaces' : 'worldInstall.keeps', { newName, oldName })}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {plan.warnings.length > 0 && (
        <section className="trust-dialog__notes tone-yellow" aria-label={t('worldInstall.warnings')}>
          <h3>{t('worldInstall.warnings')}</h3>
          <ul>
            {plan.warnings.map((code) => (
              <li key={code}>
                <IconAlertTriangle aria-hidden="true" />
                <span>{t(`issues.${code}`)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="trust-dialog__code pixel-border tone-pink">
        <IconShieldExclamation className="trust-dialog__code-icon" aria-hidden="true" />
        <div>
          <p className="trust-dialog__code-title">{t('worldInstall.codeTitle')}</p>
          <p className="trust-dialog__code-body">{t('worldInstall.codeBody')}</p>
          <label className="trust-dialog__ack" htmlFor={ackId}>
            <input
              id={ackId}
              type="checkbox"
              checked={acked}
              onChange={(event) => {
                sfx.play('blip')
                onAck(event.target.checked)
              }}
            />
            <span className="trust-dialog__box" aria-hidden="true">
              <IconCheck />
            </span>
            <span>{t('worldInstall.ack')}</span>
          </label>
        </div>
      </div>

      {described && (
        <ErrorPanel
          title={described.title}
          body={described.body}
          detail={described.detail}
          detailLabel={t('common.technicalDetails')}
        />
      )}
    </div>
  )
}

/** The checksum, shortened, with a button that copies all of it. */
function HashChip({ sha256 }: { sha256: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_FOR_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    navigator.clipboard.writeText(sha256).then(
      () => {
        sfx.play('coin')
        setCopied(true)
      },
      () => sfx.play('error'),
    )
  }

  return (
    <span className="trust-dialog__hash">
      <code title={sha256}>{shortHash(sha256)}</code>
      <button
        type="button"
        className="trust-dialog__icon-btn"
        aria-label={copied ? t('worldInstall.hashCopied') : t('worldInstall.copyHash')}
        data-copied={copied || undefined}
        onClick={copy}
      >
        {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
      </button>
    </span>
  )
}

function ExternalLink({ url }: { url: string }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const open = useIpcMutation('app:openExternal', {
    onError: (error) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
  })
  return (
    <button type="button" className="trust-dialog__link" onClick={() => open.mutate({ url })}>
      <span>{url.replace(/^https:\/\//, '')}</span>
      <IconExternalLink aria-hidden="true" />
    </button>
  )
}
