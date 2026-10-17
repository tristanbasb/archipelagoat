// Renames one player of a session file: session:readFile → studio:parse → new name on that document →
// studio:render of every document → joined with `\n---\n` → session:replaceFile. A file with several
// players keeps all of them.
import { IconFileCode, IconPencil } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { Session } from '@shared/types'
import { ErrorPanel, Modal, NeonButton, useToast } from '../../design/components'
import { describeError } from '../../lib/errors'
import { invoke } from '../../lib/goat'
import './RenameDialog.css'

/** Archipelago's limit on a slot name (`name-too-long`). */
const MAX_NAME = 16

export interface RenameTarget {
  fileId: string
  /** Index of the document in the file (PlayerDoc.index). */
  docIndex: number
  name: string
  /** The file holds other players too. */
  multiDoc: boolean
}

export interface RenameDialogProps {
  sessionId: string
  target: RenameTarget | null
  onClose: () => void
}

/** The file could not be parsed back into the documents the check listed. */
class UnreadableFile extends Error {}

function keyOf(target: RenameTarget | null): string | null {
  return target ? `${target.fileId}#${target.docIndex}` : null
}

export function RenameDialog({ sessionId, target, onClose }: RenameDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fieldId = useId()
  // The draft belongs to one target: another player starts from their own name.
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null)
  const key = keyOf(target)
  const name = target === null ? '' : draft?.key === key ? draft.value : target.name
  const trimmed = name.trim()

  const rename = useMutation<Session, unknown, { target: RenameTarget; name: string }>({
    mutationFn: async ({ target: { fileId, docIndex }, name: newName }) => {
      const { text } = await invoke('session:readFile', { id: sessionId, fileId })
      const { docs } = await invoke('studio:parse', { text })
      if (!docs[docIndex]) throw new UnreadableFile(fileId)
      const renamed = docs.map((doc, index) => (index === docIndex ? { ...doc, name: newName } : doc))
      const rendered = await Promise.all(renamed.map((doc) => invoke('studio:render', { doc })))
      return invoke('session:replaceFile', {
        id: sessionId,
        fileId,
        text: rendered.map((part) => part.text).join('\n---\n'),
      })
    },
    onSuccess: async (session, { name: newName }) => {
      queryClient.setQueryData(['session:get', { id: sessionId }], session)
      toast.push({ tone: 'ok', title: t('screens.session.rename.done', { name: newName }) })
      close()
      await Promise.all(
        ['session:validate', 'session:list'].map((channel) =>
          queryClient.invalidateQueries({ queryKey: [channel] }),
        ),
      )
    },
  })

  const close = (): void => {
    setDraft(null)
    rename.reset()
    onClose()
  }

  const problem =
    trimmed.length > MAX_NAME
      ? t('screens.session.rename.tooLong')
      : /^\d+$/.test(trimmed)
        ? t('screens.session.rename.numeric')
        : null
  const canSubmit = target !== null && trimmed !== '' && trimmed !== target.name && problem === null

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!target || !canSubmit || rename.isPending) return
    rename.mutate({ target, name: trimmed })
  }

  const failure =
    rename.error === null
      ? null
      : rename.error instanceof UnreadableFile
        ? 'unreadable'
        : describeError(rename.error, t)

  return (
    <Modal
      open={target !== null}
      onClose={close}
      dismissible={!rename.isPending}
      closeLabel={t('common.closeDialog')}
      tone="cyan"
      size="sm"
      eyebrow={t('screens.session.rename.eyebrow')}
      title={t('screens.session.rename.title', { name: target?.name ?? '' })}
      footer={
        <>
          <NeonButton variant="ghost" disabled={rename.isPending} onClick={close}>
            {t('common.cancel')}
          </NeonButton>
          <NeonButton
            icon={<IconPencil />}
            disabled={!canSubmit}
            loading={rename.isPending}
            loadingLabel={t('screens.session.rename.saving')}
            onClick={() => submit()}
          >
            {t('screens.session.rename.confirm')}
          </NeonButton>
        </>
      }
    >
      <form className="rename-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor={fieldId} className="field__label">
            {t('screens.session.rename.label')}
          </label>
          <div className="input-frame pixel-border tone-yellow" data-invalid={problem !== null || undefined}>
            <input
              id={fieldId}
              className="input"
              value={name}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problem !== null}
              aria-describedby={`${fieldId}-hint`}
              onChange={(event) => key && setDraft({ key, value: event.target.value })}
            />
            <span
              className="rename-form__count"
              data-over={trimmed.length > MAX_NAME || undefined}
              aria-hidden="true"
            >
              {trimmed.length}/{MAX_NAME}
            </span>
          </div>
          <span id={`${fieldId}-hint`} className="field__hint" data-problem={problem !== null || undefined}>
            {problem ?? t('screens.session.rename.hint')}
          </span>
        </div>
        {target?.multiDoc && <p className="rename-form__note">{t('screens.session.rename.multiDoc')}</p>}
        {failure === 'unreadable' && target && (
          <ErrorPanel
            title={t('screens.session.rename.unreadable')}
            actions={
              <NeonButton
                variant="secondary"
                size="sm"
                icon={<IconFileCode />}
                onClick={() => void navigate(`/studio?session=${sessionId}&file=${target.fileId}`)}
              >
                {t('screens.session.check.fixInStudio')}
              </NeonButton>
            }
          />
        )}
        {failure !== null && failure !== 'unreadable' && (
          <ErrorPanel
            title={failure.title}
            body={failure.body}
            detail={failure.detail}
            detailLabel={t('common.technicalDetails')}
          />
        )}
      </form>
    </Modal>
  )
}
