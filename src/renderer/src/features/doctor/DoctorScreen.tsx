// The health check (spec §3.15): every check with its state and its fix, the health summary, and
// the support bundle (a zip of the logs, made locally, then its folder opens).
import { IconCircleCheck, IconFileZip, IconFolderOpen, IconLock, IconRefresh } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { DOCTOR_CHECK_IDS } from '@shared/codes'
import type { DoctorCheck } from '@shared/types'
import {
  CopyField,
  EmptyState,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  ProgressBar,
  Spinner,
  StatusPill,
  useToast,
  type Tone,
} from '../../design/components'
import { useIpcMutation } from '../../hooks/useIpc'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { describeError } from '../../lib/errors'
import {
  CHECK_ICONS,
  CheckFixButton,
  SEVERITY_STATUS,
  SEVERITY_TONE,
  checkText,
  isPassing,
  sortChecks,
  useDoctorFix,
  useDoctorRun,
  type DoctorFix,
} from './checks'
import './DoctorScreen.css'

const K = 'screens.doctor'

export function DoctorScreen(): React.JSX.Element {
  const { t } = useTranslation()
  // Opening the screen always runs the checks again; what the home had stays shown meanwhile.
  const doctor = useDoctorRun({ refetchOnMount: 'always' })
  const fix = useDoctorFix()
  const checks = doctor.data

  return (
    <div className="doctor">
      <ScreenHeader
        eyebrow={t(`${K}.eyebrow`)}
        title={t('nav.doctor')}
        subtitle={t(`${K}.subtitle`)}
        actions={
          <NeonButton
            variant="secondary"
            icon={<IconRefresh />}
            loading={doctor.isFetching}
            loadingLabel={checks ? t(`${K}.running`) : undefined}
            onClick={() => void doctor.refetch()}
          >
            {t(`${K}.rerun`)}
          </NeonButton>
        }
      />
      <div className="doctor__layout">
        <div className="doctor__main">
          {doctor.isError && !doctor.isFetching && (
            <RunError error={doctor.error} onRetry={() => void doctor.refetch()} />
          )}
          {checks === undefined ? (
            doctor.isFetching && <Scanning />
          ) : checks.length === 0 ? (
            <PixelPanel as="div" padding="lg">
              <EmptyState title={t(`${K}.empty.title`)} body={t(`${K}.empty.body`)} headingLevel={2} />
            </PixelPanel>
          ) : (
            <CheckLists checks={checks} fix={fix} />
          )}
        </div>
        <aside className="doctor__side">
          {checks !== undefined && checks.length > 0 && (
            <HealthSummary checks={checks} updatedAt={doctor.dataUpdatedAt} />
          )}
          <SupportBundle />
        </aside>
      </div>
    </div>
  )
}

// ---- States of the run ---------------------------------------------------------------------------

/** While the checks run: each one listed, waiting for its verdict. */
function Scanning(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <PixelPanel tone="violet" eyebrow={t(`${K}.scanning`)} title={<Spinner label={t(`${K}.running`)} />}>
      <ul className="doctor-grid" aria-hidden="true">
        {DOCTOR_CHECK_IDS.map((id, index) => {
          const Icon = CHECK_ICONS[id]
          return (
            <li
              key={id}
              className="doctor-pass doctor-pass--scanning"
              style={{ animationDelay: `${index * 90}ms` }}
            >
              <Icon className="doctor-pass__icon" />
              <span className="doctor-pass__title">{t(`doctor.${id}.title`)}</span>
              <StatusPill status="busy" label={t(`${K}.checking`)} />
            </li>
          )
        })}
      </ul>
    </PixelPanel>
  )
}

function RunError({ error, onRetry }: { error: unknown; onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const described = describeError(error, t)
  const label = described.action?.labelKey
  // This screen is where the help of most errors leads: no button back to itself.
  const to = described.action?.to !== '/doctor' ? described.action?.to : undefined
  return (
    <ErrorPanel
      headingLevel={2}
      title={described.title}
      body={described.body}
      detail={described.detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        <>
          <NeonButton variant="secondary" size="sm" icon={<IconRefresh />} onClick={onRetry}>
            {t('common.retry')}
          </NeonButton>
          {to && label && (
            <NeonButton variant="ghost" size="sm" onClick={() => void navigate(to)}>
              {t(label)}
            </NeonButton>
          )}
        </>
      }
    />
  )
}

// ---- The checks ------------------------------------------------------------------------------------

function CheckLists({ checks, fix }: { checks: DoctorCheck[]; fix: DoctorFix }): React.JSX.Element {
  const { t } = useTranslation()
  const sorted = sortChecks(checks)
  const problems = sorted.filter((check) => check.severity !== 'ok')
  const passing = sorted.filter((check) => check.severity === 'ok')
  return (
    <>
      {problems.length > 0 && (
        // A neutral frame: the checks inside carry the colors.
        <PixelPanel eyebrow={t(`${K}.problems.eyebrow`)} title={t(`${K}.problems.title`)}>
          <ul className="doctor-checks">
            {problems.map((check) => (
              <ProblemItem key={check.id} check={check} fix={fix} />
            ))}
          </ul>
        </PixelPanel>
      )}
      {passing.length > 0 && (
        <PixelPanel tone="green" eyebrow={t(`${K}.passing.eyebrow`)} title={t(`${K}.passing.title`)}>
          <ul className="doctor-grid">
            {passing.map((check) => {
              const { title, text } = checkText(check, t)
              return (
                <li key={check.id} className="doctor-pass">
                  <IconCircleCheck className="doctor-pass__icon" aria-hidden="true" />
                  <span className="doctor-pass__text">
                    <span className="doctor-pass__title">{title}</span>{' '}
                    <span className="doctor-pass__body">{text}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </PixelPanel>
      )}
    </>
  )
}

function ProblemItem({ check, fix }: { check: DoctorCheck; fix: DoctorFix }): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = CHECK_ICONS[check.id]
  const { title, text } = checkText(check, t)
  const params = Object.entries(check.params)
  return (
    <li className={`doctor-check pixel-border tone-${SEVERITY_TONE[check.severity]}`}>
      <span className="doctor-check__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="doctor-check__main">
        <div className="doctor-check__head">
          <h3 className="doctor-check__title">{title}</h3>
          <StatusPill
            status={SEVERITY_STATUS[check.severity]}
            label={t(`doctor.severity.${check.severity}`)}
          />
        </div>
        <p className="doctor-check__text">{text}</p>
        {params.length > 0 && (
          <details className="doctor-check__details">
            <summary>{t('common.technicalDetails')}</summary>
            <dl>
              {params.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
      <div className="doctor-check__fix">
        <CheckFixButton check={check} fix={fix} />
      </div>
    </li>
  )
}

// ---- Summary ---------------------------------------------------------------------------------------

function HealthSummary({
  checks,
  updatedAt,
}: {
  checks: DoctorCheck[]
  updatedAt: number
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const count = (severity: DoctorCheck['severity']): number =>
    checks.filter((check) => check.severity === severity).length
  const errors = count('error')
  const warnings = count('warning')
  const infos = count('info')
  const passed = checks.filter(isPassing).length
  const total = checks.length
  const tone: Tone = errors > 0 ? 'pink' : warnings > 0 ? 'yellow' : 'green'
  const allClear = errors + warnings === 0
  return (
    <PixelPanel
      className="doctor-health"
      tone={tone}
      glow={allClear}
      eyebrow={t(`${K}.summary.eyebrow`)}
      title={t(`${K}.summary.title`)}
    >
      <div className="doctor-health__body">
        <p className="doctor-health__score t-display" aria-hidden="true">
          {t(`${K}.summary.score`, { passed, total })}
        </p>
        <ProgressBar
          label={t(`${K}.summary.health`)}
          percent={(passed / total) * 100}
          segments={total}
          valueText={t(`${K}.summary.score`, { passed, total })}
          tone={tone}
        />
        {allClear ? (
          <p className="doctor-health__verdict">
            {t(`${K}.summary.allClear`)}
            <span className="blink-cursor" aria-hidden="true" />
          </p>
        ) : (
          <p className="doctor-health__verdict">{t(`${K}.summary.attention`)}</p>
        )}
        {errors + warnings + infos > 0 && (
          <div className="doctor-health__counts">
            {errors > 0 && <StatusPill status="error" label={t(`${K}.summary.errors`, { count: errors })} />}
            {warnings > 0 && (
              <StatusPill status="warn" label={t(`${K}.summary.warnings`, { count: warnings })} />
            )}
            {infos > 0 && <StatusPill status="info" label={t(`${K}.summary.infos`, { count: infos })} />}
          </div>
        )}
        {updatedAt > 0 && (
          <p className="doctor-health__time">
            {t(`${K}.lastRun`, {
              time: new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(updatedAt),
            })}
          </p>
        )}
      </div>
    </PixelPanel>
  )
}

// ---- Support bundle --------------------------------------------------------------------------------

/** The folder of a file, whatever the separator; a drive root keeps its separator (`C:\`). */
function parentFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return path
  const parent = path.slice(0, cut)
  return parent === '' || parent.endsWith(':') ? path.slice(0, cut + 1) : parent
}

function SupportBundle(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const open = useIpcMutation('app:openPath', {
    onError: (error) => {
      const described = describeError(error, t)
      toast.push({ tone: 'error', title: described.title, body: described.body })
    },
  })
  const openFolder = (path: string): void => open.mutate({ path: parentFolder(path) })
  const bundle = useIpcMutation('doctor:supportBundle', { onSuccess: ({ path }) => openFolder(path) })
  const described = bundle.isError ? describeError(bundle.error, t) : null
  const created = bundle.data?.path
  const resultRef = useRef<HTMLDivElement>(null)

  // The result may sit below the fold: bring it into view (jsdom has no scrollIntoView).
  useEffect(() => {
    if (created) resultRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [created])

  return (
    <PixelPanel tone="cyan" eyebrow={t(`${K}.bundle.eyebrow`)} title={t(`${K}.bundle.title`)}>
      <div className="doctor-bundle">
        <p className="doctor-bundle__text">{t(`${K}.bundle.body`)}</p>
        <p className="doctor-bundle__privacy">
          <IconLock aria-hidden="true" />
          <span>{t(`${K}.bundle.privacy`)}</span>
        </p>
        <NeonButton
          variant="secondary"
          icon={<IconFileZip />}
          loading={bundle.isPending}
          loadingLabel={t(`${K}.bundle.creating`)}
          onClick={() => bundle.mutate()}
        >
          {t(`${K}.bundle.create`)}
        </NeonButton>
        {described && (
          <ErrorPanel
            title={described.title}
            body={described.body}
            detail={described.detail}
            detailLabel={t('common.technicalDetails')}
          />
        )}
        {created && (
          <div ref={resultRef} className="doctor-bundle__result">
            <CopyField
              label={t(`${K}.bundle.path`)}
              value={created}
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
            />
            <NeonButton
              variant="ghost"
              size="sm"
              icon={<IconFolderOpen />}
              onClick={() => openFolder(created)}
            >
              {t(`${K}.bundle.openFolder`)}
            </NeonButton>
          </div>
        )}
      </div>
    </PixelPanel>
  )
}
