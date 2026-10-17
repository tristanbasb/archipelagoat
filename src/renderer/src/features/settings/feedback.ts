// What the settings panels share: an error toast that names the problem and its fix, and a config
// setter that shows it when the main process refuses a change (the store has already rolled back).
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../../design/components'
import { describeError } from '../../lib/errors'
import { useConfig, type ConfigPatch } from '../../stores/config'

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

/** Patches the app config through app:setConfig, one field at a time. */
export function useConfigPatch(): (patch: ConfigPatch) => void {
  const { set } = useConfig()
  const showError = useErrorToast()
  return useCallback((patch: ConfigPatch) => void set(patch).catch(showError), [set, showError])
}
