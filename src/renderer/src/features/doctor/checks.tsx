// What the home alert banner and the diagnostic screen share: how checks rank, look and read, the
// doctor query, and the fix of a check (automatic, or the screen that fixes it).
import {
  IconApps,
  IconArrowRight,
  IconBolt,
  IconCloudDownload,
  IconCopy,
  IconCursorText,
  IconDatabase,
  IconDeviceGamepad2,
  IconFileAlert,
  IconFileBroken,
  IconFileSettings,
  IconPlug,
  IconPuzzleOff,
  IconShieldLock,
  IconStack2,
  IconWand,
  IconWifi,
  type Icon,
} from '@tabler/icons-react'
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { DoctorCheckId } from '@shared/codes'
import type { GoatError } from '@shared/errors'
import type { DoctorCheck, DoctorSeverity } from '@shared/types'
import { NeonButton, useToast, type NeonButtonSize, type Status, type Tone } from '../../design/components'
import { useIpcMutation, useIpcQuery, type IpcQueryOptions } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'

export const SEVERITY_STATUS: Record<DoctorSeverity, Status> = {
  error: 'error',
  warning: 'warn',
  info: 'info',
  ok: 'ok',
}

export const SEVERITY_TONE: Record<DoctorSeverity, Tone> = {
  error: 'pink',
  warning: 'yellow',
  info: 'cyan',
  ok: 'green',
}

const SEVERITY_RANK: Record<DoctorSeverity, number> = { error: 0, warning: 1, info: 2, ok: 3 }

export const CHECK_ICONS: Record<DoctorCheckId, Icon> = {
  'ap-installed': IconBolt,
  'ap-update': IconCloudDownload,
  'settings-file': IconFileSettings,
  'worlds-corrupt': IconFileBroken,
  'worlds-no-manifest': IconFileAlert,
  'worlds-incompatible': IconPuzzleOff,
  'worlds-shadowed': IconCopy,
  'worlds-bad-name': IconCursorText,
  'ap-processes': IconApps,
  'port-38281': IconPlug,
  bizhawk: IconDeviceGamepad2,
  'disk-space': IconDatabase,
  'programdata-acl': IconShieldLock,
  glibc: IconStack2,
  network: IconWifi,
}

/** Errors first, then warnings, notes and passing checks; the main process order within each. */
export function sortChecks(checks: readonly DoctorCheck[]): DoctorCheck[] {
  return [...checks].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

/** A warning or an error: what the home banner shows. */
export function isAlert(check: DoctorCheck): boolean {
  return check.severity === 'warning' || check.severity === 'error'
}

/**
 * Why the main process did not run the check (`params.skipped`, with an `ok` severity), or null when
 * it ran: Archipelago is not installed, the latest release could not be read, another system…
 */
export function skipReason(check: DoctorCheck): string | null {
  const reason = check.params.skipped
  return typeof reason === 'string' ? reason : null
}

/** Skip reasons that say the check is not for this machine: another system, no installer folder. */
const NOT_FOR_THIS_MACHINE: ReadonlySet<string> = new Set(['not-linux', 'not-windows', 'no-installer-folder'])

/** The checks that concern this machine: glibc on Linux only, the folder of an installer that ran… */
export function applicableChecks(checks: readonly DoctorCheck[]): DoctorCheck[] {
  return checks.filter((check) => !NOT_FOR_THIS_MACHINE.has(skipReason(check) ?? ''))
}

/** Nothing to do about it: passing, or only a note. A check that could not run did not pass. */
export function isPassing(check: DoctorCheck): boolean {
  return (check.severity === 'ok' || check.severity === 'info') && skipReason(check) === null
}

/** Skip reasons with their own sentence; any other one reads as "not checked". */
const SKIP_TEXTS: ReadonlySet<string> = new Set([
  'ap-not-installed',
  'release-unavailable',
  'version-unknown',
  'probe-failed',
])

/** The check's name and the sentence that describes its state, never "all is well" for a skipped one. */
export function checkText(check: DoctorCheck, t: TFunction): { title: string; text: string } {
  const title = t(`doctor.${check.id}.title`, check.params)
  const skipped = skipReason(check)
  if (skipped !== null) {
    return { title, text: t(`doctor.skipped.${SKIP_TEXTS.has(skipped) ? skipped : 'other'}`, check.params) }
  }
  return { title, text: t(`doctor.${check.id}.${check.severity === 'ok' ? 'ok' : 'problem'}`, check.params) }
}

export function useDoctorRun(opts?: IpcQueryOptions<'doctor:run'>): UseQueryResult<DoctorCheck[], GoatError> {
  return useIpcQuery('doctor:run', undefined, opts)
}

/** Lists a fix can change: a quarantined world, a reinstalled Archipelago… */
const AFTER_FIX = ['worlds:list', 'ap:detect', 'bizhawk:state'] as const

export interface DoctorFix {
  run: (checkId: DoctorCheckId) => void
  /** The check being fixed, if any: one fix at a time. */
  pending: DoctorCheckId | null
}

/** `doctor:fix`: it answers with the new list of checks, shown at once; a toast says how it went. */
export function useDoctorFix(): DoctorFix {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const mutation = useIpcMutation('doctor:fix', {
    onSuccess: (checks, { checkId }) => {
      queryClient.setQueryData(['doctor:run', undefined], checks)
      for (const name of AFTER_FIX) void queryClient.invalidateQueries({ queryKey: [name] })
      const title = t(`doctor.${checkId}.title`)
      const after = checks.find((check) => check.id === checkId)
      if (!after || isPassing(after))
        toast.push({ tone: 'ok', title: t('screens.doctor.fix.done', { title }) })
      else
        toast.push({
          tone: 'warn',
          title: t('screens.doctor.fix.partial', { title }),
          body: checkText(after, t).text,
        })
    },
    onError: (error) => {
      const described = describeError(error, t)
      toast.push({ tone: 'error', title: described.title, body: described.body })
    },
  })
  return {
    run: (checkId) => mutation.mutate({ checkId }),
    pending: mutation.isPending ? (mutation.variables?.checkId ?? null) : null,
  }
}

/** The label of a "go fix it there" button, after the screen it opens. */
const FIX_SCREENS: readonly (readonly [prefix: string, labelKey: string])[] = [
  ['/install', 'errors.actions.install'],
  ['/worlds', 'errors.actions.worlds'],
  ['/vault', 'errors.actions.vault'],
  ['/settings', 'errors.actions.settings'],
  ['/studio', 'errors.actions.studio'],
]

function navigateLabel(check: DoctorCheck, to: string, t: TFunction): string {
  if (check.id === 'ap-update') return t('errors.actions.update')
  const path = to.split(/[?#]/)[0] ?? to
  const screen = FIX_SCREENS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))
  return t(screen ? screen[1] : 'screens.doctor.fix.navigate')
}

export interface CheckFixButtonProps {
  check: DoctorCheck
  fix: DoctorFix
  size?: NeonButtonSize
}

/** The fix of a check that needs one: "Fix" runs it here, otherwise a button opens the screen. */
export function CheckFixButton({ check, fix, size = 'sm' }: CheckFixButtonProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  if (!check.fix || check.severity === 'ok') return null
  if (check.fix.kind === 'auto') {
    return (
      <NeonButton
        size={size}
        icon={<IconWand />}
        loading={fix.pending === check.id}
        loadingLabel={t('screens.doctor.fix.fixing')}
        disabled={fix.pending !== null}
        onClick={() => fix.run(check.id)}
      >
        {t('screens.doctor.fix.auto')}
      </NeonButton>
    )
  }
  const to = check.fix.to
  return (
    <NeonButton variant="secondary" size={size} icon={<IconArrowRight />} onClick={() => void navigate(to)}>
      {navigateLabel(check, to, t)}
    </NeonButton>
  )
}
