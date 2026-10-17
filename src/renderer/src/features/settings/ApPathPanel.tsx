// Where Archipelago is: the detected install, or a folder the user picks (checked by the main
// process through ap:setCustomPath before it is kept).
import { IconArrowBackUp, IconDownload, IconFolderSearch } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { ApInstall } from '@shared/types'
import { isAppErrorData } from '@shared/errors'
import {
  Badge,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  Spinner,
  StatusPill,
  useToast,
} from '../../design/components'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useConfig } from '../../stores/config'
import { PathText, SettingsError } from './parts'

const DETECT_KEY = ['ap:detect', undefined] as const

export function ApPathPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const config = useConfig()
  const detect = useIpcQuery('ap:detect', undefined)
  const pick = useIpcMutation('app:pickPaths')
  const setPath = useIpcMutation('ap:setCustomPath', {
    invalidates: ['ap:detect'],
    onSuccess: (install) => queryClient.setQueryData<ApInstall | null>(DETECT_KEY, install),
  })
  // The last pick or reset that failed, shown until the next attempt.
  const [error, setError] = useState<unknown>(null)
  const k = (key: string): string => t(`screens.settings.ap.${key}`)

  const install = detect.data
  // A saved folder that no longer holds Archipelago is ignored by detection: it can still be reset.
  const overridden = config.apPathOverride !== null || install?.kind === 'custom'
  const resetting = setPath.isPending && setPath.variables?.path === null
  const choosing = (pick.isPending || setPath.isPending) && !resetting

  const choose = async (): Promise<void> => {
    setError(null)
    try {
      const [dir] = await pick.mutateAsync({ mode: 'directory', title: k('pickTitle') })
      if (!dir) return
      await setPath.mutateAsync({ path: dir })
      toast.push({ tone: 'ok', title: k('saved') })
    } catch (caught) {
      setError(caught)
    }
  }

  const reset = async (): Promise<void> => {
    setError(null)
    try {
      await setPath.mutateAsync({ path: null })
      toast.push({ tone: 'ok', title: k('resetDone') })
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <PixelPanel eyebrow={k('eyebrow')} title={k('title')} tone="yellow">
      <div className="settings-stack">
        <div className="settings-ap">
          <div className="settings-ap__state">
            {detect.isPending ? (
              <Spinner label={k('checking')} />
            ) : detect.isError ? (
              <SettingsError error={detect.error} onRetry={() => void detect.refetch()} />
            ) : install ? (
              <>
                <div className="settings-ap__status">
                  <StatusPill
                    status={install.version ? 'ok' : 'warn'}
                    label={
                      install.version
                        ? t('screens.settings.ap.found', { version: install.version })
                        : k('foundUnknown')
                    }
                  />
                  {install.kind === 'custom' ? (
                    <Badge tone="yellow" outline>
                      {k('custom')}
                    </Badge>
                  ) : (
                    <>
                      <Badge outline>{k('auto')}</Badge>
                      <Badge>{k(`kinds.${install.kind}`)}</Badge>
                    </>
                  )}
                </div>
                <PathText path={install.root} />
              </>
            ) : (
              <>
                <div className="settings-ap__status">
                  <StatusPill status="error" label={k('missing')} />
                </div>
                <p className="settings-muted">{k('missingBody')}</p>
              </>
            )}
          </div>

          <div className="settings-actions">
            {detect.isSuccess && !install && (
              <NeonButton icon={<IconDownload />} onClick={() => void navigate('/install')}>
                {k('install')}
              </NeonButton>
            )}
            <NeonButton
              variant="secondary"
              icon={<IconFolderSearch />}
              loading={choosing}
              disabled={resetting}
              onClick={() => void choose()}
            >
              {k('choose')}
            </NeonButton>
            {overridden && (
              <NeonButton
                variant="ghost"
                icon={<IconArrowBackUp />}
                loading={resetting}
                disabled={choosing}
                onClick={() => void reset()}
              >
                {k('reset')}
              </NeonButton>
            )}
          </div>
        </div>

        {error !== null &&
          (isAppErrorData(error) && error.code === 'AP_NOT_INSTALLED' ? (
            <ErrorPanel className="settings-error" title={k('notHere')} body={k('notHereBody')} />
          ) : (
            <SettingsError error={error} />
          ))}
        <p className="field__hint">{k('hint')}</p>
      </div>
    </PixelPanel>
  )
}
