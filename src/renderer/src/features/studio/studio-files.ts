// Reading and writing the Studio's files through the main process: a YAML opened from disk
// (studio:open) or a player file of a session (session:readFile), parsed into EditorDocs
// (studio:parse); every doc rendered back into one file (studio:render, documents joined by `---`,
// as the session wizard's rename does).
import type { EditorDoc, Issue } from '@shared/types'
import { invoke } from '../../lib/goat'
import type { StudioSource } from './studio-draft'

/** Where the Studio was asked to load from: `?open=<path>`, `?session=<id>&file=<fileId>`, a dialog. */
export type EntryRequest =
  { kind: 'file'; path: string } | { kind: 'session'; sessionId: string; fileId: string } | { kind: 'dialog' }

export interface LoadedFile {
  source: StudioSource
  docs: EditorDoc[]
  /** Why no doc could be read (yaml-syntax…), when `docs` is empty. */
  issues: Issue[]
}

/** The issues that mean a raw value was left out of the rendered text. */
const LOST_VALUE: ReadonlySet<Issue['code']> = new Set(['yaml-syntax', 'duplicate-key'])

/** The file of a request, parsed; null when the open dialog was cancelled. */
export async function loadFile(request: EntryRequest): Promise<LoadedFile | null> {
  let source: StudioSource
  let text: string
  if (request.kind === 'session') {
    ;({ text } = await invoke('session:readFile', { id: request.sessionId, fileId: request.fileId }))
    source = { kind: 'session', sessionId: request.sessionId, fileId: request.fileId }
  } else {
    const opened = await invoke('studio:open', request.kind === 'file' ? { path: request.path } : {})
    if (!opened) return null
    text = opened.text
    source = { kind: 'file', path: opened.path }
  }
  const { docs, issues } = await invoke('studio:parse', { text })
  return { source, docs, issues }
}

/** Every doc rendered, as one file; `lost` lists the raw values that are not valid YAML. */
export async function renderFile(docs: EditorDoc[]): Promise<{ text: string; lost: Issue[] }> {
  const parts = await Promise.all(docs.map((doc) => invoke('studio:render', { doc })))
  return {
    text: parts.map((part) => part.text).join('\n---\n'),
    lost: parts.flatMap((part) => part.issues.filter((issue) => LOST_VALUE.has(issue.code))),
  }
}

/**
 * A doc whose game is a random pick among several (`game` a mapping, kept in extraRoot with each
 * game's section), as a doc of `game` alone: written with that game, then read again, so its section
 * comes back as options exactly as when a file is opened. Null when the doc holds no readable section
 * for that game.
 */
export async function withSingleGame(doc: EditorDoc, game: string): Promise<EditorDoc | null> {
  if (!Object.hasOwn(doc.extraRoot, game)) return null
  const single: EditorDoc = {
    ...doc,
    game: '',
    extraRoot: { ...doc.extraRoot, game: { mode: 'value', value: game } },
  }
  const { text, issues } = await invoke('studio:render', { doc: single })
  // A section the writer had to leave out cannot be read back.
  if (issues.some((issue) => LOST_VALUE.has(issue.code))) return null
  const { docs } = await invoke('studio:parse', { text })
  const [read] = docs
  return docs.length === 1 && read?.game === game ? read : null
}
