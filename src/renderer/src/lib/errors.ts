// Turns any error into translated text: what went wrong (`errors.<CODE>`), how to fix it
// (`errors.help.<CODE>`) and, when there is one, the screen that fixes it.
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

/**
 * Accepts error data (AppErrorData), the plain GoatError object `window.goat.invoke` rejects with,
 * or anything thrown (which becomes AP_UNKNOWN with its text as the detail). Uses `t` when given, so a component
 * re-renders with the language; otherwise the app's i18n instance.
 */
export function describeError(e: unknown, t: TFunction = i18n.t): DescribedError {
  const data: AppErrorData = isAppErrorData(e) ? e : { code: 'AP_UNKNOWN', detail: String(e) }
  const params = data.params ?? {}
  const described: DescribedError = {
    title: t(`errors.${data.code}`, params),
    body: t(`errors.help.${data.code}`, params),
  }
  const action = ERROR_ACTIONS[data.code]
  if (action) described.action = action
  if (data.detail !== undefined) described.detail = data.detail
  if (data.logPath !== undefined) described.logPath = data.logPath
  return described
}
