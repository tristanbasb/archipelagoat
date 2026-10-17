// The games joined lately, newest first, kept in this machine's localStorage. Never a password: an
// archipelago:// link is stored without it. Storage can fail (private mode, quota, corrupt data):
// the history then simply starts empty and lives in memory.
import { useCallback, useState } from 'react'
import type { JoinTarget } from '@shared/types'

export interface RoomHistoryEntry {
  /** What to resolve again: the room link, the address (without password) or the patch path. */
  input: string
  kind: JoinTarget['kind']
  /** Room id, host:port or patch file name. */
  label: string
  slot: string | null
  game: string | null
  /** ISO date of the last join. */
  at: string
}

export const HISTORY_KEY = 'archipelagoat.join.history'
const MAX_ENTRIES = 8
const KINDS: readonly string[] = ['room', 'address', 'patch'] satisfies JoinTarget['kind'][]

const isText = (x: unknown): x is string => typeof x === 'string'
const isTextOrNull = (x: unknown): x is string | null => x === null || typeof x === 'string'

function isEntry(x: unknown): x is RoomHistoryEntry {
  if (typeof x !== 'object' || x === null) return false
  const entry = x as Record<string, unknown>
  return (
    isText(entry.input) &&
    entry.input.length > 0 &&
    isText(entry.kind) &&
    KINDS.includes(entry.kind) &&
    isText(entry.label) &&
    isTextOrNull(entry.slot) &&
    isTextOrNull(entry.game) &&
    isText(entry.at)
  )
}

export function loadHistory(): RoomHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX_ENTRIES) : []
  } catch {
    return []
  }
}

function saveHistory(entries: RoomHistoryEntry[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries))
  } catch {
    // Storage refused (private mode, quota): the history stays in memory for this session.
  }
}

/**
 * `archipelago://slot:password@host:port` without its password; any other input is unchanged. As in a
 * URL, the host starts after the last @ of the address, so a password may hold one.
 */
export function withoutPassword(input: string): string {
  return input.replace(/^(archipelago:\/\/[^:@/?#]*):[^/?#]*@/i, '$1@')
}

/** The label of a target in the history: room id, host:port or patch file name. */
export function targetLabel(target: JoinTarget): string {
  if (target.kind === 'room') return target.roomId
  if (target.kind === 'address') return `${target.host}:${target.port}`
  return target.path.split(/[\\/]/).pop() ?? target.path
}

/** One entry per room, server or patch file, however its link was written. */
const sameTarget = (
  a: Pick<RoomHistoryEntry, 'kind' | 'label'>,
  b: Pick<RoomHistoryEntry, 'kind' | 'label'>,
) => a.kind === b.kind && a.label === b.label

export interface RoomHistory {
  entries: RoomHistoryEntry[]
  /** Puts the entry first; a slot or game it lacks is kept from the previous visit. */
  remember: (entry: Omit<RoomHistoryEntry, 'at'>) => void
  forget: (entry: RoomHistoryEntry) => void
}

export function useRoomHistory(): RoomHistory {
  const [entries, setEntries] = useState(loadHistory)

  const update = useCallback((change: (entries: RoomHistoryEntry[]) => RoomHistoryEntry[]) => {
    setEntries((current) => {
      const next = change(current).slice(0, MAX_ENTRIES)
      saveHistory(next)
      return next
    })
  }, [])

  const remember = useCallback(
    (entry: Omit<RoomHistoryEntry, 'at'>) => {
      const at = new Date().toISOString()
      update((current) => {
        const previous = current.find((other) => sameTarget(other, entry))
        const next: RoomHistoryEntry = {
          ...entry,
          input: withoutPassword(entry.input),
          slot: entry.slot ?? previous?.slot ?? null,
          game: entry.game ?? previous?.game ?? null,
          at,
        }
        return [next, ...current.filter((other) => !sameTarget(other, entry))]
      })
    },
    [update],
  )

  const forget = useCallback(
    (entry: RoomHistoryEntry) => update((current) => current.filter((other) => !sameTarget(other, entry))),
    [update],
  )

  return { entries, remember, forget }
}
