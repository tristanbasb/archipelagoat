// The organizer's games (spec §3.13): one folder per session (workspace.ts), its state in
// `session.json`, its passwords in the SecretStore (`session.<id>.password` / `.serverPassword`),
// never in that file. Player files are copied into `players/` as UTF-8 YAML under safe names, in
// Archipelago's order, and validated as they arrive. Changes to one session run one at a time.
import { randomBytes, randomInt } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CoreContext } from '@main/core/context'
import { moveFileToBackups, safeJoin, writeFileAtomic } from '@main/core/system/fsx'
import { assertUserPath } from '@main/core/system/user-path'
import type { ValidationContext } from '@main/core/yaml/validate'
import { ISSUE_CODES } from '@shared/codes'
import { AppError } from '@shared/errors'
import { RulesSchema } from '@shared/ipc/session'
import { defaultRules } from '@shared/rules'
import type {
  Generation,
  Hosting,
  Issue,
  PlayerFile,
  Rules,
  Session,
  SessionStatus,
  SessionSummary,
} from '@shared/types'
import type { SessionSecrets } from './rules'
import { validatePlayerFiles } from './validate-session'
import {
  createWorkspace,
  importPlayerSources,
  moveWorkspaceToBackups,
  SESSION_ID_RE,
  sessionsRoot,
  storedNameFor,
  workspacePaths,
  type ImportedFile,
  type WorkspacePaths,
} from './workspace'

export interface SessionStoreDeps {
  /** The context to validate player files rolling `games`, with the session's plando modules. */
  validationContext(games: string[], plandoEnabled: readonly string[]): Promise<ValidationContext>
  /** Default: the current time. */
  now?: () => Date
  /** True while session `id` is in use (its local server runs): `delete` then answers AP_RUNNING. */
  isBusy?: (id: string) => boolean
}

/** A player file with its text and what its import found: what the validation reads. */
export interface PlayerSource {
  file: PlayerFile
  text: string
  importIssues: Issue[]
}

export interface SessionStore {
  /** Every readable session, most recently updated first. */
  list(): Promise<SessionSummary[]>
  /** INVALID_INPUT for a blank name. */
  create(name: string): Promise<Session>
  /** NOT_FOUND for an unknown id, a malformed one, or a session.json that cannot be read. */
  get(id: string): Promise<Session>
  update(id: string, patch: { name?: string; rules?: Rules }): Promise<Session>
  /** Moves the folder to `dataRoot/backups` and forgets the passwords; AP_RUNNING while it is busy. */
  delete(id: string): Promise<void>
  /**
   * Imports the player files of `paths` (YAML, YAML .txt, zips of them). Every path goes through
   * `assertUserPath` first: nothing is imported when one is refused. `ignored` lists what was not a
   * player file (see `importPlayerSources`), each path as given.
   */
  addFiles(id: string, paths: readonly string[]): Promise<{ session: Session; ignored: string[] }>
  /** Adds a player file from its text; `fileName` gives its name. */
  addText(id: string, fileName: string, text: string): Promise<Session>
  /**
   * Takes the file out of the session: it leaves `players/` (Generate no longer sees it) for
   * `dataRoot/backups/<stamp>-player/<id>/`, never deleted for good (spec §5).
   */
  removeFile(id: string, fileId: string): Promise<Session>
  readFile(id: string, fileId: string): Promise<{ text: string }>
  /** Writes `text` over the file (same stored name) and validates it again. */
  replaceFile(id: string, fileId: string, text: string): Promise<Session>
  /** `undefined` keeps a password; null or '' removes it. SECRETS_UNAVAILABLE without a keyring. */
  setSecrets(id: string, secrets: { password?: string | null; serverPassword?: string | null }): Promise<void>
  getSecrets(id: string): Promise<SessionSecrets>
  /** Sets the generation; the status follows (`generated`, or `draft` for null). */
  setGeneration(id: string, generation: Generation | null): Promise<Session>
  /** Sets the hosting; the status follows (`hosting`, or back to `generated` / `draft` for null). */
  setHosting(id: string, hosting: Hosting | null): Promise<Session>
  /**
   * The local server of the session stopped or crashed: the game is `finished`, its hosting (and the
   * save it names) kept for a restart. Nothing changes for a web room, which lives on the site.
   */
  setFinished(id: string): Promise<Session>
  /** The session with the text of each player file, in its order: for the validation. */
  loadPlayers(id: string): Promise<{ session: Session; files: PlayerSource[] }>
}

const STORE_VERSION = 1
const FILE_ID_RE = /^f_[0-9a-f]+$/
const STORED_NAME_RE = /^[A-Za-z0-9 _.-]+\.yaml$/
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

const IssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.enum(ISSUE_CODES),
  path: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
const PlayerDocSchema = z.object({
  index: z.number().int(),
  name: z.string().nullable(),
  games: z.array(z.object({ game: z.string(), weight: z.number() })),
  issues: z.array(IssueSchema),
})
const StoredPlayerFileSchema = z.object({
  id: z.string().regex(FILE_ID_RE),
  originalName: z.string(),
  storedName: z.string().regex(STORED_NAME_RE),
  docs: z.array(PlayerDocSchema),
  addedAt: z.string(),
  importIssues: z.array(IssueSchema),
})
const GenerationSchema = z.object({
  seedName: z.string(),
  zipPath: z.string(),
  spoilerName: z.string().nullable(),
  slots: z.array(
    z.object({
      slot: z.number().int(),
      name: z.string(),
      game: z.string(),
      patchFile: z.string().nullable(),
    }),
  ),
  durationS: z.number(),
  logPath: z.string(),
})
const HostingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local'), port: z.number().int(), savefile: z.string() }),
  z.object({
    mode: z.literal('web'),
    seedId: z.string(),
    roomId: z.string(),
    roomUrl: z.string(),
    port: z.number().int().nullable(),
    seedName: z.string().optional(),
  }),
])
const StoredSessionSchema = z.object({
  version: z.literal(STORE_VERSION),
  id: z.string().regex(SESSION_ID_RE),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['draft', 'generated', 'hosting', 'finished']),
  players: z.array(StoredPlayerFileSchema),
  rules: RulesSchema,
  generation: GenerationSchema.nullable(),
  hosting: HostingSchema.nullable(),
})

type StoredSession = z.infer<typeof StoredSessionSchema>
type StoredPlayerFile = StoredSession['players'][number]

const notFound = (detail: string): AppError => new AppError('NOT_FOUND', undefined, { detail })

const secretKey = (id: string, which: keyof SessionSecrets): string => `session.${id}.${which}`

const casefold = (name: string): string => name.toLowerCase()

/** Archipelago's order: Generate sorts the file names with casefold (Generate.py:158). */
const byStoredName = (a: StoredPlayerFile, b: StoredPlayerFile): number => {
  const [x, y] = [casefold(a.storedName), casefold(b.storedName)]
  return x < y ? -1 : x > y ? 1 : 0
}

const statusOf = (stored: StoredSession): SessionStatus =>
  stored.hosting ? 'hosting' : stored.generation ? 'generated' : 'draft'

function trimmedName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new AppError('INVALID_INPUT', undefined, { detail: 'blank session name' })
  return trimmed
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const BOM = String.fromCharCode(0xfeff)
/** UTF-8 without BOM, what Archipelago reads (it would accept one, other tools may not). */
const withoutBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text)

function publicFile(file: StoredPlayerFile): PlayerFile {
  const { id, originalName, storedName, docs, addedAt } = file
  return { id, originalName, storedName, docs, addedAt }
}

export function createSessionStore(ctx: CoreContext, deps: SessionStoreDeps): SessionStore {
  const { dataRoot } = ctx.platform.paths
  const backupsRoot = path.join(dataRoot, 'backups')
  const now = deps.now ?? ((): Date => new Date())
  const locks = new Map<string, Promise<unknown>>()

  /** Runs `fn` once every earlier change of session `id` has settled. */
  function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => undefined)
    locks.set(id, tail)
    void tail.then(() => {
      if (locks.get(id) === tail) locks.delete(id)
    })
    return run
  }

  async function read(id: string): Promise<{ ws: WorkspacePaths; stored: StoredSession }> {
    const ws = workspacePaths(dataRoot, id)
    let text: string
    try {
      text = await readFile(ws.sessionFile, 'utf8')
    } catch (error) {
      if (isMissing(error)) throw notFound(`session ${id}`)
      throw error
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw notFound(`session ${id}: unreadable session.json`)
    }
    const parsed = StoredSessionSchema.safeParse(json)
    if (!parsed.success || parsed.data.id !== id) throw notFound(`session ${id}: unreadable session.json`)
    return { ws, stored: parsed.data }
  }

  function toSession(stored: StoredSession, ws: WorkspacePaths): Session {
    return {
      id: stored.id,
      name: stored.name,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      status: stored.status,
      players: stored.players.map(publicFile),
      rules: stored.rules,
      hasPassword: ctx.secrets.has(secretKey(stored.id, 'password')),
      hasServerPassword: ctx.secrets.has(secretKey(stored.id, 'serverPassword')),
      generation: stored.generation,
      hosting: stored.hosting,
      workspace: ws.dir,
    }
  }

  async function save(ws: WorkspacePaths, stored: StoredSession): Promise<Session> {
    const next: StoredSession = { ...stored, updatedAt: now().toISOString() }
    await writeFileAtomic(ws.sessionFile, `${JSON.stringify(next, null, 2)}\n`)
    return toSession(next, ws)
  }

  /** Reads session `id`, lets `change` edit it, then saves it, all as one exclusive change. */
  function modify(
    id: string,
    change: (stored: StoredSession, ws: WorkspacePaths) => Promise<StoredSession> | StoredSession,
  ): Promise<Session> {
    return exclusive(id, async () => {
      const { ws, stored } = await read(id)
      return save(ws, await change(stored, ws))
    })
  }

  function findFile(stored: StoredSession, fileId: string): StoredPlayerFile {
    const file = stored.players.find((f) => f.id === fileId)
    if (!file) throw notFound(`player file ${fileId}`)
    return file
  }

  const playerPath = (ws: WorkspacePaths, file: { storedName: string }): string =>
    safeJoin(ws.players, file.storedName)

  async function readPlayerText(ws: WorkspacePaths, file: StoredPlayerFile): Promise<string> {
    try {
      return await readFile(playerPath(ws, file), 'utf8')
    } catch (error) {
      if (isMissing(error)) throw notFound(`player file ${file.id}: ${file.storedName}`)
      throw error
    }
  }

  const validationContext = (stored: StoredSession) => (games: string[]) =>
    deps.validationContext(games, stored.rules.plando)

  /** Writes the files in `players/` and adds them; whatever was written is removed on failure. */
  async function addPlayerFiles(
    ws: WorkspacePaths,
    stored: StoredSession,
    incoming: readonly ImportedFile[],
  ): Promise<Session> {
    const names = stored.players.map((file) => file.storedName)
    const named = incoming.map((file) => {
      const storedName = storedNameFor(file.originalName, names)
      names.push(storedName)
      // Written as UTF-8, what Archipelago reads (`utf-8-sig`), whatever the source was.
      return { ...file, storedName, text: withoutBom(file.text) }
    })
    const { docs } = await validatePlayerFiles(
      named.map((file) => ({ text: file.text, storedName: file.storedName, importIssues: file.issues })),
      validationContext(stored),
    )
    const addedAt = now().toISOString()
    const added: StoredPlayerFile[] = named.map((file, i) => ({
      id: `f_${randomBytes(6).toString('hex')}`,
      originalName: file.originalName,
      storedName: file.storedName,
      docs: docs[i] ?? [],
      addedAt,
      importIssues: file.issues,
    }))
    const written: string[] = []
    try {
      for (const file of named) {
        const target = playerPath(ws, file)
        await writeFileAtomic(target, file.text)
        written.push(target)
      }
      return await save(ws, { ...stored, players: [...stored.players, ...added].sort(byStoredName) })
    } catch (error) {
      // A file left in players/ would be a player of the generation.
      await Promise.all(written.map((file) => rm(file, { force: true }).catch(() => undefined)))
      throw error
    }
  }

  function newId(at: Date): string {
    const suffix = Array.from({ length: 4 }, () => BASE36[randomInt(36)]).join('')
    return `s_${at.getTime().toString(36)}${suffix}`
  }

  return {
    async list() {
      const names = await readdir(sessionsRoot(dataRoot)).catch((error: unknown) => {
        if (isMissing(error)) return [] as string[]
        throw error
      })
      const summaries: SessionSummary[] = []
      for (const name of names.filter((n) => SESSION_ID_RE.test(n))) {
        try {
          const { stored } = await read(name)
          summaries.push({
            id: stored.id,
            name: stored.name,
            status: stored.status,
            playerCount: stored.players.reduce((sum, file) => sum + file.docs.length, 0),
            updatedAt: stored.updatedAt,
            hostingMode: stored.hosting?.mode ?? null,
          })
        } catch (error) {
          ctx.log.warn('sessions: skipping an unreadable session', { id: name, error: String(error) })
        }
      }
      return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    },

    async create(name) {
      const trimmed = trimmedName(name)
      const at = now()
      for (;;) {
        const id = newId(at)
        const ws = workspacePaths(dataRoot, id)
        try {
          await createWorkspace(ws)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw error
        }
        const stored: StoredSession = {
          version: STORE_VERSION,
          id,
          name: trimmed,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
          status: 'draft',
          players: [],
          rules: defaultRules(),
          generation: null,
          hosting: null,
        }
        await writeFileAtomic(ws.sessionFile, `${JSON.stringify(stored, null, 2)}\n`)
        return toSession(stored, ws)
      }
    },

    async get(id) {
      const { ws, stored } = await read(id)
      return toSession(stored, ws)
    },

    update(id, patch) {
      return exclusive(id, async () => {
        const { ws, stored } = await read(id)
        if (patch.name === undefined && patch.rules === undefined) return toSession(stored, ws)
        return save(ws, {
          ...stored,
          ...(patch.name === undefined ? {} : { name: trimmedName(patch.name) }),
          ...(patch.rules === undefined ? {} : { rules: structuredClone(patch.rules) }),
        })
      })
    },

    delete(id) {
      return exclusive(id, async () => {
        const { ws } = await read(id)
        if (deps.isBusy?.(id))
          throw new AppError('AP_RUNNING', undefined, { detail: `session ${id} is in use` })
        await moveWorkspaceToBackups(ws.dir, backupsRoot)
        ctx.secrets.set(secretKey(id, 'password'), null)
        ctx.secrets.set(secretKey(id, 'serverPassword'), null)
      })
    },

    addFiles(id, paths) {
      return exclusive(id, async () => {
        const { ws, stored } = await read(id)
        const checked = await Promise.all(paths.map((p) => assertUserPath(p, { kind: 'file' })))
        const given = new Map(checked.map((p, i) => [p, paths[i] ?? p]))
        const { files, ignored } = await importPlayerSources([...new Set(checked)])
        const session = files.length > 0 ? await addPlayerFiles(ws, stored, files) : toSession(stored, ws)
        return { session, ignored: ignored.map((p) => given.get(p) ?? p) }
      })
    },

    addText(id, fileName, text) {
      return exclusive(id, async () => {
        const { ws, stored } = await read(id)
        const originalName = fileName.split(/[\\/]/).pop() ?? fileName
        return addPlayerFiles(ws, stored, [{ originalName, text, issues: [] }])
      })
    },

    removeFile(id, fileId) {
      return modify(id, async (stored, ws) => {
        const file = findFile(stored, fileId)
        const source = playerPath(ws, file)
        try {
          await moveFileToBackups(source, backupsRoot, 'player', id)
        } catch (error) {
          // Already gone from players/: there is nothing left to keep.
          if (!isMissing(error)) throw error
        }
        return { ...stored, players: stored.players.filter((f) => f.id !== fileId) }
      })
    },

    async readFile(id, fileId) {
      const { ws, stored } = await read(id)
      return { text: await readPlayerText(ws, findFile(stored, fileId)) }
    },

    replaceFile(id, fileId, text) {
      return modify(id, async (stored, ws) => {
        const file = findFile(stored, fileId)
        const clean = withoutBom(text)
        const { docs } = await validatePlayerFiles(
          [{ text: clean, storedName: file.storedName, importIssues: [] }],
          validationContext(stored),
        )
        await writeFileAtomic(playerPath(ws, file), clean)
        const replaced: StoredPlayerFile = { ...file, docs: docs[0] ?? [], importIssues: [] }
        return { ...stored, players: stored.players.map((f) => (f.id === fileId ? replaced : f)) }
      })
    },

    async setSecrets(id, secrets) {
      await modify(id, (stored) => {
        for (const which of ['password', 'serverPassword'] as const) {
          const value = secrets[which]
          if (value !== undefined) ctx.secrets.set(secretKey(id, which), value === '' ? null : value)
        }
        return stored
      })
    },

    async getSecrets(id) {
      await read(id)
      return {
        password: ctx.secrets.get(secretKey(id, 'password')),
        serverPassword: ctx.secrets.get(secretKey(id, 'serverPassword')),
      }
    },

    setGeneration(id, generation) {
      return modify(id, (stored) => {
        const next = { ...stored, generation }
        return { ...next, status: statusOf(next) }
      })
    },

    setHosting(id, hosting) {
      return modify(id, (stored) => {
        const next = { ...stored, hosting }
        return { ...next, status: statusOf(next) }
      })
    },

    setFinished(id) {
      return modify(id, (stored) =>
        stored.hosting?.mode === 'local' ? { ...stored, status: 'finished' } : stored,
      )
    },

    async loadPlayers(id) {
      const { ws, stored } = await read(id)
      const files = await Promise.all(
        stored.players.map(async (file) => ({
          file: publicFile(file),
          text: await readPlayerText(ws, file),
          importIssues: file.importIssues,
        })),
      )
      return { session: toSession(stored, ws), files }
    },
  }
}
