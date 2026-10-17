// Where a file dropped on the window, or opened from the system, should go.

export type DropIntent = 'world-install' | 'session-import' | 'join-patch' | 'studio-open' | 'ask'

export interface DropRoute {
  /** The route to open; empty for `ask`, which waits for the user's choice. */
  to: string
  intent: DropIntent
}

export interface DropContext {
  /** The session open in the wizard (/session/:id), which a YAML is imported into. */
  activeSessionId?: string | null
}

/** Patch files are named after their world's `patch_file_ending`, which always starts with `.ap`. */
const PATCH_SUFFIX = /\.ap[a-z0-9]+$/i

function extension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** The route for a file path (or name); null when the app has nothing to do with that file. */
export function routeDroppedFile(path: string, context: DropContext = {}): DropRoute | null {
  const ext = extension(path)
  const encoded = encodeURIComponent(path)
  if (ext === '.apworld') return { to: `/worlds?install=${encoded}`, intent: 'world-install' }
  if (ext === '.yaml' || ext === '.yml') {
    return context.activeSessionId
      ? { to: `/session/${context.activeSessionId}`, intent: 'session-import' }
      : { to: `/studio?open=${encoded}`, intent: 'studio-open' }
  }
  if (PATCH_SUFFIX.test(ext)) return { to: `/join?input=${encoded}`, intent: 'join-patch' }
  // A slot file (Factorio, Kingdom Hearts…) or a bundle of player files: only the user knows.
  if (ext === '.zip') return { to: '', intent: 'ask' }
  return null
}
