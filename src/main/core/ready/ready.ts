// « Jeu prêt » (spec §3.7): one task from a catalog entry to a player YAML delivered. `prepare` works
// out the plan without changing anything (is Archipelago there, is the world installed or behind the
// catalog, its trust, its profiles, the sessions being prepared, what to know). `run` then goes
// through the steps: the world installed as the worlds screen does it (prepare then confirm), unless it
// is a core world or installed already and not updated; the templates regenerated when the game has
// none of its own; the profile's YAML, measured once; its validation; its delivery. Each step done is
// kept with the plan: a run that fails or is cancelled is run again from the first step not done (a
// world installed stays installed), and a plan delivered answers its outcome again.
import { randomUUID } from 'node:crypto'
import { isNewerVersion } from '@shared/catalog'
import { AppError } from '@shared/errors'
import type {
  GameProfiles,
  ProfileId,
  ReadyDestination,
  ReadyOutcome,
  ReadyPlan,
  TrustTier,
} from '@shared/types'
import { throwIfCancelled } from '../ap/install-steps'
import type { Locator } from '../ap/locator'
import { listApProcesses, type ProcessInfo } from '../ap/processes'
import type { Templates } from '../ap/templates'
import type { Measurer } from '../checks/measure'
import type { CoreContext } from '../context'
import type { Profiles } from '../profiles/profiles'
import type { SessionStore } from '../sessions/store'
import { writeFileAtomic } from '../system/fsx'
import type { PickedPaths } from '../system/picked-paths'
import { assertUserPath } from '../system/user-path'
import type { TaskHandle } from '../tasks'
import { compactKey, type Catalog } from '../worlds/catalog'
import type { WorldInstaller } from '../worlds/install'
import { loadYaml11 } from '../yaml/load'
import { gamesIn, validateLoadedYaml, type ValidationContext } from '../yaml/validate'

/** A plan not run for this long is dropped (with what its runs did). */
export const READY_PLAN_TTL_MS = 60 * 60 * 1000

/** The tiers whose full warning the user accepts before the world is installed (spec §3.7). */
const CONSENT_TIERS: ReadonlySet<TrustTier> = new Set(['wiki-release', 'unknown'])
/** The name of the delivered file when the YAML has no player name (it is then `Player{number}`). */
const DEFAULT_PLAYER = 'Player'
/** What a file destination may be called: what the Studio saves. */
const YAML_EXTENSIONS = ['.yaml', '.yml']

export interface ReadyRun {
  planId: string
  profile: ProfileId
  /** Empty: `Player{number}`. */
  playerName: string
  destination: ReadyDestination
  /** Installs the catalog's later version of a world installed already. */
  update: boolean
  /** Needed when a world of a `wiki-release` or `unknown` tier is installed. */
  trustAccepted: boolean
}

export interface Ready {
  /** NOT_FOUND for an entry the catalog does not have. The plan stays valid for READY_PLAN_TTL_MS. */
  prepare(entryId: string): Promise<ReadyPlan>
  /**
   * The task's stages `download`, `inspect`, `install` (only when a world is installed), `templates`,
   * `profile`, `validate`, `deliver`, `done`, from the first step the plan has not done. NOT_FOUND for
   * an unknown or expired plan, AP_NOT_INSTALLED without Archipelago, INVALID_INPUT for a world to
   * install whose trust needs `trustAccepted` (as the plan tells it, or as the catalog tells it when
   * the world is downloaded), AP_YAML_INVALID for a YAML the validation refuses, PATH_FORBIDDEN for a
   * file the user did not pick; the errors of each step otherwise (a download, an install, the
   * templates, a destination). A profile left out for being Standard's twin builds Standard.
   */
  run(input: ReadyRun, task: TaskHandle): Promise<ReadyOutcome>
}

export interface ReadyDeps {
  catalog: Pick<Catalog, 'lookup'>
  locator: Pick<Locator, 'detect'>
  worlds: Pick<WorldInstaller, 'prepare' | 'confirm'> & {
    /** Game → version of the world Archipelago loads for it, core games included. */
    installedGames(): Promise<ValidationContext['installedGames']>
  }
  templates: Pick<Templates, 'getSchema' | 'regenerate'>
  profiles: Pick<Profiles, 'get' | 'yamlFor'>
  measurer: Pick<Measurer, 'measureDoc'>
  sessions: Pick<SessionStore, 'list' | 'create' | 'addText'>
  /** The paths the user picked (app:savePath): the only ones a file destination may name. */
  pickedPaths: Pick<PickedPaths, 'has'>
  /** The context the Studio validates a YAML rolling these games with. */
  validationContext(games: readonly string[]): Promise<ValidationContext>
  /** The Archipelago programs running. Default: `listApProcesses`. */
  listProcesses?: () => Promise<ProcessInfo[]>
  /** The clock of plan expiry. Default: `Date.now`. */
  now?: () => number
}

/** A plan and what its runs did so far. */
interface Pending {
  plan: ReadyPlan
  expiresAt: number
  /** The game of the YAML: the plan's, then the one the world installed declares. */
  game: string
  /** The world is in place: installed by a run, or there already. */
  worldDone: boolean
  /** A run installed the world: the Archipelago programs running then need a restart. */
  installedWorld: boolean
  templatesDone: boolean
  /**
   * The YAML of the profile built (`profile`: Standard for one left out as equal to it) and its checks,
   * for the profile and the player name asked.
   */
  yaml: {
    asked: ProfileId
    profile: ProfileId
    playerName: string
    text: string
    checks: number | null
  } | null
  validated: boolean
  /** The session a run created for a `new-session` destination: a retry adds to it. */
  createdSession: string | null
  outcome: ReadyOutcome | null
  /** The runs of the plan, one after the other: a retry waits for a cancelled run to settle. */
  queue: Promise<void>
  /** A run is going through the steps: the plan does not expire meanwhile. */
  running: boolean
}

/** The game of `games` that is `game`, else the same name without accents, case or punctuation. */
function loadedName(games: ReadonlyMap<string, unknown>, game: string): string | null {
  if (games.has(game)) return game
  const key = compactKey(game)
  return [...games.keys()].find((name) => compactKey(name) === key) ?? null
}

/** `task` with every stage it reports reported as `stage`: a step's own stages stay inside it. */
const within = (task: TaskHandle, stage: string): TaskHandle => ({
  id: task.id,
  signal: task.signal,
  progress: (_stage, percent = null) => task.progress(stage, percent),
  log: (stream, line) => task.log(stream, line),
})

export function createReady(ctx: CoreContext, deps: ReadyDeps): Ready {
  const now = deps.now ?? Date.now
  const listProcesses = deps.listProcesses ?? (() => listApProcesses(ctx.exec, ctx.platform.os))
  const plans = new Map<string, Pending>()

  function dropExpired(): void {
    for (const [planId, pending] of plans) {
      if (!pending.running && pending.expiresAt <= now()) plans.delete(planId)
    }
  }

  async function isApRunning(): Promise<boolean> {
    try {
      return (await listProcesses()).length > 0
    } catch (error) {
      ctx.log.warn('ready: cannot list the archipelago programs', error)
      return false
    }
  }

  /** The game's profiles; none while it has no option schema (a world not installed yet). */
  async function profilesOf(game: string): Promise<GameProfiles> {
    try {
      return await deps.profiles.get(game)
    } catch (error) {
      ctx.log.debug('ready: no profiles yet', { game, error: String(error) })
      return { game, profiles: [], measured: false }
    }
  }

  /** True when Archipelago wrote a template for the game (the site's does not count). */
  async function hasLocalTemplate(game: string): Promise<boolean> {
    try {
      return (await deps.templates.getSchema(game)).source === 'local'
    } catch {
      return false
    }
  }

  /** AP_YAML_INVALID, naming the first error, when the validation refuses the YAML. */
  async function validate(text: string, fileName: string): Promise<void> {
    const loaded = loadYaml11(text)
    const games = loaded.issues.length > 0 ? [] : gamesIn(loaded.docs)
    const docs = validateLoadedYaml(loaded, fileName, await deps.validationContext(games))
    const error = docs.flatMap((doc) => doc.issues).find((issue) => issue.severity === 'error')
    if (error) {
      const detail = error.path === undefined ? error.code : `${error.code} at ${error.path}`
      throw new AppError('AP_YAML_INVALID', undefined, { detail })
    }
  }

  async function deliver(
    pending: Pending,
    destination: ReadyDestination,
    fileName: string,
    text: string,
  ): Promise<ReadyOutcome['delivered']> {
    switch (destination.kind) {
      case 'session':
        await deps.sessions.addText(destination.sessionId, fileName, text)
        return { kind: 'session', sessionId: destination.sessionId }
      case 'new-session': {
        pending.createdSession ??= (await deps.sessions.create(destination.name)).id
        await deps.sessions.addText(pending.createdSession, fileName, text)
        return { kind: 'session', sessionId: pending.createdSession }
      }
      case 'file': {
        // The renderer got the path from a save dialog; it is checked again before anything is written.
        const path = await assertUserPath(destination.path, {
          mustExist: false,
          access: 'write',
          kind: 'file',
          exts: YAML_EXTENSIONS,
        })
        // Only a file the user picked in a save dialog (Ruling 27).
        if (!deps.pickedPaths.has(path)) {
          throw new AppError('PATH_FORBIDDEN', { reason: 'not-picked' }, { detail: path })
        }
        await writeFileAtomic(path, text)
        return { kind: 'file', path }
      }
      case 'studio':
        // The renderer loads the text in the Studio's draft.
        return { kind: 'studio' }
    }
  }

  async function steps(pending: Pending, input: ReadyRun, task: TaskHandle): Promise<ReadyOutcome> {
    if (pending.outcome) return pending.outcome
    const { plan } = pending
    const installing =
      !pending.worldDone &&
      plan.trust !== 'core' &&
      (!plan.installed || (input.update && plan.updateAvailable))
    /** INVALID_INPUT when installing a world of this trust needs the consent the run was not given. */
    const checkConsent = (trust: TrustTier): void => {
      if (CONSENT_TIERS.has(trust) && !input.trustAccepted) {
        throw new AppError('INVALID_INPUT', { reason: 'trust' }, { detail: plan.entryId })
      }
    }
    if (installing) checkConsent(plan.trust)
    if (!(await deps.locator.detect())) throw new AppError('AP_NOT_INSTALLED')

    // 1. download, inspect, install: the worlds screen's own way.
    if (installing) {
      const world = await deps.worlds.prepare({ kind: 'catalog', id: plan.entryId }, task)
      throwIfCancelled(task.signal)
      // The catalog may tell another trust now (refreshed, or Archipelago installed since the plan):
      // the world downloaded is installed only on the terms it was inspected with.
      checkConsent(world.trust)
      task.progress('install', null)
      const { world: installed } = await deps.worlds.confirm(world.planId)
      pending.game = installed.game ?? pending.game
      pending.installedWorld = true
    }
    pending.worldDone = true
    throwIfCancelled(task.signal)
    const { game } = pending

    // 2. templates: the game's own, written by Archipelago.
    if (!pending.templatesDone) {
      task.progress('templates', null)
      if (!(await hasLocalTemplate(game))) await deps.templates.regenerate(within(task, 'templates'))
      pending.templatesDone = true
      throwIfCancelled(task.signal)
    }

    // 3. profile: the profile's YAML (refined when kept, else heuristic) and one measure of it.
    const { playerName } = input
    let { yaml } = pending
    if (yaml?.asked !== input.profile || yaml.playerName !== playerName) {
      task.progress('profile', null)
      // A profile left out of the game's is Standard's twin (Ruling 26): Standard is what is built.
      const { profiles } = await deps.profiles.get(game)
      const profile = profiles.some((one) => one.id === input.profile) ? input.profile : 'standard'
      const text = await deps.profiles.yamlFor(game, profile, playerName)
      throwIfCancelled(task.signal)
      // Rejects only when cancelled: a measure that cannot run leaves the count unknown.
      const measured = await deps.measurer.measureDoc({ sessionId: null, game, yamlText: text, task })
      if (measured.error !== null) {
        ctx.log.debug('ready: the YAML could not be measured', { game, code: measured.error.code })
      }
      yaml = { asked: input.profile, profile, playerName, text, checks: measured.checks }
      pending.yaml = yaml
      pending.validated = false
    }

    // 4. validate.
    const fileName = `${playerName === '' ? DEFAULT_PLAYER : playerName} - ${game}.yaml`
    if (!pending.validated) {
      task.progress('validate', null)
      await validate(yaml.text, fileName)
      pending.validated = true
    }
    throwIfCancelled(task.signal)

    // 5. deliver.
    task.progress('deliver', null)
    const delivered = await deliver(pending, input.destination, fileName, yaml.text)
    const outcome: ReadyOutcome = {
      game,
      profile: yaml.profile,
      checks: yaml.checks,
      text: yaml.text,
      delivered,
      restartNeeded: pending.installedWorld && (await isApRunning()),
    }
    pending.outcome = outcome
    task.progress('done', 100)
    return outcome
  }

  return {
    async prepare(entryId) {
      dropExpired()
      const entry = deps.catalog.lookup(entryId)
      if (!entry) throw new AppError('NOT_FOUND', undefined, { detail: entryId })
      const apInstalled = (await deps.locator.detect()) !== null
      const games = apInstalled ? await deps.worlds.installedGames() : new Map<string, never>()
      const loaded = loadedName(games, entry.game)
      // A core world comes with Archipelago; any other is installed when Archipelago loads its game.
      const installed = entry.trust === 'core' ? apInstalled : loaded !== null
      const version = loaded === null ? null : (games.get(loaded)?.worldVersion ?? 'unknown')
      const game = loaded ?? entry.game
      const [profiles, sessions, apRunning] = await Promise.all([
        profilesOf(game),
        deps.sessions.list(),
        isApRunning(),
      ])
      const plan: ReadyPlan = {
        planId: randomUUID(),
        entryId: entry.id,
        game,
        apInstalled,
        installed,
        updateAvailable:
          installed &&
          version !== null &&
          entry.latest !== null &&
          isNewerVersion(entry.latest.version, version),
        trust: entry.trust,
        needsTrustConsent: CONSENT_TIERS.has(entry.trust),
        profiles,
        sessions: sessions.filter((s) => s.status === 'draft').map(({ id, name }) => ({ id, name })),
        notes: {
          romRequired: entry.requiresRomAtGeneration,
          popTracker: entry.hasPopTracker,
          setupUrl: entry.wiki?.setupUrl ?? null,
          apRunning,
        },
      }
      plans.set(plan.planId, {
        plan,
        expiresAt: now() + READY_PLAN_TTL_MS,
        game,
        worldDone: false,
        installedWorld: false,
        templatesDone: false,
        yaml: null,
        validated: false,
        createdSession: null,
        outcome: null,
        queue: Promise.resolve(),
        running: false,
      })
      return plan
    },

    run(input, task) {
      dropExpired()
      const pending = plans.get(input.planId)
      if (!pending) return Promise.reject(new AppError('NOT_FOUND', undefined, { detail: input.planId }))
      pending.expiresAt = now() + READY_PLAN_TTL_MS
      const result = pending.queue.then(async () => {
        pending.running = true
        try {
          return await steps(pending, input, task)
        } finally {
          pending.running = false
          pending.expiresAt = now() + READY_PLAN_TTL_MS
        }
      })
      pending.queue = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
}
