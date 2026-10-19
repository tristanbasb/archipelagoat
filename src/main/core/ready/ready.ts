// « Jeu prêt » (spec §3.7): one task from a catalog entry to a player YAML delivered. `prepare` works
// out the plan without changing anything (is Archipelago there, is the world installed or behind the
// catalog, its trust, its profiles, the sessions being prepared, what to know). `run` then goes
// through the steps: the world installed as the worlds screen does it (prepare then confirm), unless it
// is a core world or installed already and not updated; the templates regenerated when the game has
// none of its own; the profile's YAML (Découverte and Complet once the game is refined), measured once;
// its validation; its delivery. Each step done is kept with the plan: a run that fails or is cancelled
// is run again from the first step not done (a world installed stays installed), and a plan delivered
// answers its outcome again.
import { randomUUID } from 'node:crypto'
import { isNewerVersion } from '@shared/catalog'
import { AppError } from '@shared/errors'
import { PLAYER_NAME_MAX } from '@shared/ipc/app'
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
import { listApProcesses, userApPrograms, type ProcessInfo } from '../ap/processes'
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
import { gamesIn, sessionSlotNames, validateLoadedYaml, type ValidationContext } from '../yaml/validate'
import { parsePlayerYaml, renderPlayerYaml } from '../yaml/writer'

/** A plan not run for this long is dropped (with what its runs did). */
export const READY_PLAN_TTL_MS = 60 * 60 * 1000

/** The tiers whose full warning the user accepts before the world is installed (spec §3.7). */
const CONSENT_TIERS: ReadonlySet<TrustTier> = new Set(['wiki-release', 'unknown'])
/** The name of the delivered file when the YAML has no player name (it is then `Player{number}`). */
const DEFAULT_PLAYER = 'Player'
/** What a file destination may be called: what the Studio saves. */
const YAML_EXTENSIONS = ['.yaml', '.yml']

/** The name of a delivered file: the player's and the game's. */
const fileNameOf = (playerName: string, game: string): string =>
  `${playerName === '' ? DEFAULT_PLAYER : playerName} - ${game}.yaml`

/**
 * `name`, else the first of `name2`, `name3`… (cut to make room for the number within the 16
 * characters of a name) that `taken`, in lower case, does not have.
 */
function freeName(name: string, taken: ReadonlySet<string>): string {
  const chars = [...name]
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : String(n)
    const candidate = chars.slice(0, PLAYER_NAME_MAX - suffix.length).join('') + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

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
   * templates, a destination). A profile left out for being Standard's twin builds Standard. Découverte
   * and Complet wait for the game's refinement when none is kept (`profile` reports its measures);
   * one still made from the option names alone afterwards is said (`refinementFailed`).
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
  profiles: Pick<Profiles, 'get' | 'profileYaml'> & {
    /**
     * The game's profiles refined for a run that waits for them, the refinement's stages reported to
     * `task`: its refinement running joined (then one for the game as it is now, if that one no
     * longer holds), else one started, its measures in the foreground. Rejects as the refinement
     * does, or with TASK_CANCELLED once `task` is cancelled.
     */
    refineNow(game: string, task: TaskHandle): Promise<GameProfiles>
  }
  measurer: Pick<Measurer, 'measureDoc'>
  sessions: Pick<SessionStore, 'list' | 'create' | 'addText' | 'get'>
  /** The paths the user picked (app:savePath): the only ones a file destination may name. */
  pickedPaths: Pick<PickedPaths, 'has'>
  /** The context the Studio validates a YAML rolling these games with. */
  validationContext(games: readonly string[]): Promise<ValidationContext>
  /** The Archipelago programs running. Default: `listApProcesses`. */
  listProcesses?: () => Promise<ProcessInfo[]>
  /** The pids of the app's own test generations, left out of the programs running. Default: `measurePids`. */
  measurePids?: () => ReadonlySet<number>
  /** The clock of plan expiry. Default: `Date.now`. */
  now?: () => number
}

/** What a delivery did: where the YAML went, and the name and text it went with. */
type Delivery = Pick<ReadyOutcome, 'delivered' | 'playerName' | 'text'>

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
   * for the profile and the player name asked; whether it is a Découverte or Complet made from the
   * option names alone.
   */
  yaml: {
    asked: ProfileId
    profile: ProfileId
    playerName: string
    text: string
    checks: number | null
    refinementFailed: boolean
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
  progress: (_stage, percent = null, detail) => task.progress(stage, percent, detail),
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

  /** True when an Archipelago program the user opened runs: the app's own measures are none (Ruling 35). */
  async function isApRunning(): Promise<boolean> {
    try {
      return (await userApPrograms(listProcesses, deps.measurePids)).length > 0
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

  /**
   * Adds the YAML to a session, under the next free name (`Name2`, `Name3`…) when one of its players
   * already has `playerName`: Archipelago refuses two players of one name, whatever their case. An
   * empty name is `Player{number}`, which Archipelago numbers itself.
   */
  async function addToSession(
    sessionId: string,
    game: string,
    playerName: string,
    text: string,
  ): Promise<Delivery> {
    let delivered = { playerName, text }
    if (playerName !== '') {
      const { players } = await deps.sessions.get(sessionId)
      const taken = new Set(
        sessionSlotNames(players).flatMap((name) => (name === null ? [] : [name.toLowerCase()])),
      )
      const name = freeName(playerName, taken)
      // Only the name changes: the rest is the YAML measured and validated.
      const doc = name === playerName ? undefined : parsePlayerYaml(text).docs[0]
      if (doc) delivered = { playerName: name, text: renderPlayerYaml({ ...doc, name }) }
    }
    await deps.sessions.addText(sessionId, fileNameOf(delivered.playerName, game), delivered.text)
    return { delivered: { kind: 'session', sessionId }, ...delivered }
  }

  async function deliver(
    pending: Pending,
    destination: ReadyDestination,
    playerName: string,
    text: string,
  ): Promise<Delivery> {
    const { game } = pending
    switch (destination.kind) {
      case 'session':
        return addToSession(destination.sessionId, game, playerName, text)
      case 'new-session': {
        pending.createdSession ??= (await deps.sessions.create(destination.name)).id
        return addToSession(pending.createdSession, game, playerName, text)
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
        return { delivered: { kind: 'file', path }, playerName, text }
      }
      case 'studio':
        // The renderer loads the text in the Studio's draft.
        return { delivered: { kind: 'studio' }, playerName, text }
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

    // 3. profile: the profile's YAML (refined, else heuristic) and one measure of it.
    const { playerName } = input
    let { yaml } = pending
    if (yaml?.asked !== input.profile || yaml.playerName !== playerName) {
      task.progress('profile', null)
      // Découverte and Complet wait for the game's refinement (Ruling 34): from the option names alone,
      // Hollow Knight's Découverte had 8 checks of Standard's 203. Standard is the defaults.
      if (input.profile !== 'standard' && !(await deps.profiles.get(game)).measured) {
        try {
          await deps.profiles.refineNow(game, within(task, 'profile'))
        } catch (error) {
          throwIfCancelled(task.signal)
          // The heuristic profile then, said on the end screen.
          ctx.log.debug('ready: the profiles could not be refined', { game, error: String(error) })
        }
        task.progress('profile', null)
      }
      // The profile written, its text and whether it is refined, from one read of what is kept: a
      // profile left out is Standard's twin (Ruling 26), and a heuristic Découverte or Complet is
      // never delivered without saying so, whatever the refinement did.
      const made = await deps.profiles.profileYaml(game, input.profile, playerName)
      throwIfCancelled(task.signal)
      // Rejects only when cancelled: a measure that cannot run leaves the count unknown.
      const measured = await deps.measurer.measureDoc({ sessionId: null, game, yamlText: made.text, task })
      if (measured.error !== null) {
        ctx.log.debug('ready: the YAML could not be measured', { game, code: measured.error.code })
      }
      yaml = {
        asked: input.profile,
        profile: made.profile,
        playerName,
        text: made.text,
        checks: measured.checks,
        refinementFailed: made.profile !== 'standard' && !made.measured,
      }
      pending.yaml = yaml
      pending.validated = false
    }

    // 4. validate.
    if (!pending.validated) {
      task.progress('validate', null)
      await validate(yaml.text, fileNameOf(playerName, game))
      pending.validated = true
    }
    throwIfCancelled(task.signal)

    // 5. deliver.
    task.progress('deliver', null)
    const delivery = await deliver(pending, input.destination, playerName, yaml.text)
    const outcome: ReadyOutcome = {
      game,
      profile: yaml.profile,
      checks: yaml.checks,
      ...delivery,
      restartNeeded: pending.installedWorld && (await isApRunning()),
      refinementFailed: yaml.refinementFailed,
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
      // The index says it does not work with this Archipelago: nothing is prepared from it, even
      // when it was installed by hand.
      if (entry.disabledByIndex) {
        throw new AppError(
          'WORLD_RELEASE_UNAVAILABLE',
          { reason: 'disabled-by-index', url: entry.wiki?.url ?? '' },
          { detail: entryId },
        )
      }
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
