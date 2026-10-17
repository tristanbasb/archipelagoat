import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../../design/components'
import { describeError } from '../../lib/errors'

/** Shows a failed action as an error toast: what went wrong and how to fix it. */
export function useErrorToast(): (error: unknown) => void {
  const { t } = useTranslation()
  const toast = useToast()
  return useCallback(
    (error: unknown) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
    [t, toast],
  )
}
