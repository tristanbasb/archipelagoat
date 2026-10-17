// System integration (spec §3.10): the Linux desktop entry, the archipelago:// handler and the
// .apsml2 association on Windows. Each switch shows what the main process reports, and stays off
// where the system cannot do it.
import { IconDeviceDesktop, IconFileZip, IconLink, IconPlugConnected } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { IntegrationState, OS } from '@shared/types'
import type { Tone } from '../../design/classes'
import { EmptyState, PixelPanel, Spinner, Toggle } from '../../design/components'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useErrorToast } from './feedback'
import { SettingRow, SettingsError } from './parts'

type Integration = keyof IntegrationState['available']

const INTEGRATIONS: readonly { key: Integration; os: OS; icon: ReactNode; tone: Tone }[] = [
  { key: 'linuxDesktop', os: 'linux', icon: <IconDeviceDesktop />, tone: 'green' },
  { key: 'winProtocol', os: 'win32', icon: <IconLink />, tone: 'cyan' },
  { key: 'winAssociations', os: 'win32', icon: <IconFileZip />, tone: 'violet' },
]

const STATE_KEY = ['system:integration', undefined] as const

export function IntegrationPanel({ os }: { os: OS }): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const showError = useErrorToast()
  const state = useIpcQuery('system:integration', undefined)
  const update = useIpcMutation('system:setIntegration', {
    onSuccess: (next) => queryClient.setQueryData<IntegrationState>(STATE_KEY, next),
    onError: showError,
  })
  const k = (key: string): string => t(`screens.settings.integration.${key}`)

  const body = (): ReactNode => {
    if (state.isPending) return <Spinner label={k('loading')} />
    if (state.isError) return <SettingsError error={state.error} onRetry={() => void state.refetch()} />
    const current = state.data
    // The other system's integrations are left out, unless the main process offers them.
    const shown = INTEGRATIONS.filter((item) => item.os === os || current.available[item.key])
    if (shown.length === 0) {
      return <EmptyState tone="neutral" icon={<IconPlugConnected />} title={k('none')} headingLevel={3} />
    }
    return shown.map(({ key, icon, tone }) => {
      const available = current.available[key]
      return (
        <SettingRow key={key} icon={icon} tone={tone}>
          <Toggle
            label={k(key)}
            description={
              available ? (
                k(`${key}Hint`)
              ) : (
                <>
                  {k(`${key}Hint`)} <strong className="settings-unavailable">{k('unavailable')}</strong>
                </>
              )
            }
            checked={available && current[key]}
            disabled={!available}
            tone={tone}
            // One change at a time; the switch stays focusable meanwhile.
            onChange={(on) => {
              if (!update.isPending) update.mutate({ [key]: on })
            }}
          />
        </SettingRow>
      )
    })
  }

  return (
    <PixelPanel eyebrow={k('eyebrow')} title={k('title')} tone="green">
      <div className="settings-stack">{body()}</div>
    </PixelPanel>
  )
}
