// Each slot's files (the patch the player opens to start their game): open the slot folder, copy its
// path, and for an archipelago.gg room copy the patch download link.
import { IconFileZip, IconFolderOpen } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import type { Slot } from '@shared/types'
import { cx, NEON_SERIES, toneClass } from '../../design/classes'
import { NeonButton, PixelPanel, useToast } from '../../design/components'
import { useIpcMutation } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import { CopyButton } from './CopyButton'
import { fileName, slotFolder } from './live-state'
import './SlotFiles.css'

const KEY = 'screens.host.files'

export interface SlotFilesProps {
  slots: readonly Slot[]
  /** archipelago.gg download link of each slot's patch, by slot number. */
  downloads?: ReadonlyMap<number, string>
  className?: string
}

export function SlotFiles({ slots, downloads, className }: SlotFilesProps): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const open = useIpcMutation('app:openPath', {
    onError: (error) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
  })

  return (
    <PixelPanel title={t(`${KEY}.title`)} className={cx('slot-files', className)}>
      <p className="slot-files__hint">{slots.length > 0 ? t(`${KEY}.hint`) : t(`${KEY}.none`)}</p>
      {slots.length > 0 && (
        <ul className="slot-files__list">
          {slots.map((slot, index) => {
            const folder = slot.patchFile ? slotFolder(slot.patchFile) : null
            const link = downloads?.get(slot.slot)
            const hasActions = folder !== null || link !== undefined
            return (
              <li
                key={slot.slot}
                className={cx(
                  'slot-files__row',
                  toneClass(NEON_SERIES[index % NEON_SERIES.length] ?? 'violet'),
                )}
              >
                <span className="slot-files__slot t-display">
                  {t('screens.host.players.slot', { slot: slot.slot })}
                </span>
                <span className="slot-files__who">
                  <span className="slot-files__name">{slot.name}</span>
                  <span className="slot-files__game">{slot.game}</span>
                </span>
                {slot.patchFile ? (
                  <span className="slot-files__file" title={slot.patchFile}>
                    <IconFileZip aria-hidden="true" />
                    <span>{fileName(slot.patchFile)}</span>
                  </span>
                ) : (
                  <span
                    className={cx(
                      'slot-files__file slot-files__file--none',
                      !hasActions && 'slot-files__file--wide',
                    )}
                  >
                    {t(`${KEY}.noFile`)}
                  </span>
                )}
                {hasActions && (
                  <span className="slot-files__actions">
                    {folder !== null && (
                      <>
                        <NeonButton
                          variant="secondary"
                          size="sm"
                          icon={<IconFolderOpen />}
                          aria-label={t(`${KEY}.openFor`, { name: slot.name })}
                          onClick={() => open.mutate({ path: folder })}
                        >
                          {t(`${KEY}.open`)}
                        </NeonButton>
                        <CopyButton
                          value={() => folder}
                          label={t(`${KEY}.copyPath`)}
                          copiedLabel={t(`${KEY}.copied`)}
                          aria-label={t(`${KEY}.copyPathFor`, { name: slot.name })}
                        />
                      </>
                    )}
                    {link !== undefined && (
                      <CopyButton
                        value={() => link}
                        label={t(`${KEY}.copyLink`)}
                        copiedLabel={t(`${KEY}.copied`)}
                        aria-label={t(`${KEY}.copyLinkFor`, { name: slot.name })}
                      />
                    )}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </PixelPanel>
  )
}
