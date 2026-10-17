// The live YAML of the doc on screen and its validation. Both go through the main process
// (studio:render, then studio:validate on the rendered text), and validation rescans the installed
// worlds: they run once the user pauses, not on every keystroke.
import { keepPreviousData } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { GoatError } from '@shared/errors'
import type { EditorDoc, Issue } from '@shared/types'
import { useIpcQuery } from '../../hooks/useIpc'
import { suggestedFileName } from './editor-ops'

/** The pause after the last change before the preview and the validation run again. */
export const LIVE_DELAY_MS = 400

const NO_DOC: EditorDoc = {
  name: '',
  description: '',
  game: '',
  requiresVersion: null,
  options: {},
  extraRoot: {},
}
const NO_ISSUES: Issue[] = []

/**
 * `value` once it has stayed the same for `delay` ms. When `key` changes (other docs loaded), the
 * new value settles at once, and the changes that follow wait for a pause again.
 */
export function useDebounced<T>(value: T, delay: number, key: unknown): T {
  const [settled, setSettled] = useState({ value, key })
  let current = settled
  if (!Object.is(settled.key, key)) {
    // Settled during this render (React's "state from the previous render" pattern), not after the
    // delay: the edits right after a load must not reach the main process one by one.
    current = { value, key }
    setSettled(current)
  }
  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        setSettled((previous) =>
          Object.is(previous.value, value) && Object.is(previous.key, key) ? previous : { value, key },
        ),
      delay,
    )
    return () => window.clearTimeout(timer)
  }, [value, key, delay])
  return current.value
}

export interface LivePreview {
  /** The rendered YAML; undefined until the first render. */
  text: string | undefined
  /** Problems of the raw values (render) and of the file (validation). */
  issues: Issue[]
  /** A newer change is on its way. */
  pending: boolean
  /** The preview could not be computed. */
  error: GoatError | null
  /** True once the shown issues come from a finished validation. */
  checked: boolean
}

/**
 * The rendered text of the settled doc, validated under the file name that doc would be saved as.
 * Everything here follows the settled doc only: typing a name waits for the pause like the rest.
 */
export function useLivePreview(doc: EditorDoc | null, loadId: number): LivePreview {
  const settled = useDebounced(doc, LIVE_DELAY_MS, loadId)
  const render = useIpcQuery(
    'studio:render',
    { doc: settled ?? NO_DOC },
    { enabled: settled !== null, placeholderData: keepPreviousData },
  )
  const text = settled === null ? undefined : render.data?.text
  // The text of the previous doc, still shown while the new one renders, is not checked again.
  const fresh = text !== undefined && !render.isPlaceholderData
  const validation = useIpcQuery(
    'studio:validate',
    { text: fresh ? text : '', fileName: settled ? suggestedFileName(settled) : 'Player.yaml' },
    { enabled: fresh, placeholderData: keepPreviousData },
  )
  const renderIssues = render.data?.issues
  const fileIssues = validation.data?.[0]?.issues
  const issues = useMemo(
    () =>
      renderIssues || fileIssues ? [...(renderIssues ?? NO_ISSUES), ...(fileIssues ?? NO_ISSUES)] : NO_ISSUES,
    [renderIssues, fileIssues],
  )
  return {
    text,
    issues: settled === null ? NO_ISSUES : issues,
    pending: settled !== doc || render.isFetching || validation.isFetching,
    error: render.error ?? validation.error ?? null,
    checked: validation.data !== undefined,
  }
}
