// What stands between a session and its generation (spec §3.13): each player file checked as
// Archipelago would read it (Task 13's rules) against the worlds it loads, names repeated across files,
// the worlds to install and the ROMs Archipelago asks for while it generates. `blocking` says the
// generation would fail. The validation context is shared with the YAML Studio.
import type { Locator } from '@main/core/ap/locator'
import type { ApSettings, SettingsPath } from '@main/core/ap/settings'
import type { Templates } from '@main/core/ap/templates'
import type { Logger } from '@main/core/logger'
import type { Vault } from '@main/core/play/roms'
import type { Catalog } from '@main/core/worlds/catalog'
import { loadYaml11 } from '@main/core/yaml/load'
import {
  gamesIn,
  validateLoadedYaml,
  validateSessionNames,
  type ValidationContext,
} from '@main/core/yaml/validate'
import { ROM_TABLE } from '@shared/data/rom-table'
import type {
  CatalogEntry,
  GameSchema,
  Issue,
  PlayerDoc,
  RomNeed,
  RomTableEntry,
  SessionValidation,
} from '@shared/types'
import type { SessionStore } from './store'

export interface ValidationContextDeps {
  locator: Pick<Locator, 'detect'>
  /**
   * Game → version of the world Archipelago loads for it, and the loaded custom worlds whose game
   * nothing tells (the worlds service caches both).
   */
  worlds: {
    installedGames(): Promise<ValidationContext['installedGames']>
    unknownWorlds?(): Promise<string[]>
  }
  templates: Pick<Templates, 'getSchema'>
  settings: Pick<ApSettings, 'get'>
  log: Pick<Logger, 'debug'>
}

/** generator.plando_options when the settings file has none (settings.py, GeneratorOptions). */
const DEFAULT_PLANDO = 'bosses, connections, texts'

const plandoModules = (text: string): string[] =>
  text
    .split(',')
    .map((module) => module.trim().toLowerCase())
    .filter((module) => module !== '')

/**
 * The context to validate player files that roll `games`: the installed worlds and Archipelago
 * version, the schemas of the installed games among `games`, `allow_quantity` from the settings, and
 * the plando modules: `plandoEnabled` when given (a session's rules), else the settings'.
 */
export async function buildValidationContext(
  deps: ValidationContextDeps,
  games: readonly string[],
  plandoEnabled: readonly string[] | null,
): Promise<ValidationContext> {
  const install = await deps.locator.detect()
  const installed = await deps.worlds.installedGames()
  const unknownWorlds = install ? ((await deps.worlds.unknownWorlds?.()) ?? []) : []
  const schemas = new Map<string, GameSchema>()
  await Promise.all(
    games
      .filter((game) => installed.has(game))
      .map(async (game) => {
        try {
          schemas.set(game, await deps.templates.getSchema(game))
        } catch (error) {
          deps.log.debug('validation: no schema', { game, error: String(error) })
        }
      }),
  )
  const setting = (path: SettingsPath): Promise<unknown> => deps.settings.get(path).catch(() => undefined)
  const [allowQuantity, plando] = install
    ? await Promise.all([setting(['generator', 'allow_quantity']), setting(['generator', 'plando_options'])])
    : [false, DEFAULT_PLANDO]
  return {
    installedGames: installed,
    apVersion: install?.version ?? '',
    schemaFor: (game) => schemas.get(game),
    allowQuantity: allowQuantity === true || allowQuantity === 1,
    plandoEnabled: plandoEnabled
      ? plandoEnabled.map((module) => module.toLowerCase())
      : plandoModules(typeof plando === 'string' ? plando : DEFAULT_PLANDO),
    unknownWorlds,
  }
}

export interface PlayerText {
  text: string
  /** The name in `players/`: a document without `name:` is called after it. */
  storedName: string
  /** What the import found (`encoding-fallback`), shown on the file's first document. */
  importIssues: Issue[]
}

function withImportIssues(docs: PlayerDoc[], importIssues: Issue[]): PlayerDoc[] {
  const [first, ...rest] = docs
  if (!first || importIssues.length === 0) return docs
  return [{ ...first, issues: [...importIssues, ...first.issues] }, ...rest]
}

/**
 * The PlayerDocs of each file, validated against one context built (by `context`) for the games
 * they roll; the context is returned too.
 */
export async function validatePlayerFiles(
  files: readonly PlayerText[],
  context: (games: string[]) => Promise<ValidationContext>,
): Promise<{ docs: PlayerDoc[][]; context: ValidationContext }> {
  const loaded = files.map((file) => loadYaml11(file.text))
  const games = new Set(loaded.flatMap((yaml) => (yaml.issues.length > 0 ? [] : gamesIn(yaml.docs))))
  const ctx = await context([...games])
  const docs = files.map((file, i) =>
    withImportIssues(
      validateLoadedYaml(loaded[i] ?? { docs: [], issues: [] }, file.storedName, ctx),
      file.importIssues,
    ),
  )
  return { docs, context: ctx }
}

export interface RomNeedDeps {
  vault: Pick<Vault, 'resolveRomForEntry'>
  /** Default: ROM_TABLE. */
  table?: readonly RomTableEntry[]
}

/**
 * The ROMs Archipelago asks for while it generates (`requiredAtGeneration`) for the games of
 * `games`, each resolved by the vault: the effective settings key when its file is right, else a
 * verified vault ROM. `path` is what the session host.yaml gets when the status is `ok`.
 */
export async function resolveRomNeeds(games: readonly string[], deps: RomNeedDeps): Promise<RomNeed[]> {
  const wanted = new Set(games)
  const needs: RomNeed[] = []
  for (const entry of deps.table ?? ROM_TABLE) {
    if (!entry.requiredAtGeneration || !wanted.has(entry.game)) continue
    const { status, path, vaultPath } = await deps.vault.resolveRomForEntry(entry)
    needs.push({ game: entry.game, settingsKey: entry.settingsKey, status, path, vaultPath })
  }
  return needs
}

export interface SessionValidatorDeps extends ValidationContextDeps, RomNeedDeps {
  catalog: Pick<Catalog, 'lookupByGame'>
}

export interface SessionValidator {
  validateSession(id: string): Promise<SessionValidation>
}

/** The catalog id to install a world from, when the catalog has something to download for it. */
const installableId = (entry: CatalogEntry | null): string | null => (entry?.latest ? entry.id : null)

export function createSessionValidator(
  store: Pick<SessionStore, 'loadPlayers'>,
  deps: SessionValidatorDeps,
): SessionValidator {
  return {
    async validateSession(id) {
      const { session, files } = await store.loadPlayers(id)
      const { docs, context } = await validatePlayerFiles(
        files.map(({ file, text, importIssues }) => ({ text, storedName: file.storedName, importIssues })),
        (games) => buildValidationContext(deps, games, session.rules.plando),
      )
      const checked = files.map(({ file }, i) => ({ ...file, docs: docs[i] ?? [] }))
      const sessionIssues = validateSessionNames(checked)
      const allDocs = checked.flatMap((file) => file.docs)
      const games = [...new Set(allDocs.flatMap((doc) => doc.games.map((g) => g.game)))]
      // A world whose game nothing tells may provide it: Archipelago decides (game-unconfirmed).
      const unconfirmed = (context.unknownWorlds ?? []).length > 0
      const missingWorlds = games
        .filter((game) => !context.installedGames.has(game) && !unconfirmed)
        .map((game) => ({ game, catalogId: installableId(deps.catalog.lookupByGame(game)) }))
      const romNeeds = await resolveRomNeeds(games, deps)
      const issues = [...allDocs.flatMap((doc) => doc.issues), ...sessionIssues]
      const blocking =
        // Archipelago refuses to generate without a single player.
        allDocs.length === 0 ||
        issues.some((issue) => issue.severity === 'error') ||
        missingWorlds.length > 0 ||
        romNeeds.some((need) => need.status !== 'ok')
      return {
        files: checked.map((file) => ({ fileId: file.id, docs: file.docs })),
        sessionIssues,
        missingWorlds,
        romNeeds,
        blocking,
      }
    },
  }
}
