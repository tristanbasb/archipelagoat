// The YAML Studio (spec §4.2.4): pick a game, set each option with the control its kind needs
// (simple or weighted), watch the YAML and its validation live, then save it, export it or add it
// to a game. Entry routes: /studio (the draft left here, or a new YAML), /studio?open=<path> (a file
// opened with the app or dropped), /studio?session=<id>&file=<fileId> (a player of a game, saved back
// into it before returning to the wizard's check step).
import { IconRefresh } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { docFromSchema } from '@shared/studio-model'
import type { EditorDoc, GameSchema, Issue, SessionSummary, StudioGame } from '@shared/types'
import { ErrorPanel, Modal, NeonButton, Segmented, Spinner, useToast } from '../../design/components'
import { useIpcQuery } from '../../hooks/useIpc'
import { useShortcuts } from '../../hooks/useShortcuts'
import { ScreenHeader } from '../../layout/ScreenHeader'
import { describeError } from '../../lib/errors'
import { invoke } from '../../lib/goat'
import { humanize, issueTarget, suggestedFileName, withPreset, type IssueTarget } from './editor-ops'
import { GAME_FIELD_ID, TemplateOffer } from './GamePicker'
import { IssueList } from './IssueList'
import type { DocEdit } from './OptionField'
import { OptionList, type OptionListHandle } from './OptionList'
import { NAME_FIELD_ID, PlayerPanel } from './PlayerPanel'
import { SessionPicker } from './SessionPicker'
import {
  EMPTY_DRAFT,
  isDirty,
  keepDraft,
  keptDraft,
  loadedDraft,
  sourceFileName,
  type Draft,
  type StudioSource,
} from './studio-draft'
import { loadFile, renderFile, withSingleGame, type EntryRequest, type LoadedFile } from './studio-files'
import { StudioStart } from './StudioStart'
import { StudioToolbar } from './StudioToolbar'
import { useLivePreview } from './useLivePreview'
import { YamlPreview } from './YamlPreview'
import './StudioScreen.css'

/** The name of a new player, as in Archipelago's templates: unique in a game thanks to {number}. */
const DEFAULT_NAME = 'Player{number}'
const ENTRY_PARAMS = ['open', 'session', 'file'] as const
const NO_ISSUES: Issue[] = []

interface Confirmation {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
}

interface Problem {
  title: string
  body?: string
  detail?: string
}

type SaveOutcome =
  | { kind: 'lost'; issue: Issue }
  | { kind: 'cancelled' }
  | { kind: 'saved' | 'exported'; path: string; docs: EditorDoc[] }
  | { kind: 'session'; sessionId: string }

function entryOf(params: URLSearchParams): EntryRequest | null {
  const path = params.get('open')
  if (path) return { kind: 'file', path }
  const sessionId = params.get('session')
  const fileId = params.get('file')
  return sessionId && fileId ? { kind: 'session', sessionId, fileId } : null
}

/**
 * A doc for `game`: the schema's defaults, keeping the player of `before` (its name, description,
 * requires and other root keys). A `game` mapping of the file (a random pick among games) goes: the
 * doc now names one game.
 */
function docForGame(game: string, schema: GameSchema | null, before: EditorDoc | null): EditorDoc {
  const name = before?.name ?? DEFAULT_NAME
  const base: EditorDoc = schema
    ? docFromSchema(schema, name)
    : { name, description: '', game, requiresVersion: null, options: {}, extraRoot: {} }
  if (!before) return base
  return {
    ...base,
    description: before.description,
    requiresVersion: base.requiresVersion ?? before.requiresVersion,
    extraRoot: Object.fromEntries(Object.entries(before.extraRoot).filter(([key]) => key !== 'game')),
  }
}

/** A doc whose game is a random pick among several (Archipelago's `game:` mapping). */
const picksAmongGames = (doc: EditorDoc | null): doc is EditorDoc =>
  doc !== null && doc.game === '' && Object.hasOwn(doc.extraRoot, 'game')

/** `draft` with its doc on screen replaced. */
function withActiveDoc(draft: Draft, doc: EditorDoc): Draft {
  return { ...draft, docs: draft.docs.map((current, index) => (index === draft.active ? doc : current)) }
}

const fileNameOf = (docs: EditorDoc[]): string => (docs[0] ? suggestedFileName(docs[0]) : 'Player.yaml')

export function StudioScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const [draft, setDraft] = useState<Draft>(keptDraft)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  /** The entry route already opened, or agreed to over unsaved changes: it asks no more. */
  const [settledEntry, setSettledEntry] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const listRef = useRef<OptionListHandle>(null)

  useEffect(() => keepDraft(draft), [draft])

  const doc = draft.docs[draft.active] ?? null
  const dirty = useMemo(() => isDirty(draft), [draft])

  // --- games and schema ----------------------------------------------------------------------------

  const games = useIpcQuery('studio:games', undefined)
  const game = doc?.game ?? ''
  const gameInfo = games.data?.find((entry) => entry.game === game)
  const schemaQuery = useIpcQuery(
    'studio:schema',
    { game },
    { enabled: game !== '' && (games.isError || (games.isSuccess && gameInfo?.schemaSource !== 'none')) },
  )
  const schema = schemaQuery.data?.game === game ? schemaQuery.data : undefined

  // --- editing and live preview --------------------------------------------------------------------

  const updateDoc = useCallback<DocEdit>((change) => {
    setDraft((current) => {
      const before = current.docs[current.active]
      if (!before) return current
      const after = change(before)
      return after === before ? current : withActiveDoc(current, after)
    })
  }, [])

  const preview = useLivePreview(doc, draft.loadId)
  const { issuesByKey, nameIssues } = useMemo(() => {
    const byKey = new Map<string, Issue[]>()
    const name: Issue[] = []
    for (const issue of preview.issues) {
      const target = issueTarget(issue, game)
      if (target?.kind === 'option') byKey.set(target.key, [...(byKey.get(target.key) ?? []), issue])
      if (target?.kind === 'name') name.push(issue)
    }
    return { issuesByKey: byKey, nameIssues: name.length > 0 ? name : NO_ISSUES }
  }, [preview.issues, game])

  /** Brings what an issue is about into view and gives it the focus. */
  const reveal = useCallback((target: IssueTarget) => {
    const element =
      target.kind === 'option'
        ? (listRef.current?.reveal(target.key) ?? null)
        : target.kind === 'name'
          ? document.getElementById(NAME_FIELD_ID)
          : (document.getElementById(GAME_FIELD_ID)?.querySelector('input') ?? null)
    if (!element) return
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.focus({ preventScroll: true })
  }, [])

  const labelOf = useCallback(
    (target: IssueTarget): string =>
      target.kind === 'option'
        ? humanize(target.key)
        : t(target.kind === 'name' ? 'screens.studio.check.name' : 'screens.studio.check.game'),
    [t],
  )

  const toastError = (error: unknown): void => {
    const { title, body } = describeError(error, t)
    toast.push({ tone: 'error', title, body })
  }

  /** A raw value that is not valid YAML would be left out of the file: say so, show it. */
  const showLost = (issue: Issue): void => {
    toast.push({
      tone: 'error',
      title: t('screens.studio.save.invalidRaw'),
      body: t('screens.studio.save.invalidRawBody'),
    })
    const target = issueTarget(issue, game)
    if (target) reveal(target)
  }

  /** Runs `action` at once, or after a confirmation when unsaved changes would be lost. */
  const discarding = (action: () => void): void => {
    if (!dirty) action()
    else
      setConfirm({
        title: t('screens.studio.discard.title'),
        body: t('screens.studio.discard.body'),
        confirmLabel: t('screens.studio.discard.confirm'),
        onConfirm: action,
      })
  }

  // --- loading -------------------------------------------------------------------------------------

  const applyLoaded = useCallback(
    (loaded: LoadedFile | null): void => {
      if (!loaded) return
      const [issue] = loaded.issues
      if (loaded.docs.length === 0) {
        const line = issue?.params?.line
        setProblem({
          title: t(issue ? 'screens.studio.load.unreadable' : 'screens.studio.load.empty'),
          body: issue
            ? [t(`issues.${issue.code}`), line !== undefined && t('screens.studio.load.line', { line })]
                .filter(Boolean)
                .join(' · ')
            : undefined,
        })
        return
      }
      setProblem(null)
      setActiveKey(null)
      setDraft((current) => loadedDraft(current, loaded.source, loaded.docs))
    },
    [t],
  )
  const loadFailed = useCallback(
    (error: unknown): void => {
      const { title, body, detail } = describeError(error, t)
      setProblem({ title: t('screens.studio.load.failed'), body: `${title} ${body}`, detail })
    },
    [t],
  )
  const load = useMutation({ mutationFn: loadFile })
  const { mutate: loadRequest } = load

  // Entry routes: each navigation to one loads it once (a file dropped twice opens twice), and the
  // URL keeps naming what is edited until the user starts something else (New, Open), which takes the
  // entry out of it. Over unsaved changes, the confirmation below asks first.
  const entry = useMemo(() => entryOf(params), [params])
  const entryKey = entry ? `${location.key}\u0000${JSON.stringify(entry)}` : null
  const entryNeedsConfirm = entryKey !== null && dirty && settledEntry !== entryKey
  const startedEntry = useRef<string | null>(null)
  const clearEntry = useCallback(() => {
    setSettledEntry(null)
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const name of ENTRY_PARAMS) next.delete(name)
        return next
      },
      { replace: true },
    )
  }, [setParams])
  useEffect(() => {
    if (entryKey === null || entry === null) {
      startedEntry.current = null
      return
    }
    if (entryNeedsConfirm || startedEntry.current === entryKey) return
    startedEntry.current = entryKey
    loadRequest(entry, {
      onSuccess: (loaded) => {
        setSettledEntry(entryKey)
        applyLoaded(loaded)
      },
      onError: (error) => {
        setSettledEntry(entryKey)
        loadFailed(error)
      },
    })
  }, [entry, entryKey, entryNeedsConfirm, loadRequest, applyLoaded, loadFailed])

  const openDialog = (): void =>
    discarding(() =>
      load.mutate(
        { kind: 'dialog' },
        {
          onSuccess: (loaded) => {
            if (loaded && entry) clearEntry()
            applyLoaded(loaded)
          },
          onError: loadFailed,
        },
      ),
    )

  const startNew = (): void =>
    discarding(() => {
      if (entry) clearEntry()
      setProblem(null)
      setActiveKey(null)
      setDraft((current) => ({ ...EMPTY_DRAFT, loadId: current.loadId + 1 }))
    })

  /**
   * Done with a session's player: to the wizard's check step, the Studio starting afresh next time.
   * The empty draft is kept at once: the screen unmounts before its effects would see it.
   */
  const leaveToSession = (sessionId: string): void => {
    const fresh: Draft = { ...EMPTY_DRAFT, loadId: draft.loadId + 1 }
    keepDraft(fresh)
    setDraft(fresh)
    void navigate(`/session/${sessionId}?step=2`)
  }

  // --- game and presets ----------------------------------------------------------------------------

  const fetchSchema = (name: string): Promise<GameSchema> =>
    queryClient.fetchQuery({
      queryKey: ['studio:schema', { game: name }],
      queryFn: () => invoke('studio:schema', { game: name }),
    })

  const pickGame = async (picked: StudioGame): Promise<void> => {
    const before = doc
    setPicking(picked.game)
    // A schema that fails to load shows in the options area (same query), with a retry.
    const [pickedSchema, fromFile] = await Promise.all([
      picked.schemaSource === 'none' ? null : fetchSchema(picked.game).catch(() => null),
      // A file picking among games keeps what its section of this game held.
      picksAmongGames(before) ? withSingleGame(before, picked.game).catch(() => null) : null,
    ])
    setPicking(null)
    setActiveKey(null)
    setDraft((current) => {
      const previous = current.docs[current.active] ?? null
      const next = fromFile ?? docForGame(picked.game, pickedSchema, previous)
      return previous
        ? { ...withActiveDoc(current, next), loadId: current.loadId + 1 }
        : { ...current, docs: [next], active: 0, saved: JSON.stringify([next]), loadId: current.loadId + 1 }
    })
    if (before && (before.game !== '' || picksAmongGames(before))) {
      toast.push({
        tone: 'info',
        title: t('screens.studio.game.changed', { game: picked.game }),
        action: { label: t('screens.studio.presets.undo'), onClick: () => updateDoc(() => before) },
      })
    }
  }

  const requestGame = (picked: StudioGame): void => {
    if (doc && doc.game !== '' && (dirty || draft.source.kind !== 'new')) {
      setConfirm({
        title: t('screens.studio.game.changeTitle'),
        body: t('screens.studio.game.changeBody', { from: doc.game, to: picked.game }),
        confirmLabel: t('screens.studio.game.changeConfirm'),
        onConfirm: () => void pickGame(picked),
      })
    } else void pickGame(picked)
  }

  /** Archipelago wrote the templates: the games again, and the defaults of a doc still empty. */
  const templatesGenerated = async (name: string): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['studio:games'] })
    await queryClient.invalidateQueries({ queryKey: ['studio:schema'] })
    const generated = await fetchSchema(name).catch(() => null)
    if (!generated) return
    setDraft((current) => {
      const before = current.docs[current.active]
      if (!before || before.game !== name || Object.keys(before.options).length > 0) return current
      const next = withActiveDoc(current, docForGame(name, generated, before))
      // A new YAML nobody touched yet stays untouched: the defaults are where it starts.
      return current.source.kind === 'new' && !isDirty(current)
        ? { ...next, saved: JSON.stringify(next.docs) }
        : next
    })
  }

  const applyPreset = (preset: string | null): void => {
    if (!schema || !doc) return
    const before = doc
    updateDoc((current) => withPreset(schema, current, preset))
    toast.push({
      tone: 'ok',
      title:
        preset === null
          ? t('screens.studio.presets.reset')
          : t('screens.studio.presets.applied', { name: preset }),
      action: { label: t('screens.studio.presets.undo'), onClick: () => updateDoc(() => before) },
    })
  }

  // --- saving --------------------------------------------------------------------------------------

  const refreshSessions = (): Promise<unknown> =>
    Promise.all(
      ['session:validate', 'session:list'].map((channel) =>
        queryClient.invalidateQueries({ queryKey: [channel] }),
      ),
    )

  const save = useMutation({
    mutationFn: async (mode: 'save' | 'export'): Promise<SaveOutcome> => {
      const { docs, source } = draft
      const { text, lost } = await renderFile(docs)
      if (lost[0]) return { kind: 'lost', issue: lost[0] }
      if (mode === 'save' && source.kind === 'session') {
        const { sessionId, fileId } = source
        const session = await invoke('session:replaceFile', { id: sessionId, fileId, text })
        queryClient.setQueryData(['session:get', { id: session.id }], session)
        return { kind: 'session', sessionId }
      }
      const path = mode === 'save' && source.kind === 'file' ? source.path : null
      const saved = await invoke('studio:save', { text, path, suggestedName: fileNameOf(docs) })
      if (!saved) return { kind: 'cancelled' }
      return { kind: mode === 'save' ? 'saved' : 'exported', path: saved.path, docs }
    },
    onSuccess: async (outcome) => {
      if (outcome.kind === 'lost') showLost(outcome.issue)
      else if (outcome.kind === 'saved') {
        const source: StudioSource = { kind: 'file', path: outcome.path }
        setDraft((current) => ({ ...current, source, saved: JSON.stringify(outcome.docs) }))
        toast.push({ tone: 'ok', title: t('screens.studio.save.done', { file: sourceFileName(source) }) })
      } else if (outcome.kind === 'exported') {
        const file = sourceFileName({ kind: 'file', path: outcome.path })
        toast.push({ tone: 'ok', title: t('screens.studio.save.exported', { file }) })
      } else if (outcome.kind === 'session') {
        toast.push({ tone: 'ok', title: t('screens.studio.save.sessionDone') })
        await refreshSessions()
        leaveToSession(outcome.sessionId)
      }
    },
    onError: toastError,
  })

  const add = useMutation({
    mutationFn: async (session: SessionSummary): Promise<{ lost: Issue } | { session: SessionSummary }> => {
      const { text, lost } = await renderFile(draft.docs)
      if (lost[0]) return { lost: lost[0] }
      const updated = await invoke('session:addText', {
        id: session.id,
        fileName: fileNameOf(draft.docs),
        text,
      })
      queryClient.setQueryData(['session:get', { id: updated.id }], updated)
      return { session }
    },
    onSuccess: async (outcome) => {
      setPickerOpen(false)
      if ('lost' in outcome) {
        showLost(outcome.lost)
        return
      }
      const { id, name } = outcome.session
      toast.push({
        tone: 'ok',
        title: t('screens.studio.session.added', { name }),
        action: { label: t('screens.studio.session.open'), onClick: () => void navigate(`/session/${id}`) },
      })
      await refreshSessions()
    },
    onError: toastError,
  })

  const busy = save.isPending || add.isPending
  useShortcuts({
    'Ctrl+S': () => {
      if (doc && !busy) save.mutate('save')
    },
    'Ctrl+F': () => listRef.current?.focusFilter(),
  })

  // --- view ----------------------------------------------------------------------------------------

  const entryConfirm: Confirmation | null =
    entryNeedsConfirm && entry
      ? {
          title:
            entry.kind === 'file'
              ? t('screens.studio.discard.openTitle', { file: sourceFileName(entry) })
              : t('screens.studio.discard.title'),
          body: t('screens.studio.discard.body'),
          confirmLabel: t('screens.studio.discard.openConfirm'),
          onConfirm: () => setSettledEntry(entryKey),
        }
      : null
  const shownConfirm = entryConfirm ?? confirm
  const closeConfirm = (): void => {
    if (entryConfirm) clearEntry()
    else setConfirm(null)
  }

  return (
    <div className="studio">
      <ScreenHeader
        eyebrow={t('screens.studio.eyebrow')}
        title={t('nav.studio')}
        subtitle={t('screens.studio.subtitle')}
      />

      {doc && (
        <StudioToolbar
          source={draft.source}
          dirty={dirty}
          busy={busy}
          saving={save.isPending && save.variables === 'save'}
          onNew={startNew}
          onOpen={openDialog}
          onExport={() => save.mutate('export')}
          onAddToSession={() => setPickerOpen(true)}
          onSave={() => save.mutate('save')}
          onBackToSession={() => {
            const { source } = draft
            if (source.kind === 'session') discarding(() => leaveToSession(source.sessionId))
          }}
        />
      )}

      {problem && (
        <ErrorPanel
          className="studio__problem"
          title={problem.title}
          body={problem.body}
          detail={problem.detail}
          detailLabel={t('common.technicalDetails')}
          actions={
            <NeonButton variant="ghost" size="sm" onClick={() => setProblem(null)}>
              {t('screens.studio.load.dismiss')}
            </NeonButton>
          }
        />
      )}

      {load.isPending ? (
        <Spinner label={t('common.loading')} className="studio__loading" />
      ) : doc === null ? (
        <StudioStart games={games} picking={picking} onPick={requestGame} onOpen={openDialog} />
      ) : (
        <div className="studio__layout">
          <div className="studio__editor">
            {draft.docs.length > 1 && (
              <Segmented
                label={t('screens.studio.docs.label')}
                className="studio__docs"
                value={String(draft.active)}
                onChange={(index) => {
                  setActiveKey(null)
                  setDraft((current) => ({ ...current, active: Number(index), loadId: current.loadId + 1 }))
                }}
                options={draft.docs.map((entry, index) => ({
                  value: String(index),
                  label: entry.name || t('screens.studio.docs.unnamed', { n: index + 1 }),
                }))}
              />
            )}
            <PlayerPanel
              doc={doc}
              onEdit={updateDoc}
              nameIssues={nameIssues}
              games={games.data ?? []}
              onPickGame={requestGame}
              presets={schema ? Object.keys(schema.presets) : null}
              onPreset={applyPreset}
            />
            {picking !== null && <Spinner label={t('screens.studio.start.loading')} />}
            {gameInfo?.installed && gameInfo.schemaSource === 'none' && (
              <TemplateOffer
                game={game}
                hasOptions={Object.keys(doc.options).length > 0}
                onGenerated={() => void templatesGenerated(game)}
              />
            )}
            {schemaQuery.isError && (
              <ErrorPanel
                title={t('screens.studio.game.schemaError', { game })}
                body={describeError(schemaQuery.error, t).body}
                detail={schemaQuery.error.detail}
                detailLabel={t('common.technicalDetails')}
                actions={
                  <NeonButton
                    variant="secondary"
                    size="sm"
                    icon={<IconRefresh />}
                    onClick={() => void schemaQuery.refetch()}
                  >
                    {t('common.retry')}
                  </NeonButton>
                }
              />
            )}
            {schemaQuery.isFetching && !schema && <Spinner label={t('common.loading')} />}
            <OptionList
              ref={listRef}
              schema={schema}
              values={doc.options}
              issuesByKey={issuesByKey}
              onEdit={updateDoc}
              onActive={setActiveKey}
            />
          </div>
          <aside className="studio__side">
            <YamlPreview
              text={preview.text}
              pending={preview.pending}
              error={preview.error}
              game={game}
              activeKey={activeKey}
            />
            <IssueList
              issues={preview.issues}
              game={game}
              pending={preview.pending}
              checked={preview.checked}
              labelOf={labelOf}
              onReveal={reveal}
            />
          </aside>
        </div>
      )}

      <SessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(session) => add.mutate(session)}
        busyId={add.isPending ? (add.variables?.id ?? null) : null}
      />

      <Modal
        open={shownConfirm !== null}
        onClose={closeConfirm}
        closeLabel={t('common.closeDialog')}
        tone="yellow"
        size="sm"
        title={shownConfirm?.title ?? ''}
        footer={
          <>
            <NeonButton variant="ghost" onClick={closeConfirm}>
              {entryConfirm ? t('screens.studio.discard.keep') : t('common.cancel')}
            </NeonButton>
            <NeonButton
              variant="danger"
              onClick={() => {
                const action = shownConfirm?.onConfirm
                setConfirm(null)
                action?.()
              }}
            >
              {shownConfirm?.confirmLabel}
            </NeonButton>
          </>
        }
      >
        <p>{shownConfirm?.body}</p>
      </Modal>
    </div>
  )
}
