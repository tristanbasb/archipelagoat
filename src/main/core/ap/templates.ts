// The option schemas the Studio edits (spec §3.10), and the regeneration of the local templates.
// A schema comes from the template Archipelago wrote in `Players/Templates/<file-safe game>.yaml`,
// else from the one archipelago.gg serves for its own version (kept in memory once read), else the
// game has none. Presets come from the same place as the template: `Templates/Presets/<game> -
// <preset>.yaml`, or `/games/<game>/option-presets` on the site.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AP_EXES } from '@shared/data/ap-constants'
import { coreWorldsFor } from '@shared/data/core-worlds'
import { matchApError } from '@shared/data/error-catalog'
import { AppError } from '@shared/errors'
import type { ApInstall, GameSchema, OptionSchema, StudioGame } from '@shared/types'
import type { CoreContext } from '../context'
import { redact } from '../system/redact'
import type { TaskHandle } from '../tasks'
import { disabledWorldsDir, NOT_LOADED_STATES, scanWorlds } from '../worlds/inventory'
import { fileSafeName, parseTemplate, readTemplateHeader } from '../yaml/template-parser'
import type { Locator } from './locator'
import { spawnAp, type ApExit, type ApProcess } from './process'

/** How long the Launcher may take to write every template (it imports every world first). */
export const TEMPLATE_TIMEOUT_MS = 5 * 60 * 1000

/** The Launcher component that writes the templates, without opening their folder (brief §1.9). */
export const TEMPLATE_ARGS: readonly string[] = ['Generate Template Options', '--', '--skip_open_folder']

/** Worlds with `hidden = True` (worlds/generic/__init__.py): Archipelago writes no template for them. */
const HIDDEN_GAMES: ReadonlySet<string> = new Set(['Archipelago'])

/** The output lines read to translate a failed run. */
const FAILURE_LINES = 200

export interface TemplatesDeps {
  locator: Pick<Locator, 'detect' | 'exe'>
  /** Default: `spawnAp`. */
  spawn?: typeof spawnAp
  /** Default: `TEMPLATE_TIMEOUT_MS`. */
  timeoutMs?: number
}

export interface Templates {
  /** The installed games and the games of the local templates, by name. */
  listGames(): Promise<StudioGame[]>
  /** NOT_FOUND when neither the local templates nor the site have the game. */
  getSchema(game: string): Promise<GameSchema>
  /**
   * Runs the Launcher's "Generate Template Options" (task stages `scan`, `generate`, `done`); `count`
   * is the number of game templates after it.
   */
  regenerate(task: TaskHandle): Promise<{ count: number }>
}

type Presets = GameSchema['presets']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionsOf = (schema: GameSchema): OptionSchema[] => schema.groups.flatMap((group) => group.options)

const byName = (a: StudioGame, b: StudioGame): number => a.game.localeCompare(b.game, 'en')

/** A toggle as the schema holds it: the site sends the names `'true'` and `'false'`. */
function toggleValue(value: unknown): unknown {
  if (value === true || value === 'true' || value === 1) return true
  if (value === false || value === 'false' || value === 0) return false
  return value
}

/** The presets of the site, with the values of toggles as booleans; anything malformed is dropped. */
function sitePresets(data: unknown, schema: GameSchema): Presets {
  if (!isRecord(data)) return {}
  const kinds = new Map(optionsOf(schema).map((option) => [option.key, option.kind]))
  const presets: Presets = {}
  for (const [name, values] of Object.entries(data)) {
    if (!isRecord(values)) continue
    presets[name] = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        kinds.get(key) === 'toggle' ? toggleValue(value) : value,
      ]),
    )
  }
  return presets
}

/** What a preset template changes: the options whose default differs from the template's. */
function presetValues(base: GameSchema, preset: GameSchema): Record<string, unknown> {
  const defaults = new Map(optionsOf(base).map((option) => [option.key, option.default]))
  return Object.fromEntries(
    optionsOf(preset)
      .filter(
        (option) => !defaults.has(option.key) || !isDeepStrictEqual(defaults.get(option.key), option.default),
      )
      .map((option) => [option.key, option.default]),
  )
}

/** `<preset> Preset for <game>`, the description generate_yaml_templates gives a preset. */
function presetNameOf(description: string | null, game: string): string | null {
  const suffix = ` Preset for ${game}`
  return description?.endsWith(suffix) ? description.slice(0, -suffix.length) : null
}

async function readText(file: string): Promise<string | null> {
  return readFile(file, 'utf8').catch(() => null)
}

export function createTemplates(ctx: CoreContext, deps: TemplatesDeps): Templates {
  const { log } = ctx
  const spawn = deps.spawn ?? spawnAp
  const timeoutMs = deps.timeoutMs ?? TEMPLATE_TIMEOUT_MS
  /** The site schemas read during this run: they change with the site's version only. */
  const siteSchemas = new Map<string, GameSchema>()

  const webhost = (): string => ctx.config.get().webhostUrl.replace(/\/+$/, '')

  /** Game → template file, for the files named as Archipelago names the template of their game. */
  async function localTemplates(install: ApInstall): Promise<Map<string, string>> {
    const dir = install.paths.templates
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((name) => /\.yaml$/i.test(name))
      .sort()
    const found = new Map<string, string>()
    for (const name of names) {
      const text = await readText(path.join(dir, name))
      const game = text === null ? null : readTemplateHeader(text).game
      if (game !== null && name === `${fileSafeName(game)}.yaml`) found.set(game, path.join(dir, name))
    }
    return found
  }

  async function localPresets(install: ApInstall, base: GameSchema): Promise<Presets> {
    const dir = path.join(install.paths.templates, 'Presets')
    // fileSafeName works character by character: the safe name of `<game> - <preset>` starts so.
    const prefix = `${fileSafeName(base.game)} - `
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((name) => name.startsWith(prefix) && /\.yaml$/i.test(name))
      .sort()
    const presets: Presets = {}
    for (const name of names) {
      const text = await readText(path.join(dir, name))
      if (text === null) continue
      let preset: GameSchema
      try {
        preset = parseTemplate(text)
      } catch (error) {
        log.warn('templates: unreadable preset', { file: name, error: String(error) })
        continue
      }
      // Another game whose name starts like this one (`<game> - Remix`).
      if (preset.game !== base.game) continue
      const presetName =
        presetNameOf(readTemplateHeader(text).description, base.game) ??
        name.slice(prefix.length, -'.yaml'.length)
      presets[presetName] = presetValues(base, preset)
    }
    return presets
  }

  async function localSchema(install: ApInstall, game: string): Promise<GameSchema | null> {
    const file = path.join(install.paths.templates, `${fileSafeName(game)}.yaml`)
    const text = await readText(file)
    if (text === null) return null
    let schema: GameSchema
    try {
      schema = parseTemplate(text)
    } catch (error) {
      log.warn('templates: unreadable local template, trying the site', { file, error: String(error) })
      return null
    }
    // Two games can share a file-safe name: the file holds the last one written.
    if (schema.game !== game) return null
    return { ...schema, source: 'local', presets: await localPresets(install, schema) }
  }

  async function fetchSitePresets(game: string, schema: GameSchema): Promise<Presets> {
    try {
      const url = `${webhost()}/games/${encodeURIComponent(game)}/option-presets`
      return sitePresets((await ctx.http.getJson<unknown>(url)).data, schema)
    } catch (error) {
      log.warn('templates: no presets from the site', { game, error: String(error) })
      return {}
    }
  }

  async function siteSchema(game: string): Promise<GameSchema> {
    const known = siteSchemas.get(game)
    if (known) return known
    const url = `${webhost()}/static/generated/configs/${encodeURIComponent(fileSafeName(game))}.yaml`
    let answer: Awaited<ReturnType<typeof ctx.http.getText>>
    try {
      answer = await ctx.http.getText(url)
    } catch (error) {
      if (error instanceof AppError && error.code === 'HTTP_ERROR' && error.params?.status === 404) {
        throw new AppError('NOT_FOUND', { game }, { detail: url })
      }
      throw error
    }
    const parsed = parseTemplate(answer.data)
    if (parsed.game !== game)
      throw new AppError('NOT_FOUND', { game }, { detail: `${url} is for ${parsed.game}` })
    const schema: GameSchema = { ...parsed, source: 'site', presets: await fetchSitePresets(game, parsed) }
    // A stale answer (the network failed) is asked for again next time.
    if (!answer.stale) siteSchemas.set(game, schema)
    return schema
  }

  async function requireInstall(): Promise<ApInstall> {
    const install = await deps.locator.detect()
    if (!install) throw new AppError('AP_NOT_INSTALLED')
    return install
  }

  /** The exit of the run; kills it (and waits for it) on a timeout or a cancellation. */
  function settle(proc: ApProcess, signal: AbortSignal, program: string): Promise<ApExit> {
    return new Promise<ApExit>((resolve, reject) => {
      let stopped: AppError | null = null
      const stop = (error: AppError): void => {
        if (stopped) return
        stopped = error
        proc.kill()
      }
      const timer = setTimeout(() => stop(new AppError('PROCESS_TIMEOUT', { command: program })), timeoutMs)
      const onAbort = (): void => stop(new AppError('TASK_CANCELLED'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      proc.exited.then(
        (exit) => {
          done()
          if (stopped) reject(stopped)
          else resolve(exit)
        },
        (error: unknown) => {
          done()
          reject(
            stopped ?? new AppError('AP_NOT_INSTALLED', undefined, { detail: String(error), cause: error }),
          )
        },
      )
    })
  }

  return {
    async listGames() {
      const install = await deps.locator.detect()
      if (!install) return []
      const [worlds, local] = await Promise.all([
        scanWorlds(install.paths, disabledWorldsDir(ctx.platform.paths.dataRoot), install.version),
        localTemplates(install),
      ])
      // The site serves the templates of the core worlds (of its own version).
      const onSite = new Set(
        install.version === null ? [] : (coreWorldsFor(install.version) ?? []).map((w) => w.game),
      )
      const installed = new Set(
        worlds
          .filter((world) => !world.states.some((state) => NOT_LOADED_STATES.has(state)))
          .flatMap((world) => (world.game === null || HIDDEN_GAMES.has(world.game) ? [] : [world.game])),
      )
      const games = new Set([...installed, ...local.keys()])
      return [...games]
        .map((game): StudioGame => {
          let schemaSource: StudioGame['schemaSource'] = 'none'
          if (local.has(game)) schemaSource = 'local'
          else if (onSite.has(game) || siteSchemas.has(game)) schemaSource = 'site'
          return { game, installed: installed.has(game), schemaSource }
        })
        .sort(byName)
    },

    async getSchema(game) {
      const install = await deps.locator.detect()
      const local = install ? await localSchema(install, game) : null
      return local ?? siteSchema(game)
    },

    async regenerate(task) {
      const install = await requireInstall()
      task.progress('scan')
      const worlds = await scanWorlds(
        install.paths,
        disabledWorldsDir(ctx.platform.paths.dataRoot),
        install.version,
      )
      // Archipelago stops on a corrupt world before it writes anything (brief §1.10).
      const corrupt = worlds.find((world) => world.states.includes('corrupt'))
      if (corrupt) throw new AppError('WORLD_CORRUPT_BLOCKING', { file: corrupt.fileName })
      if (task.signal.aborted) throw new AppError('TASK_CANCELLED')

      task.progress('generate')
      // The Debug copy is the console Launcher, which exists on Windows only.
      const program = ctx.platform.os === 'win32' ? AP_EXES.launcherDebug : AP_EXES.launcher
      const proc = spawn(ctx, {
        exe: deps.locator.exe(install, program),
        args: [...TEMPLATE_ARGS],
        // An AppImage has no readable local folder: Archipelago writes its templates in user_path.
        cwd: install.paths.userPath,
        stdin: 'ignore',
        onLine: (stream, line) => task.log(stream, redact(line)),
      })
      const exit = await settle(proc, task.signal, program)
      if (exit.code !== 0) {
        const known = matchApError(proc.lastLines(FAILURE_LINES).join('\n'))
        if (known) throw new AppError(known.code, known.params)
        throw new AppError('AP_UNKNOWN', { exitCode: String(exit.code ?? exit.signal) })
      }

      const count = (await localTemplates(install)).size
      task.progress('done', 100)
      return { count }
    },
  }
}
