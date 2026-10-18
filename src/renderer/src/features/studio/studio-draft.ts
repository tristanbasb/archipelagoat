// What the Studio is editing, kept while the user visits other screens (installing a world, checking
// a game) so that coming back to /studio finds the YAML as it was left. It lives as long as the
// bridge it was made with: a new window.goat (a reload, a test) starts empty.
import type { EditorDoc } from '@shared/types'

export type StudioSource =
  { kind: 'new' } | { kind: 'file'; path: string } | { kind: 'session'; sessionId: string; fileId: string }

export interface Draft {
  source: StudioSource
  /** The players of the file, one EditorDoc per document (most files hold one). */
  docs: EditorDoc[]
  /** The doc on screen. */
  active: number
  /** The docs as last loaded or saved (JSON), what "not saved" compares to. */
  saved: string
  /** Changes when other docs are loaded: the preview then renders without waiting for a pause. */
  loadId: number
}

export const EMPTY_DRAFT: Draft = { source: { kind: 'new' }, docs: [], active: 0, saved: '[]', loadId: 0 }

let kept: { goat: unknown; draft: Draft } | null = null

/** The draft the Studio left, or an empty one. */
export function keptDraft(): Draft {
  return kept?.goat === window.goat ? kept.draft : EMPTY_DRAFT
}

export function keepDraft(draft: Draft): void {
  kept = { goat: window.goat, draft }
}

/** A draft holding freshly loaded docs. */
export function loadedDraft(previous: Draft, source: StudioSource, docs: EditorDoc[]): Draft {
  return { source, docs, active: 0, saved: JSON.stringify(docs), loadId: previous.loadId + 1 }
}

/**
 * A draft holding docs made elsewhere that exist nowhere on disk (a « Jeu prêt » YAML): a new file,
 * unsaved from the start, so that nothing replaces it without asking (Ruling 29).
 */
export function deliveredDraft(previous: Draft, docs: EditorDoc[]): Draft {
  return { ...loadedDraft(previous, { kind: 'new' }, docs), saved: EMPTY_DRAFT.saved }
}

export const isDirty = (draft: Draft): boolean => JSON.stringify(draft.docs) !== draft.saved

/** The file name a source is known by, for the toolbar and the confirmations. */
export function sourceFileName(source: StudioSource): string | null {
  return source.kind === 'file' ? (source.path.split(/[\\/]/).pop() ?? source.path) : null
}
