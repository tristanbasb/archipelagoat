// An install-screen error: the translated message and fix, the facts carried by its parameters
// (rate-limit reset, checksums, installer exit code), and what to do next.
import { IconFileText, IconRefresh } from '@tabler/icons-react'
import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { AppErrorData } from '@shared/errors'
import { ErrorPanel, NeonButton, useToast } from '../../design/components'
import { useIpcMutation } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'

const INNO_EXIT_CODES_WITH_TEXT = new Set([1, 2, 3, 4, 5, 6, 7, 8])
const INSTALL_ROUTE = '/install'

function numberParam(value: string | number | undefined): number | null {
  if (value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function shortHash(hash: string): string {
  return hash.length > 24 ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : hash
}

export function formatBytes(bytes: number, lang: string): string {
  const [unit, divisor] =
    bytes >= 1e9
      ? ['gigabyte', 1e9]
      : bytes >= 1e6
        ? ['megabyte', 1e6]
        : bytes >= 1e3
          ? ['kilobyte', 1e3]
          : ['byte', 1]
  return new Intl.NumberFormat(lang, { style: 'unit', unit, maximumFractionDigits: 1 }).format(
    bytes / divisor,
  )
}

/** A time later today reads "14:32"; another day adds the date. */
function formatReset(epochMs: number, lang: string): string {
  const when = new Date(epochMs)
  const sameDay = when.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(lang, {
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(when)
}

/** The facts the parameters of an error carry, as sentences. */
export function errorFacts(error: AppErrorData, t: TFunction, lang: string): string[] {
  const params = error.params ?? {}
  switch (error.code) {
    case 'GITHUB_RATE_LIMITED': {
      const resetAt = numberParam(params.resetAt)
      return resetAt === null
        ? []
        : [t('screens.install.facts.rateLimit', { time: formatReset(resetAt, lang) })]
    }
    case 'DOWNLOAD_HASH_MISMATCH': {
      const { expected, actual } = params
      if (typeof expected === 'string' && typeof actual === 'string') {
        return [t('screens.install.facts.hash', { expected: shortHash(expected), actual: shortHash(actual) })]
      }
      const expectedSize = numberParam(params.expectedSize)
      const actualSize = numberParam(params.actualSize)
      if (expectedSize === null || actualSize === null) return []
      return [
        t('screens.install.facts.size', {
          expected: formatBytes(expectedSize, lang),
          actual: formatBytes(actualSize, lang),
        }),
      ]
    }
    case 'INSTALL_FAILED': {
      // The installer's own reason is English: the exit code is translated instead.
      const code = numberParam(params.exitCode)
      if (code === null) return []
      return INNO_EXIT_CODES_WITH_TEXT.has(code)
        ? [t('screens.install.facts.exitCode', { code, reason: t(`screens.install.exitCodes.${code}`) })]
        : [t('screens.install.facts.exitCodeOnly', { code })]
    }
    default:
      return []
  }
}

export interface InstallErrorProps {
  error: AppErrorData
  /** Shows a Retry button. */
  onRetry?: () => void
  /** Replaces the generic text, when the screen knows better what the error means here. */
  title?: string
  body?: string
  /** More buttons, after the others. */
  children?: ReactNode
  headingLevel?: 2 | 3 | 4
  className?: string
}

export function InstallError({
  error,
  onRetry,
  title,
  body,
  children,
  headingLevel = 3,
  className,
}: InstallErrorProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const openLog = useIpcMutation('app:openPath', {
    onError: (failure) => {
      const described = describeError(failure, t)
      toast.push({ tone: 'error', title: described.title, body: described.body })
    },
  })
  const described = describeError(error, t)
  const facts = errorFacts(error, t, i18n.language)
  const { logPath } = described
  // An action leading to this very screen would do nothing.
  const action =
    described.action?.to !== undefined && described.action.to !== INSTALL_ROUTE ? described.action : null
  const hasActions = onRetry !== undefined || action !== null || logPath !== undefined || children

  return (
    <ErrorPanel
      className={className}
      headingLevel={headingLevel}
      title={title ?? described.title}
      body={
        <>
          {body ?? described.body}
          {facts.map((fact) => (
            <span key={fact} className="install-error__fact">
              {fact}
            </span>
          ))}
        </>
      }
      detail={described.detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        hasActions ? (
          <>
            {onRetry && (
              <NeonButton size="sm" icon={<IconRefresh />} onClick={onRetry}>
                {t('common.retry')}
              </NeonButton>
            )}
            {action?.to !== undefined && (
              <NeonButton size="sm" variant="secondary" onClick={() => void navigate(action.to ?? '/')}>
                {t(action.labelKey)}
              </NeonButton>
            )}

            {logPath !== undefined && (
              <NeonButton
                size="sm"
                variant="ghost"
                icon={<IconFileText />}
                onClick={() => openLog.mutate({ path: logPath })}
              >
                {t('common.openLog')}
              </NeonButton>
            )}
            {children}
          </>
        ) : undefined
      }
    />
  )
}
