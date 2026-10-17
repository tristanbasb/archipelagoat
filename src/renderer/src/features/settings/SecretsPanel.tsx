// The optional GitHub token, write-only: it goes to the secret store through app:setGithubToken and
// never comes back; the panel only knows whether one is saved (app:secretsStatus). Without a system
// keyring, the user may allow plaintext secrets, after a confirmation.
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconCircleCheck,
  IconKey,
  IconLockOpen,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Modal, NeonButton, PixelPanel, Spinner, Toggle, useToast } from '../../design/components'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useConfig } from '../../stores/config'
import { useConfigPatch, useErrorToast } from './feedback'
import { SettingRow, SettingsError } from './parts'

export function SecretsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const fieldId = useId()
  const config = useConfig()
  const patch = useConfigPatch()
  const status = useIpcQuery('app:secretsStatus', undefined)
  const showError = useErrorToast()
  // The secrets kept in clear are deleted with the permission: the panel then reads what is left.
  const withdrawPlaintext = (): void =>
    void config.set({ allowPlaintextSecrets: false }).then(() => status.refetch(), showError)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const store = useIpcMutation('app:setGithubToken', { invalidates: ['app:secretsStatus'] })
  const k = (key: string): string => t(`screens.settings.github.${key}`)

  const token = draft.trim()
  const removing = store.isPending && store.variables?.token === null
  const saving = store.isPending && !removing

  const save = (event: FormEvent): void => {
    event.preventDefault()
    if (!token || store.isPending) return
    store.mutate(
      { token },
      {
        onSuccess: () => {
          setDraft('')
          toast.push({ tone: 'ok', title: k('savedToast') })
        },
      },
    )
  }

  const remove = (): void => {
    store.mutate({ token: null }, { onSuccess: () => toast.push({ tone: 'ok', title: k('removedToast') }) })
  }

  if (status.isPending || status.isError) {
    return (
      <PixelPanel eyebrow={k('eyebrow')} title={k('title')} tone="magenta">
        {status.isPending ? (
          <Spinner label={k('loading')} />
        ) : (
          <SettingsError error={status.error} onRetry={() => void status.refetch()} />
        )}
      </PixelPanel>
    )
  }

  const { canEncrypt, hasGithubToken } = status.data

  return (
    <PixelPanel
      eyebrow={k('eyebrow')}
      title={k('title')}
      tone="magenta"
      actions={
        hasGithubToken ? (
          <Badge tone="green" icon={<IconCircleCheck />}>
            {k('saved')}
          </Badge>
        ) : (
          <Badge outline>{k('none')}</Badge>
        )
      }
    >
      <div className="settings-secrets">
        <div className="settings-stack">
          <p className="settings-muted settings-with-icon">
            <IconBrandGithub aria-hidden="true" />
            <span>{k('intro')}</span>
          </p>

          <form className="settings-token" onSubmit={save}>
            <div className="field">
              <label htmlFor={fieldId} className="field__label">
                {k('field')}
              </label>
              <div className="input-frame pixel-border tone-magenta">
                <IconKey aria-hidden="true" className="settings-token__key" />
                <input
                  id={fieldId}
                  className="input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={k('placeholder')}
                  aria-describedby={`${fieldId}-hint`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </div>
              <span id={`${fieldId}-hint`} className="field__hint">
                {k('fieldHint')}
              </span>
            </div>
            <div className="settings-actions">
              <NeonButton type="submit" disabled={!token || removing} loading={saving}>
                {k('save')}
              </NeonButton>
              {hasGithubToken && (
                <NeonButton
                  variant="ghost"
                  icon={<IconTrash />}
                  loading={removing}
                  disabled={saving}
                  onClick={remove}
                >
                  {k('remove')}
                </NeonButton>
              )}
            </div>
          </form>

          {store.isError && <SettingsError error={store.error} />}
        </div>

        {/* How secrets are kept: encrypted, or (without a keyring) in clear once allowed. */}
        <div className="settings-stack settings-secrets__storage">
          {canEncrypt ? (
            <p className="settings-note tone-green">
              <IconShieldLock aria-hidden="true" />
              <span>{k('encrypted')}</span>
            </p>
          ) : (
            <>
              <p className="settings-note tone-yellow">
                <IconAlertTriangle aria-hidden="true" />
                <span>{k('noKeyring')}</span>
              </p>
              <SettingRow icon={<IconLockOpen />} tone="yellow">
                <Toggle
                  label={k('plaintext')}
                  description={k('plaintextHint')}
                  checked={config.allowPlaintextSecrets}
                  tone="yellow"
                  onChange={(on) => (on ? setConfirming(true) : withdrawPlaintext())}
                />
              </SettingRow>
            </>
          )}
        </div>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        eyebrow={k('confirmEyebrow')}
        title={k('confirmTitle')}
        closeLabel={t('common.closeDialog')}
        tone="yellow"
        size="sm"
        footer={
          <>
            <NeonButton variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </NeonButton>
            <NeonButton
              variant="danger"
              icon={<IconLockOpen />}
              onClick={() => {
                setConfirming(false)
                // The refusal shown under the field no longer holds.
                store.reset()
                patch({ allowPlaintextSecrets: true })
              }}
            >
              {k('confirm')}
            </NeonButton>
          </>
        }
      >
        <div className="settings-confirm">
          <p>{k('confirmBody')}</p>
          <p className="settings-confirm__risk">{k('confirmRisk')}</p>
        </div>
      </Modal>
    </PixelPanel>
  )
}
