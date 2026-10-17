// The `studio` service (Task 13): the YAML Studio's parsing, rendering and validation, and the files it
// opens and saves. A file is only ever written at a path the user picked in this session (a dialog of
// the main process, or a file opened with studio:open), never at any path the renderer names.
import { readFile, stat } from 'node:fs/promises'
import type { Locator } from '@main/core/ap/locator'
import type { ApSettings } from '@main/core/ap/settings'
import type { Templates } from '@main/core/ap/templates'
import type { CoreContext } from '@main/core/context'
import { writeFileAtomic } from '@main/core/system/fsx'
import { assertUserPath } from '@main/core/system/user-path'
import { disabledWorldsDir, scanWorlds } from '@main/core/worlds/inventory'
import { decodeYamlBytes, loadYaml11 } from '@main/core/yaml/load'
import { gamesIn, validateLoadedYaml, type ValidationContext } from '@main/core/yaml/validate'
import { parsePlayerYaml, renderPlayerDoc, type RenderResult } from '@main/core/yaml/writer'
import { AppError } from '@shared/errors'
import type { ApInstall, EditorDoc, GameSchema, Issue, PlayerDoc, WorldState } from '@shared/types'
// The `locator`, `settings` and `templates` entries of Services, used below.
import type {} from './locator.service'
import type {} from './settings.service'
import type {} from './templates.service'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    studio: Studio
  }
}

export interface Studio {
  parse(text: string): { docs: EditorDoc[]; issues: Issue[] }
  /** With the schema of the doc's game when there is one (integer ranges). */
  render(doc: EditorDoc): Promise<RenderResult>
  /** `fileName` (default `Player.yaml`) gives the name of a document without one. */
  validate(text: string, fileName?: string): Promise<PlayerDoc[]>
  /** Without `path`, an open dialog; null when it is cancelled. */
  open(path?: string): Promise<{ path: string; text: string } | null>
  /**
   * Writes `text` at `path` when this session opened or saved it, or at the path of a save dialog when
   * `path` is null (null: cancelled). PATH_FORBIDDEN for any other path, or one without a YAML
   * extension.
   */
  save(text: string, path: string | null, suggestedName: string): Promise<{ path: string } | null>
}

export interface StudioDeps {
  locator: Pick<Locator, 'detect'>
  templates: Pick<Templates, 'getSchema'>
  settings: Pick<ApSettings, 'get'>
}

const OPEN_EXTENSIONS = ['yaml', 'yml', 'txt']
const SAVE_EXTENSIONS = ['yaml', 'yml']
const DEFAULT_FILE_NAME = 'Player.yaml'
/** A player file is a few kilobytes: a file this big is not one. */
const MAX_OPEN_BYTES = 8 * 1024 * 1024
/** The states of a world Archipelago does not load: its game is not installed. */
const NOT_LOADED: ReadonlySet<WorldState> = new Set(['disabled', 'corrupt', 'incompatible'])
/** generator.plando_options when the settings file has none (settings.py, GeneratorOptions). */
const DEFAULT_PLANDO = 'bosses, connections, texts'

const dotted = (extensions: string[]): string[] => extensions.map((ext) => `.${ext}`)

/** The name the save dialog proposes: a bare file name with a YAML extension. */
function defaultName(suggested: string): string {
  const base = suggested.split(/[\\/]/).pop()?.trim() || DEFAULT_FILE_NAME
  return /\.ya?ml$/i.test(base) ? base : `${base}.yaml`
}

export function createStudio(ctx: CoreContext, deps: StudioDeps): Studio {
  /** The paths this session may write: picked in a dialog or opened. */
  const savable = new Set<string>()
  const keyOf = (p: string): string => (ctx.platform.os === 'win32' ? p.toLowerCase() : p)

  async function schemaOf(game: string): Promise<GameSchema | undefined> {
    try {
      return await deps.templates.getSchema(game)
    } catch (error) {
      ctx.log.debug('studio: no schema', { game, error: String(error) })
      return undefined
    }
  }

  async function setting(path: string[]): Promise<unknown> {
    return deps.settings.get(path).catch(() => undefined)
  }

  /** Game → version of the world Archipelago loads for it (a shadowed one only when it is alone). */
  async function installedGames(install: ApInstall | null): Promise<ValidationContext['installedGames']> {
    const games: ValidationContext['installedGames'] = new Map()
    if (!install) return games
    const worlds = await scanWorlds(
      install.paths,
      disabledWorldsDir(ctx.platform.paths.dataRoot),
      install.version,
    )
    const loaded = worlds.filter(
      (world) => world.game !== null && !world.states.some((s) => NOT_LOADED.has(s)),
    )
    const winnersFirst = [
      ...loaded.filter((world) => !world.states.includes('shadowed')),
      ...loaded.filter((world) => world.states.includes('shadowed')),
    ]
    for (const world of winnersFirst) {
      if (world.game !== null && !games.has(world.game)) {
        games.set(world.game, { worldVersion: world.manifest?.worldVersion ?? null })
      }
    }
    return games
  }

  async function validationContext(games: string[]): Promise<ValidationContext> {
    const install = await deps.locator.detect()
    const installed = await installedGames(install)
    const schemas = new Map<string, GameSchema>()
    await Promise.all(
      games
        .filter((game) => installed.has(game))
        .map(async (game) => {
          const schema = await schemaOf(game)
          if (schema) schemas.set(game, schema)
        }),
    )
    const [allowQuantity, plando] = install
      ? await Promise.all([
          setting(['generator', 'allow_quantity']),
          setting(['generator', 'plando_options']),
        ])
      : [false, DEFAULT_PLANDO]
    return {
      installedGames: installed,
      apVersion: install?.version ?? '',
      schemaFor: (game) => schemas.get(game),
      allowQuantity: allowQuantity === true || allowQuantity === 1,
      plandoEnabled: (typeof plando === 'string' ? plando : DEFAULT_PLANDO)
        .split(',')
        .map((module) => module.trim().toLowerCase())
        .filter((module) => module !== ''),
    }
  }

  return {
    parse: (text) => parsePlayerYaml(text),

    async render(doc) {
      return renderPlayerDoc(doc, doc.game === '' ? undefined : await schemaOf(doc.game))
    },

    async validate(text, fileName = DEFAULT_FILE_NAME) {
      const loaded = loadYaml11(text)
      const games = loaded.issues.length > 0 ? [] : gamesIn(loaded.docs)
      return validateLoadedYaml(loaded, fileName, await validationContext(games))
    },

    async open(given) {
      let file = given
      if (file === undefined) {
        ;[file] = await ctx.platform.showOpenDialog({
          mode: 'file',
          filters: [{ name: 'YAML', extensions: OPEN_EXTENSIONS }],
        })
        if (file === undefined) return null
      }
      const checked = await assertUserPath(file, { kind: 'file', exts: dotted(OPEN_EXTENSIONS) })
      if ((await stat(checked)).size > MAX_OPEN_BYTES) {
        throw new AppError('INVALID_INPUT', { reason: 'too-large' }, { detail: checked })
      }
      const { text } = decodeYamlBytes(await readFile(checked))
      savable.add(keyOf(checked))
      return { path: checked, text }
    },

    async save(text, given, suggestedName) {
      let target: string
      if (given === null) {
        const picked = await ctx.platform.showSaveDialog({
          defaultName: defaultName(suggestedName),
          filters: [{ name: 'YAML', extensions: SAVE_EXTENSIONS }],
        })
        if (picked === null) return null
        target = picked
      } else {
        target = await assertUserPath(given, { mustExist: false, access: 'write' })
        if (!savable.has(keyOf(target))) {
          throw new AppError('PATH_FORBIDDEN', { reason: 'not-picked' }, { detail: target })
        }
      }
      const checked = await assertUserPath(target, {
        mustExist: false,
        access: 'write',
        kind: 'file',
        exts: dotted(SAVE_EXTENSIONS),
      })
      // UTF-8 without BOM, what Archipelago reads (it would accept one, other tools may not).
      await writeFileAtomic(checked, text.replace(/^\uFEFF/, ''))
      savable.add(keyOf(checked))
      return { path: checked }
    },
  }
}

defineService(
  'studio',
  (ctx, get) =>
    // Resolved on use: parsing, rendering and saving never start the locator or the templates.
    createStudio(ctx, {
      locator: { detect: () => get('locator').detect() },
      templates: { getSchema: (game) => get('templates').getSchema(game) },
      settings: { get: (path) => get('settings').get(path) },
    }),
  { eager: false },
)
