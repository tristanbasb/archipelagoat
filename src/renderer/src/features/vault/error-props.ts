import type { TFunction } from 'i18next'
import { isAppErrorData } from '@shared/errors'
import type { ErrorPanelProps } from '../../design/components'
import { describeError } from '../../lib/errors'

type ErrorPanelTexts = Pick<ErrorPanelProps, 'title' | 'body' | 'detail' | 'detailLabel'>

/** An ErrorPanel for any error of this screen: what went wrong, how to fix it, the folded detail. */
export function errorPanelProps(error: unknown, t: TFunction): ErrorPanelTexts {
  const { title, body, detail } = describeError(error, t)
  return {
    title,
    body,
    ...(detail !== undefined ? { detail } : {}),
    detailLabel: t('common.technicalDetails'),
  }
}

/** The `params.reason` the BizHawk install gives to an INSTALL_FAILED (main/core/play/bizhawk.ts). */
export const BIZHAWK_INSTALL_REASONS = ['remove-old', 'extract', 'launcher-missing', 'no-digest'] as const

type BizhawkInstallReason = (typeof BIZHAWK_INSTALL_REASONS)[number]

function isInstallReason(value: unknown): value is BizhawkInstallReason {
  return (BIZHAWK_INSTALL_REASONS as readonly unknown[]).includes(value)
}

/**
 * The ErrorPanel of the BizHawk card: a failed install says why and what to do, in place of the generic
 * advice. Any other error, or an install failure of a reason it does not know, keeps the generic text.
 */
export function bizhawkErrorPanelProps(error: unknown, t: TFunction): ErrorPanelTexts {
  const props = errorPanelProps(error, t)
  if (!isAppErrorData(error) || error.code !== 'INSTALL_FAILED') return props
  const reason = error.params?.reason
  if (!isInstallReason(reason)) return props
  return { ...props, body: t(`screens.vault.bizhawk.installErrors.${reason}`) }
}
