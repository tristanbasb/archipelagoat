import type { TFunction } from 'i18next'
import type { ErrorPanelProps } from '../../design/components'
import { describeError } from '../../lib/errors'

/** An ErrorPanel for any error of this screen: what went wrong, how to fix it, the folded detail. */
export function errorPanelProps(
  error: unknown,
  t: TFunction,
): Pick<ErrorPanelProps, 'title' | 'body' | 'detail' | 'detailLabel'> {
  const { title, body, detail } = describeError(error, t)
  return {
    title,
    body,
    ...(detail !== undefined ? { detail } : {}),
    detailLabel: t('common.technicalDetails'),
  }
}
