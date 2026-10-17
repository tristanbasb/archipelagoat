// Turns any error into translated text: what went wrong (`errors.<CODE>`), how to fix it
// (`errors.help.<CODE>`) and, when there is one, the screen that fixes it. The `params` fill the
// text's {{variables}} and pick its variant when it has one (see `variantsOf`).
import type { TFunction } from 'i18next'
import type { ErrorCode } from '@shared/codes'
import { isAppErrorData, type AppErrorData } from '@shared/errors'
import { i18n } from '../i18n'

export interface ErrorAction {
  /** i18n key of the button label. */
  labelKey: string
  /** Route that fixes the problem. */
  to?: string
}

export interface DescribedError {
  title: string
  body: string
  action?: ErrorAction
  /** Technical detail, for a folded "details" section. */
  detail?: string
  /** Full log of the failed operation, for an "open the log" button. */
  logPath?: string
}

const INSTALL: ErrorAction = { labelKey: 'errors.actions.install', to: '/install' }
const UPDATE: ErrorAction = { labelKey: 'errors.actions.update', to: '/install' }
const WORLDS: ErrorAction = { labelKey: 'errors.actions.worlds', to: '/worlds' }
const VAULT: ErrorAction = { labelKey: 'errors.actions.vault', to: '/vault' }
const SETTINGS: ErrorAction = { labelKey: 'errors.actions.settings', to: '/settings' }
const DOCTOR: ErrorAction = { labelKey: 'errors.actions.doctor', to: '/doctor' }
const STUDIO: ErrorAction = { labelKey: 'errors.actions.studio', to: '/studio' }

/** The screen that fixes each error, when one does. */
export const ERROR_ACTIONS: Partial<Record<ErrorCode, ErrorAction>> = {
  AP_NOT_INSTALLED: INSTALL,
  GITHUB_RATE_LIMITED: SETTINGS,
  SECRETS_UNAVAILABLE: SETTINGS,
  INSTALL_FAILED: DOCTOR,
  WORLD_INVALID: WORLDS,
  WORLD_INCOMPATIBLE: WORLDS,
  WORLD_CORRUPT_BLOCKING: WORLDS,
  YAML_PARSE: STUDIO,
  PORT_IN_USE: DOCTOR,
  ROM_MISSING: VAULT,
  ROM_BAD_HASH: VAULT,
  BIZHAWK_PREREQ_MISSING: VAULT,
  AP_WORLD_NOT_FOUND: WORLDS,
  AP_NO_GAME_OPTIONS: STUDIO,
  AP_VERSION_REQUIRED: UPDATE,
  AP_ROM_MISSING: VAULT,
  AP_ROM_HASH: VAULT,
  AP_MULTIDATA_INCOMPATIBLE: UPDATE,
  AP_SERVER_TOO_OLD: UPDATE,
  AP_PORT_IN_USE: DOCTOR,
  AP_UNKNOWN: DOCTOR,
}

/** A `reason` or `phase` value that can name a variant: no `.` or `:`, which i18next reads in a key. */
const VARIANT_NAME = /^[A-Za-z0-9-]+$/

/**
 * The variants of an error's texts that its params select, the most specific first: the value of a
 * `reason`, then of a `phase` (`errors.<CODE>_hosting`, `errors.<CODE>_running`), then `_message` for
 * a message from a site, `_file` for a file name and `_processes` for the programs to close. Each
 * text takes the first of them it has, or its plain version.
 */
function variantsOf(params: Record<string, string | number>): string[] {
  const named = [params.reason, params.phase].filter(
    (value): value is string => typeof value === 'string' && VARIANT_NAME.test(value),
  )
  const given = (['message', 'file', 'processes'] as const).filter((name) => {
    const value = params[name]
    return typeof value === 'string' && value !== ''
  })
  return [...named, ...given]
}

/**
 * Accepts error data (AppErrorData), the plain GoatError object `window.goat.invoke` rejects with,
 * or anything thrown (which becomes AP_UNKNOWN with its text as the detail). Uses `t` when given, so a component
 * re-renders with the language; otherwise the app's i18n instance.
 */
export function describeError(e: unknown, t: TFunction = i18n.t): DescribedError {
  const data: AppErrorData = isAppErrorData(e) ? e : { code: 'AP_UNKNOWN', detail: String(e) }
  const params = data.params ?? {}
  // i18next takes the first key of the list that has a text: the plain one comes last.
  const keys = (base: string): string[] => [...variantsOf(params).map((v) => `${base}_${v}`), base]
  const described: DescribedError = {
    title: t(keys(`errors.${data.code}`), params),
    body: t(keys(`errors.help.${data.code}`), params),
  }
  const action = ERROR_ACTIONS[data.code]
  if (action) described.action = action
  if (data.detail !== undefined) described.detail = data.detail
  if (data.logPath !== undefined) described.logPath = data.logPath
  return described
}
