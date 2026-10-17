// Step 1: the players' YAML files. Files dropped on the zone or browsed go through session:addFiles;
// a YAML dropped anywhere else on the window is imported by the shell, which refreshes this list.
// Removing a file asks first (it may exist nowhere else: a Studio draft); main keeps it in backups/.
import { IconFileCode, IconFileOff, IconFileText, IconTrash, IconUserPlus, IconX } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { PlayerFile, Session } from '@shared/types'
import {
  Badge,
  ConfirmDialog,
  Dropzone,
  EmptyState,
  NeonButton,
  PixelPanel,
  Spinner,
  StatusPill,
  useToast,
  type Status,
} from '../../design/components'
import { NEON_SERIES, cssVars } from '../../design/classes'
import { useIpcMutation } from '../../hooks/useIpc'
import { fileName } from '../../hooks/useOpenRequests'
import { describeError } from '../../lib/errors'
import { StepNav } from './StepNav'
import './StepPlayers.css'

const ACCEPT = ['.yaml', '.yml', '.txt', '.zip'] as const

export interface StepPlayersProps {
  session: Session
  onNext: () => void
}

export function StepPlayers({ session, onNext }: StepPlayersProps): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [ignored, setIgnored] = useState<string[]>([])
  /** The file whose removal waits for a confirmation. */
  const [removing, setRemoving] = useState<PlayerFile | null>(null)

  const store = (updated: Session): void => {
    queryClient.setQueryData(['session:get', { id: session.id }], updated)
  }
  const remember = (names: string[]): void => {
    if (names.length > 0) setIgnored((list) => [...new Set([...list, ...names])])
  }
  const showError = (error: unknown): void => {
    const { title, body } = describeError(error, t)
    toast.push({ tone: 'error', title, body })
  }

  const addFiles = useIpcMutation('session:addFiles', {
    invalidates: ['session:validate', 'session:list'],
    onSuccess: ({ session: updated, ignored: paths }) => {
      store(updated)
      remember(paths.map(fileName))
    },
    onError: showError,
  })
  const pick = useIpcMutation('app:pickPaths', {
    onSuccess: (paths) => {
      if (paths.length > 0) addFiles.mutate({ id: session.id, paths })
    },
    onError: showError,
  })
  const remove = useIpcMutation('session:removeFile', {
    invalidates: ['session:validate', 'session:list'],
    onSuccess: store,
    onError: showError,
  })

  const browse = (): void =>
    pick.mutate({
      mode: 'files',
      title: t('screens.session.players.pickTitle'),
      filters: [
        { name: t('screens.session.players.pickFilter'), extensions: ACCEPT.map((ext) => ext.slice(1)) },
      ],
    })

  const files = session.players
  const playerCount = files.reduce((sum, file) => sum + file.docs.length, 0)
  const slots = firstSlots(files)

  return (
    <>
      <div className="players-step">
        <div className="players-step__intake">
          <Dropzone
            accept={ACCEPT}
            onFiles={(paths) => addFiles.mutate({ id: session.id, paths })}
            onBrowse={browse}
            onReject={remember}
            title={t('screens.session.players.dropTitle')}
            hint={t('screens.session.players.dropHint')}
            browseLabel={t('screens.session.players.browse')}
            className="players-step__drop"
          />
          {addFiles.isPending && (
            <Spinner
              size="sm"
              label={t('screens.session.players.importing')}
              className="players-step__busy"
            />
          )}
          <NeonButton
            variant="secondary"
            icon={<IconFileCode />}
            className="players-step__studio"
            onClick={() => void navigate('/studio')}
          >
            {t('screens.session.players.studio')}
          </NeonButton>
          {ignored.length > 0 && (
            <PixelPanel
              tone="yellow"
              padding="sm"
              headingLevel={3}
              title={t('screens.session.players.ignoredTitle')}
              className="ignored-files"
              actions={
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('screens.session.players.dismiss')}
                  onClick={() => setIgnored([])}
                >
                  <IconX aria-hidden="true" />
                </button>
              }
            >
              <p className="ignored-files__body">{t('screens.session.players.ignoredBody')}</p>
              <ul className="ignored-files__list">
                {ignored.map((name) => (
                  <li key={name}>
                    <IconFileOff aria-hidden="true" />
                    <span>{name}</span>
                  </li>
                ))}
              </ul>
            </PixelPanel>
          )}
        </div>

        <PixelPanel
          tone="cyan"
          padding="md"
          title={t('screens.session.players.title')}
          className="players-step__roster"
          actions={
            playerCount > 0 ? (
              <Badge tone="cyan">{t('screens.session.players.count', { count: playerCount })}</Badge>
            ) : undefined
          }
        >
          {files.length === 0 ? (
            <EmptyState
              tone="cyan"
              icon={<IconUserPlus />}
              title={t('screens.session.players.emptyTitle')}
              body={t('screens.session.players.emptyBody')}
            />
          ) : (
            <ul className="roster" aria-label={t('screens.session.players.listLabel')}>
              {files.map((file, index) => (
                <PlayerFileCard
                  key={file.id}
                  file={file}
                  firstSlot={slots[index] ?? 1}
                  removing={remove.isPending && remove.variables.fileId === file.id}
                  onRemove={() => setRemoving(file)}
                />
              ))}
            </ul>
          )}
        </PixelPanel>
      </div>
      <ConfirmDialog
        open={removing !== null}
        tone="pink"
        eyebrow={t('screens.session.players.removeEyebrow')}
        title={t('screens.session.players.removeTitle', { name: removing?.originalName ?? '' })}
        confirmLabel={t('screens.session.players.removeConfirm')}
        confirmVariant="danger"
        confirmIcon={<IconTrash />}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.closeDialog')}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const file = removing
          setRemoving(null)
          if (!file) return
          remove.mutate(
            { id: session.id, fileId: file.id },
            {
              onSuccess: () =>
                toast.push({
                  tone: 'info',
                  title: t('screens.session.players.removed', { name: file.originalName }),
                  body: t('screens.session.players.removeKept'),
                }),
            },
          )
        }}
      >
        <p>{t('screens.session.players.removeBody')}</p>
        {removing !== null && removing.docs.length > 0 && (
          <p>
            {t('screens.session.players.removePlayers', {
              names: removing.docs.map((doc) => doc.name ?? t('screens.session.players.noName')).join(', '),
            })}
          </p>
        )}
        <p className="confirm-dialog__note">{t('screens.session.players.removeKept')}</p>
      </ConfirmDialog>
      <StepNav
        onNext={onNext}
        nextDisabled={files.length === 0}
        blockedReason={t('screens.session.players.needPlayers')}
      />
    </>
  )
}

/** The slot number of each file's first player: slots run across files, in the session's order. */
function firstSlots(files: PlayerFile[]): number[] {
  const starts: number[] = []
  let next = 1
  for (const file of files) {
    starts.push(next)
    next += file.docs.length
  }
  return starts
}

function fileStatus(file: PlayerFile): { status: Status; errors: number; warnings: number } {
  const issues = file.docs.flatMap((doc) => doc.issues)
  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.length - errors
  return { status: errors > 0 ? 'error' : warnings > 0 ? 'warn' : 'ok', errors, warnings }
}

interface PlayerFileCardProps {
  file: PlayerFile
  firstSlot: number
  removing: boolean
  onRemove: () => void
}

function PlayerFileCard({ file, firstSlot, removing, onRemove }: PlayerFileCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const { status, errors, warnings } = fileStatus(file)
  const label =
    errors > 0
      ? t('screens.session.players.fileErrors', { count: errors })
      : warnings > 0
        ? t('screens.session.players.fileWarnings', { count: warnings })
        : t('screens.session.players.fileOk')
  return (
    <li className="roster-file pixel-border" data-status={status}>
      <div className="roster-file__head">
        <IconFileText className="roster-file__icon" aria-hidden="true" />
        <span className="roster-file__name" title={file.originalName}>
          {file.originalName}
        </span>
        <StatusPill status={status} label={label} />
        <button
          type="button"
          className="icon-btn icon-btn--danger"
          aria-label={t('screens.session.players.remove', { name: file.originalName })}
          disabled={removing}
          onClick={onRemove}
        >
          {removing ? <Spinner size="sm" /> : <IconTrash aria-hidden="true" />}
        </button>
      </div>
      {file.docs.length === 0 ? (
        <p className="roster-file__empty">{t('screens.session.players.noDocs')}</p>
      ) : (
        <ul className="roster-file__players">
          {file.docs.map((doc, index) => {
            const slot = firstSlot + index
            const name = doc.name ?? t('screens.session.players.noName')
            return (
              <li
                key={doc.index}
                className="roster-player"
                style={cssVars({
                  '--slot-tone': `var(--neon-${NEON_SERIES[(slot - 1) % NEON_SERIES.length]})`,
                })}
              >
                <span className="roster-player__avatar" aria-hidden="true">
                  {name.slice(0, 1).toUpperCase()}
                </span>
                <span className="roster-player__slot t-display" aria-hidden="true">
                  {t('screens.session.players.slot', { n: slot })}
                </span>
                <span className="roster-player__name">{name}</span>
                <span className="roster-player__games">
                  {doc.games.map((game) => (
                    <Badge key={game.game} tone="neutral" outline>
                      {game.game}
                    </Badge>
                  ))}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
