// Where joining starts: the link field, the patch drop, and the games joined lately.
import {
  IconChevronRight,
  IconFileZip,
  IconHistory,
  IconLink,
  IconPlayerPlayFilled,
  IconServer2,
  IconWorld,
  IconX,
} from '@tabler/icons-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { PATCH_ROUTES } from '@shared/data/patch-routes'
import type { AppErrorData } from '@shared/errors'
import type { JoinTarget } from '@shared/types'
import { Dropzone, EmptyState, ErrorPanel, NeonButton, PixelPanel, useToast } from '../../design/components'
import { fileName } from '../../hooks/useOpenRequests'
import { useIpcMutation } from '../../hooks/useIpc'
import { routeDroppedFile } from '../../lib/drop-routing'
import { describeError } from '../../lib/errors'
import type { RoomHistory, RoomHistoryEntry } from './room-history'
import { STEP_FOCUS } from './step-focus'
import './JoinEntry.css'

/**
 * What the file picker offers first: the patches with a known client and the slot archives (.zip);
 * "all files" covers the patches of the other worlds.
 */
const PATCH_EXTENSIONS = [...PATCH_ROUTES.map((route) => route.suffix.slice(1)), 'zip']

/** A patch (.ap…) or a slot archive (.zip): what the join flow opens. */
function isJoinFile(path: string): boolean {
  const intent = routeDroppedFile(path)?.intent
  return intent === 'join-patch' || intent === 'ask'
}

const KIND_ICON: Record<JoinTarget['kind'], React.JSX.Element> = {
  room: <IconWorld />,
  address: <IconServer2 />,
  patch: <IconFileZip />,
}

/** The icon of a room, a server address or a patch file. */
export function TargetIcon({ kind }: { kind: JoinTarget['kind'] }): React.JSX.Element {
  return KIND_ICON[kind]
}

export interface JoinEntryProps {
  input: string
  onInput: (value: string) => void
  resolving: boolean
  /** join:resolve refused the input. */
  error: AppErrorData | null
  /** Resolves and prepares a link, an address or a patch path. */
  onStart: (input: string) => void
  history: RoomHistory
}

export function JoinEntry({
  input,
  onInput,
  resolving,
  error,
  onStart,
  history,
}: JoinEntryProps): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const pickPaths = useIpcMutation('app:pickPaths')

  const openFiles = (paths: string[]): void => {
    const others = paths.filter((path) => !isJoinFile(path))
    if (others.length > 0) {
      toast.push({
        tone: 'warn',
        title: t('screens.join.patch.notPatch', { names: others.map(fileName).join(', ') }),
      })
    }
    const [first, ...extra] = paths.filter(isJoinFile)
    for (const path of extra) {
      toast.push({ tone: 'warn', title: t('shell.drop.oneAtATime', { name: fileName(path) }) })
    }
    if (first) onStart(first)
  }

  const browse = async (): Promise<void> => {
    try {
      const [path] = await pickPaths.mutateAsync({
        mode: 'file',
        title: t('screens.join.patch.pickTitle'),
        filters: [
          { name: t('screens.join.patch.filter'), extensions: PATCH_EXTENSIONS },
          { name: t('screens.join.patch.filterAll'), extensions: ['*'] },
        ],
      })
      if (path) openFiles([path])
    } catch (error) {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    }
  }

  return (
    <div className="join-screen__stack">
      <div className="join-entry">
        <LinkPanel
          input={input}
          onInput={onInput}
          onSubmit={() => onStart(input)}
          resolving={resolving}
          error={error}
        />
        <Dropzone
          className="join-entry__drop"
          accept={[]}
          icon={<IconFileZip />}
          title={t('screens.join.patch.title')}
          hint={t('screens.join.patch.hint')}
          browseLabel={t('screens.join.patch.browse')}
          disabled={resolving}
          onFiles={openFiles}
          onBrowse={() => void browse()}
          onReject={(names) =>
            toast.push({ tone: 'warn', title: t('shell.drop.noPath', { name: names.join(', ') }) })
          }
        />
      </div>
      <HistoryPanel
        entries={history.entries}
        onOpen={(entry) => onStart(entry.input)}
        onForget={history.forget}
      />
    </div>
  )
}

interface LinkPanelProps {
  input: string
  onInput: (value: string) => void
  onSubmit: () => void
  resolving: boolean
  error: AppErrorData | null
}

/** The link field: a room URL, an archipelago:// address or host:port. */
function LinkPanel({ input, onInput, onSubmit, resolving, error }: LinkPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const fieldId = useId()
  const hintId = useId()
  const described = error ? describeError(error, t) : null
  const fix = described?.action

  return (
    <PixelPanel
      className="join-entry__link"
      tone="cyan"
      glow
      eyebrow={t('screens.join.entry.eyebrow')}
      title={t('screens.join.entry.title')}
    >
      <form
        className="join-entry__form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="field">
          <label htmlFor={fieldId} className="field__label">
            {t('screens.join.entry.label')}
          </label>
          <span className="input-frame pixel-border tone-cyan join-entry__frame">
            <IconLink aria-hidden="true" />
            <input
              {...STEP_FOCUS}
              id={fieldId}
              className="input"
              type="text"
              value={input}
              placeholder={t('screens.join.entry.placeholder')}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={hintId}
              aria-invalid={error !== null || undefined}
              onChange={(event) => onInput(event.target.value)}
            />
          </span>
        </div>
        <NeonButton
          type="submit"
          size="lg"
          icon={<IconPlayerPlayFilled />}
          loading={resolving}
          loadingLabel={t('screens.join.entry.resolving')}
          disabled={input.trim() === ''}
        >
          {t('screens.join.entry.submit')}
        </NeonButton>
      </form>
      <p id={hintId} className="join-entry__hint">
        {t('screens.join.entry.hint')}
      </p>
      {described && (
        <ErrorPanel
          className="join-entry__error"
          title={described.title}
          body={described.body}
          detail={described.detail}
          detailLabel={t('common.technicalDetails')}
          actions={
            fix?.to ? (
              <NeonButton variant="secondary" size="sm" onClick={() => void navigate(fix.to ?? '/')}>
                {t(fix.labelKey)}
              </NeonButton>
            ) : undefined
          }
        />
      )}
    </PixelPanel>
  )
}

/** The games joined lately, to come back in one click. */
function HistoryPanel({
  entries,
  onOpen,
  onForget,
}: {
  entries: RoomHistoryEntry[]
  onOpen: (entry: RoomHistoryEntry) => void
  onForget: (entry: RoomHistoryEntry) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
  const labelOf = (entry: RoomHistoryEntry): string =>
    entry.kind === 'room' ? t('screens.join.history.room', { id: entry.label }) : entry.label

  return (
    <PixelPanel
      className="join-history"
      eyebrow={t('screens.join.history.eyebrow')}
      title={t('screens.join.history.title')}
    >
      {entries.length === 0 ? (
        <EmptyState
          tone="neutral"
          icon={<IconHistory />}
          title={t('screens.join.history.emptyTitle')}
          body={t('screens.join.history.emptyBody')}
        />
      ) : (
        <ul className="join-history__list">
          {entries.map((entry) => {
            const label = labelOf(entry)
            const date = new Date(entry.at)
            return (
              <li key={`${entry.kind}:${entry.label}`} className="join-history__item">
                <button
                  type="button"
                  className="join-history__open pixel-border"
                  onClick={() => onOpen(entry)}
                >
                  <span className="join-history__icon" aria-hidden="true">
                    <TargetIcon kind={entry.kind} />
                  </span>
                  <span className="join-history__main">
                    <span className="join-history__label">{label}</span>
                    {(entry.slot !== null || entry.game !== null) && (
                      <span className="join-history__meta">
                        {entry.slot !== null && <span className="join-history__slot">{entry.slot}</span>}
                        {entry.game !== null && <span className="join-history__game">{entry.game}</span>}
                      </span>
                    )}
                  </span>
                  {!Number.isNaN(date.getTime()) && (
                    <time className="join-history__when" dateTime={entry.at}>
                      {when.format(date)}
                    </time>
                  )}
                  <IconChevronRight className="join-history__go" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="join-history__forget"
                  aria-label={t('screens.join.history.forget', { label })}
                  title={t('screens.join.history.forget', { label })}
                  onClick={() => onForget(entry)}
                >
                  <IconX aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </PixelPanel>
  )
}
