// « Jeu prêt » (spec §3.7, §4): one dialog from a catalog entry to a player YAML delivered. It asks
// for a plan (ready:prepare, which changes nothing), shows what the run will do — the world's trust as
// its tier needs it, the profile with its checks and changes, the player's name, where the YAML goes —
// and its main button runs it (ready:run, a `ready` task): the progress, then « Prêt ! » with what to
// do next and what to know. A run that fails keeps its plan: Réessayer goes on from the failed step.
import {
  IconBook2,
  IconDeviceFloppy,
  IconDisc,
  IconExternalLink,
  IconFileCode,
  IconFolderOpen,
  IconMap2,
  IconPlayerPlayFilled,
  IconPlayerStop,
  IconRefresh,
  IconRosetteDiscountCheck,
  IconRotateClockwise,
  IconUser,
  IconUsersGroup,
  IconWand,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toAppErrorData, type AppErrorData } from '@shared/errors'
import { isAllowedExternalUrl } from '@shared/external-url'
import type { ChannelInput } from '@shared/ipc/contract'
import type {
  AppConfig,
  CatalogEntry,
  GameProfile,
  ProfileId,
  ReadyDestination,
  ReadyOutcome,
  ReadyPlan,
  TaskProgress,
  TrustTier,
} from '@shared/types'
import {
  Badge,
  ErrorPanel,
  Modal,
  NeonButton,
  ProgressBar,
  Segmented,
  Select,
  StatusPill,
  Toggle,
  TrustBadge,
  useToast,
  type Status,
  type Tone,
} from '../../design/components'
import { sfx } from '../../design/sfx'
import { useIpcMutation } from '../../hooks/useIpc'
import { useTask } from '../../hooks/useTask'
import { useWorldInstall, WORLD_QUERIES } from '../../hooks/useWorldInstall'
import { describeError } from '../../lib/errors'
import { invoke } from '../../lib/goat'
import { optionValueText, profileChecksText } from '../../lib/option-text'
import { stageLabel } from '../../lib/task-stages'
import { useConfig } from '../../stores/config'
import { PixelConfetti } from '../session/PixelConfetti'
import { fileNamePart } from '../studio/editor-ops'
import { deliveredDraft, isDirty, keepDraft, keptDraft } from '../studio/studio-draft'
import { GameCover } from './GameCover'
import { parentDir } from './model'
import { readyDialogOpened } from './ready-runs'
import { CodeWarning, ReleaseUnavailableActions, TIER_TONE } from './TrustDialog'
import { useErrorToast } from './useErrorToast'
import './ReadyDialog.css'

/** One opening of the dialog: each one asks for a fresh plan, even for the same entry. */
export interface ReadyRequest {
  id: number
  entry: CatalogEntry
}

export interface ReadyDialogProps {
  request: ReadyRequest | null
  onClose: () => void
}

type RunInput = ChannelInput<'ready:run'>
type DestinationKind = AppConfig['readyDestination']

/** Archipelago's slot name limit (the main process refuses longer names). */
const MAX_PLAYER_NAME = 16
/** The value of the session list's "new session" option (session ids are UUIDs). */
const NEW_SESSION = '+new'
const PROFILE_ORDER: readonly ProfileId[] = ['discovery', 'standard', 'complete']
/** The stages of the world's install, one step on the dialog's track. */
const INSTALL_STAGES: ReadonlySet<string> = new Set(['download', 'inspect', 'install'])
const STEPS = ['install', 'templates', 'profile', 'validate', 'deliver'] as const
type Step = (typeof STEPS)[number]
/** How the head says whether the world is there. */
const STATE_PILL = { toInstall: 'info', installed: 'ok', update: 'warn' } as const satisfies Record<
  string,
  Status
>
type WorldState = keyof typeof STATE_PILL

interface Choices {
  profile: ProfileId
  playerName: string
  destination: DestinationKind
  /** The session picked, or NEW_SESSION. */
  sessionId: string
  newSessionName: string
  update: boolean
  consent: boolean
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'unprepared'; error: AppErrorData }
  | { kind: 'form' }
  | { kind: 'starting' }
  | { kind: 'running'; taskId: string }
  | { kind: 'failed'; error: AppErrorData }
  | { kind: 'done'; outcome: ReadyOutcome }

interface Flow {
  requestId: number
  entry: CatalogEntry
  plan: ReadyPlan | null
  choices: Choices
  phase: Phase
  /** What the last run was asked: Réessayer asks it again. */
  lastRun: RunInput | null
  /**
   * The catalog told another trust when the world was downloaded than when the plan was made: the
   * full warning and its consent show whatever the plan's tier.
   */
  forceConsent: boolean
}

/** The run installs a world: one not installed yet, or the catalog's later version. Never a core one. */
const installs = (plan: ReadyPlan, update: boolean): boolean =>
  plan.trust !== 'core' && (!plan.installed || (plan.updateAvailable && update))

const destinationKind = (destination: ReadyDestination): DestinationKind =>
  destination.kind === 'new-session' ? 'session' : destination.kind

/** The profiles to pick from: the game's, else all three while it has no schema yet (Ruling 26). */
function offeredProfiles(plan: ReadyPlan): { id: ProfileId; profile: GameProfile | null }[] {
  const { profiles } = plan.profiles
  return profiles.length > 0
    ? profiles.map((profile) => ({ id: profile.id, profile }))
    : PROFILE_ORDER.map((id) => ({ id, profile: null }))
}

/** `t` for the dialog's own texts (`screens.worlds.ready.*`). */
function useReadyText(): (key: string, options?: Record<string, unknown>) => string {
  const { t } = useTranslation()
  return (key, options) => t(`screens.worlds.ready.${key}`, options)
}

/** The step of the track a stage belongs to; the length of `steps` once done. */
function stepIndex(steps: readonly Step[], stage: string | undefined): number {
  if (stage === undefined) return -1
  if (stage === 'done') return steps.length
  return steps.indexOf((INSTALL_STAGES.has(stage) ? 'install' : stage) as Step)
}

export function ReadyDialog({ request, onClose }: ReadyDialogProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const r = useReadyText()
  const navigate = useNavigate()
  const toast = useToast()
  const showError = useErrorToast()
  const queryClient = useQueryClient()
  const config = useConfig()
  const worldInstall = useWorldInstall()
  const openPath = useIpcMutation('app:openPath', { onError: showError })
  const openExternal = useIpcMutation('app:openExternal', { onError: showError })
  const [flow, setFlow] = useState<Flow | null>(null)
  /** A file picked by hand goes through the trust screen, which shows instead of this dialog. */
  const [installingFile, setInstallingFile] = useState(false)
  const handled = useRef(new Set<string>())

  // The flow of the opening on screen; while it closes, the last one stays as it was.
  const current = flow && (request === null || flow.requestId === request.id) ? flow : null
  const entry = request?.entry ?? flow?.entry ?? null
  const phase: Phase = current?.phase ?? { kind: 'loading' }
  const plan = current?.plan ?? null
  const lastRun = current?.lastRun ?? null

  const update = useCallback((requestId: number, change: (flow: Flow) => Partial<Flow>): void => {
    setFlow((previous) =>
      previous?.requestId === requestId ? { ...previous, ...change(previous) } : previous,
    )
  }, [])

  /** What a first plan starts from: Standard, the name and the destination of the last run. */
  const firstChoices = (fresh: ReadyPlan): Choices => ({
    profile: offeredProfiles(fresh).some(({ id }) => id === 'standard') ? 'standard' : 'discovery',
    playerName: config.playerName,
    destination: config.readyDestination,
    sessionId: fresh.sessions[0]?.id ?? NEW_SESSION,
    newSessionName: t('screens.session.new.defaultName', {
      date: new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'long' }).format(new Date()),
    }),
    update: false,
    consent: false,
  })
  const prepared = useEffectEvent((requestId: number, fresh: ReadyPlan): void =>
    update(requestId, () => ({ plan: fresh, choices: firstChoices(fresh), phase: { kind: 'form' } })),
  )

  // Each opening: a plan of its own (an answer that comes after the dialog closed is dropped).
  useEffect(() => {
    if (!request) return
    const { id, entry: opened } = request
    let live = true
    setFlow({
      requestId: id,
      entry: opened,
      plan: null,
      choices: {
        profile: 'standard',
        playerName: '',
        destination: 'session',
        sessionId: NEW_SESSION,
        newSessionName: '',
        update: false,
        consent: false,
      },
      phase: { kind: 'loading' },
      lastRun: null,
      forceConsent: false,
    })
    invoke('ready:prepare', { entryId: opened.id }).then(
      (fresh) => {
        if (live) prepared(id, fresh)
      },
      (error: unknown) => {
        if (live) update(id, () => ({ phase: { kind: 'unprepared', error: toAppErrorData(error) } }))
      },
    )
    // The dialog's own end screen tells how a run ends: no toast meanwhile (useTaskEndToasts).
    const closed = readyDialogOpened()
    return () => {
      live = false
      closed()
    }
  }, [request, update])

  /** A new plan for the entry (after a refusal, an install by hand, a plan that failed); null if none. */
  const prepareAgain = async (requestId: number, entryId: string): Promise<ReadyPlan | null> => {
    update(requestId, () => ({ phase: { kind: 'loading' } }))
    try {
      return await invoke('ready:prepare', { entryId })
    } catch (error) {
      update(requestId, () => ({ phase: { kind: 'unprepared', error: toAppErrorData(error) } }))
      return null
    }
  }

  const run = async (requestId: number, input: RunInput): Promise<void> => {
    update(requestId, () => ({ phase: { kind: 'starting' }, lastRun: input }))
    try {
      const { taskId } = await invoke('ready:run', input)
      update(requestId, () => ({ phase: { kind: 'running', taskId } }))
    } catch (error) {
      update(requestId, () => ({ phase: { kind: 'failed', error: toAppErrorData(error) } }))
    }
  }

  const willInstall = plan !== null && current !== null && installs(plan, current.choices.update)
  const consentShown =
    willInstall && plan !== null && (plan.needsTrustConsent || (current?.forceConsent ?? false))
  const canStart =
    plan !== null &&
    current !== null &&
    (!consentShown || current.choices.consent) &&
    (current.choices.destination !== 'session' ||
      current.choices.sessionId !== NEW_SESSION ||
      current.choices.newSessionName.trim() !== '')

  const start = async (): Promise<void> => {
    if (!current || !plan) return
    const { requestId, choices } = current
    const playerName = choices.playerName.trim()
    let destination: ReadyDestination
    if (choices.destination === 'file') {
      update(requestId, () => ({ phase: { kind: 'starting' } }))
      let path: string | null
      try {
        path = await invoke('app:savePath', {
          defaultName: `${fileNamePart(playerName) || 'Player'} - ${fileNamePart(plan.game)}.yaml`,
          filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
        })
      } catch (error) {
        showError(error)
        path = null
      }
      // Cancelled: nothing runs, the choices stay.
      if (path === null) {
        update(requestId, () => ({ phase: { kind: 'form' } }))
        return
      }
      destination = { kind: 'file', path }
    } else if (choices.destination === 'studio') {
      destination = { kind: 'studio' }
    } else {
      destination =
        choices.sessionId === NEW_SESSION
          ? { kind: 'new-session', name: choices.newSessionName.trim() }
          : { kind: 'session', sessionId: choices.sessionId }
    }
    await run(requestId, {
      planId: plan.planId,
      profile: choices.profile,
      playerName,
      destination,
      update: plan.updateAvailable && choices.update,
      trustAccepted: consentShown && choices.consent,
    })
  }

  const succeed = useEffectEvent((outcome: ReadyOutcome): void => {
    if (!current?.lastRun) return
    const { requestId, lastRun } = current
    config
      .set({ playerName: lastRun.playerName, readyDestination: destinationKind(lastRun.destination) })
      .catch(() => undefined)
    if (plan && installs(plan, lastRun.update)) {
      for (const name of WORLD_QUERIES) void queryClient.invalidateQueries({ queryKey: [name] })
    }
    if (outcome.delivered.kind !== 'studio') {
      sfx.play('success')
      update(requestId, () => ({ phase: { kind: 'done', outcome } }))
      return
    }
    // The Studio gets the text: it opens on it as a new YAML, not saved yet (Ruling 29).
    invoke('studio:parse', { text: outcome.text }).then(
      ({ docs }) => {
        keepDraft(deliveredDraft(keptDraft(), docs))
        toast.push({ tone: 'ok', title: r('done.studio', { game: outcome.game }) })
        onClose()
        void navigate('/studio')
      },
      (error: unknown) =>
        update(requestId, () => ({ phase: { kind: 'failed', error: toAppErrorData(error) } })),
    )
  })

  const fail = useEffectEvent((error: AppErrorData): void => {
    if (!current) return
    const { requestId, entry: failed } = current
    if (error.code === 'INVALID_INPUT' && error.params?.reason === 'trust') {
      // Not a failure: the world turned out to need the consent its plan did not ask for.
      void prepareAgain(requestId, failed.id).then((fresh) => {
        if (fresh === null) return
        update(requestId, (previous) => ({
          plan: fresh,
          forceConsent: true,
          choices: { ...previous.choices, consent: false },
          phase: { kind: 'form' },
        }))
      })
      return
    }
    // The plan expired (it lives an hour) or main no longer knows it: a new one runs the same choices
    // (Ruling 30), unless it needs a consent the last run was not given, which is then asked.
    const { lastRun: expired } = current
    if (error.code === 'NOT_FOUND' && expired !== null && error.detail === expired.planId) {
      void prepareAgain(requestId, failed.id).then((fresh) => {
        if (fresh === null) return
        if (installs(fresh, expired.update) && fresh.needsTrustConsent && !expired.trustAccepted) {
          update(requestId, (previous) => ({
            plan: fresh,
            choices: { ...previous.choices, consent: false },
            phase: { kind: 'form' },
          }))
          return
        }
        update(requestId, () => ({ plan: fresh }))
        void run(requestId, {
          ...expired,
          planId: fresh.planId,
          update: expired.update && fresh.updateAvailable,
        })
      })
      return
    }
    // Stopped by the user: back to the choices; the same plan, run again, goes on from where it stopped.
    if (error.code === 'TASK_CANCELLED') {
      update(requestId, () => ({ phase: { kind: 'form' } }))
      return
    }
    update(requestId, () => ({ phase: { kind: 'failed', error } }))
  })

  const runningTaskId = phase.kind === 'running' ? phase.taskId : null
  const task = useTask(runningTaskId)
  useEffect(() => {
    if (runningTaskId === null || handled.current.has(runningTaskId)) return
    if (task.status === 'done') {
      handled.current.add(runningTaskId)
      succeed(task.result as ReadyOutcome)
    } else if (task.status === 'failed') {
      handled.current.add(runningTaskId)
      fail(task.error ?? { code: 'AP_UNKNOWN' })
    }
  }, [runningTaskId, task.status, task.result, task.error])

  /**
   * No release the catalog can fetch: the file the player downloaded goes through the trust screen,
   * then a new plan (which finds the world installed) runs the same choices.
   */
  const installFile = async (): Promise<void> => {
    if (!current?.lastRun) return
    const { requestId, entry: target, lastRun } = current
    let paths: string[]
    try {
      paths = await invoke('app:pickPaths', {
        mode: 'file',
        title: t('worldInstall.pickFileTitle'),
        filters: [{ name: 'APWorld', extensions: ['apworld'] }],
      })
    } catch (error) {
      showError(error)
      return
    }
    const [path] = paths
    if (path === undefined) return
    setInstallingFile(true)
    const { installed } = await worldInstall.start({ kind: 'file', path })
    setInstallingFile(false)
    if (!installed) return
    const fresh = await prepareAgain(requestId, target.id)
    if (fresh === null) return
    update(requestId, () => ({ plan: fresh }))
    await run(requestId, { ...lastRun, planId: fresh.planId, update: false, trustAccepted: false })
  }

  // Each new step takes the focus (its heading, or its panel), so that the keyboard stays in the
  // dialog when the controls it was on go away, and the step is read out. The first choices keep it
  // where the dialog put it on opening; the waits (a plan, a run starting) leave it as it is.
  const panelRef = useRef<HTMLDivElement>(null)
  const shownStep = useRef<{ requestId: number; kind: Phase['kind']; formSeen: boolean } | null>(null)
  useEffect(() => {
    if (!current) return
    const previous = shownStep.current?.requestId === current.requestId ? shownStep.current : null
    shownStep.current = {
      requestId: current.requestId,
      kind: phase.kind,
      formSeen: (previous?.formSeen ?? false) || phase.kind === 'form',
    }
    if (previous === null || previous.kind === phase.kind) return
    if (phase.kind === 'loading' || phase.kind === 'starting') return
    if (phase.kind === 'form' && !previous.formSeen) return
    const panel = panelRef.current
    ;(panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel)?.focus()
  }, [current, phase.kind])

  const change = (patch: Partial<Choices>): void => {
    if (current) update(current.requestId, (previous) => ({ choices: { ...previous.choices, ...patch } }))
  }

  const leaveTo = (to: string): void => {
    onClose()
    void navigate(to)
  }

  const busy = phase.kind === 'starting' || phase.kind === 'running'
  // Whether the world is there: as planned, then as the run left it (installed, updated if asked).
  const worldState: WorldState | null = !plan
    ? null
    : phase.kind !== 'done' && !plan.installed
      ? 'toInstall'
      : plan.updateAvailable && !(phase.kind === 'done' && lastRun?.update === true)
        ? 'update'
        : 'installed'
  const tone: Tone =
    phase.kind === 'done'
      ? 'green'
      : phase.kind === 'failed' || phase.kind === 'unprepared'
        ? 'pink'
        : plan
          ? TIER_TONE[plan.trust]
          : 'violet'

  return (
    <>
      <Modal
        open={request !== null && !installingFile}
        onClose={onClose}
        dismissible={!busy}
        closeLabel={t('common.closeDialog')}
        tone={tone}
        size="lg"
        eyebrow={r('eyebrow')}
        title={entry ? r('title', { game: entry.displayName }) : ''}
        footer={
          <Footer
            phase={phase}
            plan={plan}
            willInstall={willInstall}
            canStart={canStart}
            onClose={onClose}
            onStart={() => void start()}
            onStop={() => {
              if (runningTaskId) void invoke('tasks:cancel', { taskId: runningTaskId }).catch(() => undefined)
            }}
            onInstallAp={() => leaveTo('/install')}
            onOpenSession={(sessionId) => leaveTo(`/session/${sessionId}?step=1`)}
            onOpenFolder={(path) => openPath.mutate({ path: parentDir(path) })}
            onOpenInStudio={(path) => leaveTo(`/studio?${new URLSearchParams({ open: path }).toString()}`)}
          />
        }
      >
        {entry && (
          <div className="ready-dialog">
            <ReadyHead entry={entry} trust={plan?.trust ?? entry.trust} state={worldState} />
            <div ref={panelRef} tabIndex={-1} className="ready-dialog__panel">
              {phase.kind === 'loading' && (
                <ProgressBar percent={null} label={r('loading')} segments={16} tone="violet" />
              )}
              {phase.kind === 'unprepared' && current && (
                <Failure
                  error={phase.error}
                  title={r('planFailed')}
                  onRetry={() => {
                    const { requestId, entry: target } = current
                    void prepareAgain(requestId, target.id).then((fresh) => {
                      if (fresh === null) return
                      update(requestId, (previous) => ({
                        plan: fresh,
                        // A first plan that failed left no choices to keep.
                        choices: previous.plan === null ? firstChoices(fresh) : previous.choices,
                        phase: { kind: 'form' },
                      }))
                    })
                  }}
                />
              )}
              {plan && current && (phase.kind === 'form' || phase.kind === 'starting') && (
                <>
                  {!plan.apInstalled ? (
                    <NoArchipelago />
                  ) : (
                    <ReadyForm
                      entry={current.entry}
                      plan={plan}
                      choices={current.choices}
                      willInstall={willInstall}
                      consentShown={consentShown}
                      trustChanged={current.forceConsent}
                      disabled={busy}
                      onChange={change}
                    />
                  )}
                </>
              )}
              {phase.kind === 'running' && (
                <RunProgress
                  progress={task.progress}
                  installing={plan !== null && lastRun !== null && installs(plan, lastRun.update)}
                />
              )}
              {phase.kind === 'failed' && current && lastRun && (
                <Failure
                  error={phase.error}
                  onRetry={() => void run(current.requestId, lastRun)}
                  onPickFile={() => void installFile()}
                  onNavigate={leaveTo}
                />
              )}
              {phase.kind === 'done' && (
                <ReadyClear
                  outcome={phase.outcome}
                  plan={plan}
                  lastRun={lastRun}
                  onOpenVault={() => leaveTo('/vault')}
                  onOpenGuide={(url) => openExternal.mutate({ url })}
                />
              )}
            </div>
          </div>
        )}
      </Modal>
      {worldInstall.dialog}
    </>
  )
}

/** The cover, where the world comes from, its trust and whether it is installed. */
function ReadyHead({
  entry,
  trust,
  state,
}: {
  entry: CatalogEntry
  trust: TrustTier
  /** Null while there is no plan. */
  state: WorldState | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const r = useReadyText()
  const version = entry.latest
    ? t('screens.worlds.catalog.version', { version: entry.latest.version })
    : entry.download?.kind === 'github-latest'
      ? t('screens.worlds.catalog.latestRelease')
      : null
  return (
    <div className="ready-head">
      <GameCover game={entry.game} size="lg" className="ready-head__cover" />
      <div className="ready-head__facts">
        <div className="ready-head__badges">
          <TrustBadge
            tier={trust}
            label={t(`trust.${trust}.label`)}
            description={t(`trust.${trust}.description`)}
          />
          <Badge tone="neutral" outline icon={entry.source === 'wiki' ? <IconBook2 /> : <IconFileCode />}>
            {t(`screens.worlds.catalog.sources.${entry.source}`)}
          </Badge>
        </div>
        {version && <p className="ready-head__version">{version}</p>}
        {state && <StatusPill status={STATE_PILL[state]} label={r(`state.${state}`)} />}
      </div>
    </div>
  )
}

function NoArchipelago(): React.JSX.Element {
  const r = useReadyText()
  return (
    <div className="ready-noap pixel-border tone-yellow">
      <p className="ready-noap__title">{r('noAp.title')}</p>
      <p className="ready-noap__body">{r('noAp.body')}</p>
    </div>
  )
}

interface ReadyFormProps {
  entry: CatalogEntry
  plan: ReadyPlan
  choices: Choices
  willInstall: boolean
  consentShown: boolean
  trustChanged: boolean
  disabled: boolean
  onChange: (patch: Partial<Choices>) => void
}

function ReadyForm({
  entry,
  plan,
  choices,
  willInstall,
  consentShown,
  trustChanged,
  disabled,
  onChange,
}: ReadyFormProps): React.JSX.Element {
  const { t } = useTranslation()
  const r = useReadyText()
  const profileHeadingId = useId()
  const nameId = useId()
  const newNameId = useId()
  const offered = offeredProfiles(plan)
  const picked = offered.find(({ id }) => id === choices.profile)?.profile ?? null
  // Unsaved work in the Studio would be replaced by this YAML.
  const studioDirty = choices.destination === 'studio' && isDirty(keptDraft())

  return (
    <fieldset className="ready-form" disabled={disabled}>
      {willInstall && consentShown && (
        <div className="ready-trust">
          {trustChanged && (
            <p className="ready-notice tone-yellow" role="status" tabIndex={-1} data-autofocus>
              {r('trust.changed')}
            </p>
          )}
          <p className="ready-trust__tier">{t(`trust.${plan.trust}.description`)}</p>
          <CodeWarning acked={choices.consent} onAck={(consent) => onChange({ consent })} />
        </div>
      )}
      {willInstall && !consentShown && plan.trust === 'indexed-verified' && (
        <p className="ready-trust-line">
          <IconRosetteDiscountCheck aria-hidden="true" />
          <span>{r('trust.verified')}</span>
        </p>
      )}

      <section className="ready-section" aria-labelledby={profileHeadingId}>
        <h3 id={profileHeadingId} className="ready-section__title">
          {r('profile.label')}
        </h3>
        <Segmented<ProfileId>
          className="ready-profiles"
          label={r('profile.label')}
          value={choices.profile}
          onChange={(profile) => onChange({ profile })}
          options={offered.map(({ id, profile }) => ({
            value: id,
            label: (
              <span className="ready-profile">
                <span className="ready-profile__name">{t(`profiles.names.${id}`)}</span>
                {profile && (
                  <span
                    className="ready-profile__checks"
                    data-measured={profile.checks !== null || undefined}
                  >
                    {profileChecksText(profile, t)}
                  </span>
                )}
              </span>
            ),
          }))}
        />
        {picked === null ? (
          <p className="ready-section__hint">{r('profile.afterInstall')}</p>
        ) : picked.changes.length === 0 ? (
          <p className="ready-section__hint">{t('profiles.noChanges')}</p>
        ) : (
          <ul className="ready-changes" aria-label={r('profile.changes')}>
            {picked.changes.map(({ key, from, to }) => (
              <li key={key}>
                {t('profiles.change', { key, from: optionValueText(from), to: optionValueText(to) })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="ready-grid">
        <div className="field">
          <label htmlFor={nameId} className="field__label">
            {r('name.label')}
          </label>
          <div className="input-frame pixel-border tone-yellow">
            <IconUser className="ready-field__icon" aria-hidden="true" />
            <input
              id={nameId}
              className="input"
              value={choices.playerName}
              maxLength={MAX_PLAYER_NAME}
              placeholder="Player{number}"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${nameId}-hint`}
              onChange={(event) => onChange({ playerName: event.target.value })}
            />
          </div>
          <span id={`${nameId}-hint`} className="field__hint">
            {r('name.hint')}
          </span>
        </div>

        <div className="field ready-destination">
          {/* The radio group is named by its aria-label: this visible copy is not read twice. */}
          <span className="field__label" aria-hidden="true">
            {r('destination.label')}
          </span>
          <Segmented<DestinationKind>
            label={r('destination.label')}
            value={choices.destination}
            onChange={(destination) => onChange({ destination })}
            options={[
              {
                value: 'session',
                label: r('destination.session'),
                icon: <IconUsersGroup aria-hidden="true" />,
              },
              { value: 'file', label: r('destination.file'), icon: <IconDeviceFloppy aria-hidden="true" /> },
              { value: 'studio', label: r('destination.studio'), icon: <IconWand aria-hidden="true" /> },
            ]}
          />
          {choices.destination === 'session' && (
            <>
              <Select
                label={r('destination.pickSession')}
                hideLabel
                value={choices.sessionId}
                onChange={(sessionId) => onChange({ sessionId })}
                options={[
                  ...plan.sessions.map(({ id, name }) => ({ value: id, label: name })),
                  { value: NEW_SESSION, label: r('destination.newSession') },
                ]}
              />
              {choices.sessionId === NEW_SESSION && (
                <div className="input-frame pixel-border tone-yellow">
                  <label htmlFor={newNameId} className="sr-only">
                    {r('destination.newName')}
                  </label>
                  <input
                    id={newNameId}
                    className="input"
                    value={choices.newSessionName}
                    maxLength={80}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={r('destination.newName')}
                    onChange={(event) => onChange({ newSessionName: event.target.value })}
                  />
                </div>
              )}
            </>
          )}
          {choices.destination === 'file' && <span className="field__hint">{r('destination.fileHint')}</span>}
          {choices.destination === 'studio' && (
            <span className="field__hint">{r('destination.studioHint')}</span>
          )}
          {studioDirty && (
            <p className="ready-notice tone-yellow" role="status">
              {r('destination.studioDirty')}
            </p>
          )}
        </div>
      </div>

      {plan.updateAvailable && (
        <Toggle
          tone="cyan"
          checked={choices.update}
          onChange={(checked) => onChange({ update: checked })}
          label={r('update', { version: entry.latest?.version ?? '' })}
          description={r('updateHint', { version: entry.installedVersion ?? '' })}
        />
      )}
    </fieldset>
  )
}

/** The life bar of the task, with the step it is at on the track below. */
function RunProgress({
  progress,
  installing,
}: {
  progress: TaskProgress | null
  installing: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const r = useReadyText()
  const steps = installing ? STEPS : STEPS.filter((step) => step !== 'install')
  const at = stepIndex(steps, progress?.stage)
  return (
    <div className="ready-run pixel-border tone-violet">
      <h3 className="ready-run__title" tabIndex={-1} data-autofocus>
        {r('running.title')}
      </h3>
      <ProgressBar
        percent={progress?.percent ?? null}
        label={stageLabel(progress, t) ?? r('running.waiting')}
        segments={24}
        tone="violet"
        className="ready-run__bar"
      />
      <ol className="ready-steps" aria-hidden="true">
        {steps.map((step, index) => (
          <li
            key={step}
            className="ready-steps__step"
            data-state={index < at ? 'done' : index === at ? 'current' : 'todo'}
          >
            <span className="ready-steps__dot" />
            {r(`running.steps.${step}`)}
          </li>
        ))}
      </ol>
    </div>
  )
}

interface FailureProps {
  error: AppErrorData
  /** Instead of the error's own title. */
  title?: string
  onRetry: () => void
  onPickFile?: () => void
  onNavigate?: (to: string) => void
}

function Failure({ error, title, onRetry, onPickFile, onNavigate }: FailureProps): React.JSX.Element {
  const { t } = useTranslation()
  const described = describeError(error, t)
  // A release to download by hand: retrying alone would fail the same way, the page and the file come first.
  const unavailable = error.code === 'WORLD_RELEASE_UNAVAILABLE'
  const { action } = described
  return (
    <ErrorPanel
      title={title ?? described.title}
      body={title === undefined ? described.body : `${described.title}. ${described.body}`}
      detail={described.detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        <>
          <NeonButton
            variant={unavailable ? 'secondary' : 'primary'}
            size="sm"
            icon={<IconRefresh />}
            onClick={onRetry}
          >
            {t('common.retry')}
          </NeonButton>
          {unavailable && <ReleaseUnavailableActions page={error.params?.url} onPickFile={onPickFile} />}
          {!unavailable && action?.to !== undefined && onNavigate && (
            <NeonButton variant="secondary" size="sm" onClick={() => onNavigate(action.to ?? '/')}>
              {t(action.labelKey)}
            </NeonButton>
          )}
        </>
      }
    />
  )
}

interface ReadyClearProps {
  outcome: ReadyOutcome
  plan: ReadyPlan | null
  lastRun: RunInput | null
  onOpenVault: () => void
  onOpenGuide: (url: string) => void
}

/** « Prêt ! »: what was made and where it went, then what to know before playing. */
function ReadyClear({
  outcome,
  plan,
  lastRun,
  onOpenVault,
  onOpenGuide,
}: ReadyClearProps): React.JSX.Element {
  const { t } = useTranslation()
  const r = useReadyText()
  const notesId = useId()
  const [confetti, setConfetti] = useState(true)
  const { delivered } = outcome
  const checks =
    outcome.checks === null ? r('done.unmeasured') : t('profiles.checks', { count: outcome.checks })

  let where: ReactNode = null
  if (delivered.kind === 'session') {
    const name =
      plan?.sessions.find((session) => session.id === delivered.sessionId)?.name ??
      (lastRun?.destination.kind === 'new-session' ? lastRun.destination.name : null)
    where = name === null ? r('done.sessionUnnamed') : r('done.session', { name })
  } else if (delivered.kind === 'file') {
    where = (
      <>
        {r('done.file')} <code className="ready-clear__path">{delivered.path}</code>
      </>
    )
  }

  const notes = plan?.notes
  const setupUrl = notes?.setupUrl ?? null
  const items: { key: string; icon: ReactNode; title: string; body: string; action?: ReactNode }[] = []
  if (notes?.romRequired)
    items.push({
      key: 'rom',
      icon: <IconDisc />,
      title: r('notes.rom'),
      body: r('notes.romBody', { game: outcome.game }),
      action: (
        <NeonButton variant="secondary" size="sm" onClick={onOpenVault}>
          {r('notes.romAction')}
        </NeonButton>
      ),
    })
  if (notes?.popTracker)
    items.push({
      key: 'poptracker',
      icon: <IconMap2 />,
      title: r('notes.popTracker'),
      body: r('notes.popTrackerBody'),
    })
  if (setupUrl !== null && isAllowedExternalUrl(setupUrl))
    items.push({
      key: 'guide',
      icon: <IconBook2 />,
      title: r('notes.guide'),
      body: r('notes.guideBody', { game: outcome.game }),
      action: (
        <NeonButton
          variant="ghost"
          size="sm"
          icon={<IconExternalLink />}
          onClick={() => onOpenGuide(setupUrl)}
        >
          {r('notes.guideAction')}
        </NeonButton>
      ),
    })
  if (outcome.restartNeeded || notes?.apRunning)
    items.push({
      key: 'restart',
      icon: <IconRotateClockwise />,
      title: r('notes.restart'),
      body: r(outcome.restartNeeded ? 'notes.restartBody' : 'notes.runningBody', { game: outcome.game }),
    })

  return (
    <>
      <div className="ready-clear pixel-border tone-green">
        {confetti && <PixelConfetti overDialogs onDone={() => setConfetti(false)} />}
        <span className="ready-clear__eyebrow t-display" aria-hidden="true">
          {r('done.eyebrow')}
        </span>
        <h3 className="ready-clear__title" tabIndex={-1} data-autofocus>
          {r('done.title')}
        </h3>
        <p className="ready-clear__summary">
          {r('done.summary', { profile: t(`profiles.names.${outcome.profile}`), checks })}
        </p>
        {where !== null && <p className="ready-clear__where">{where}</p>}
      </div>
      {items.length > 0 && (
        <section className="ready-notes" aria-labelledby={notesId}>
          <h3 id={notesId} className="ready-section__title">
            {r('notes.title')}
          </h3>
          <ul className="ready-notes__list">
            {items.map(({ key, icon, title, body, action }) => (
              <li key={key} className="ready-note" data-note={key}>
                <span className="ready-note__icon" aria-hidden="true">
                  {icon}
                </span>
                <div className="ready-note__text">
                  <p className="ready-note__title">{title}</p>
                  <p className="ready-note__body">{body}</p>
                </div>
                {action}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

interface FooterProps {
  phase: Phase
  plan: ReadyPlan | null
  willInstall: boolean
  canStart: boolean
  onClose: () => void
  onStart: () => void
  onStop: () => void
  onInstallAp: () => void
  onOpenSession: (sessionId: string) => void
  onOpenFolder: (path: string) => void
  onOpenInStudio: (path: string) => void
}

function Footer({
  phase,
  plan,
  willInstall,
  canStart,
  onClose,
  onStart,
  onStop,
  onInstallAp,
  onOpenSession,
  onOpenFolder,
  onOpenInStudio,
}: FooterProps): React.JSX.Element {
  const { t } = useTranslation()
  const r = useReadyText()

  if (phase.kind === 'running') {
    return (
      <NeonButton variant="danger" icon={<IconPlayerStop />} onClick={onStop}>
        {r('running.stop')}
      </NeonButton>
    )
  }
  if (phase.kind === 'done') {
    const { delivered } = phase.outcome
    return (
      <>
        <NeonButton variant="ghost" onClick={onClose}>
          {t('common.close')}
        </NeonButton>
        {delivered.kind === 'session' && (
          <NeonButton icon={<IconUsersGroup />} onClick={() => onOpenSession(delivered.sessionId)}>
            {r('done.openSession')}
          </NeonButton>
        )}
        {delivered.kind === 'file' && (
          <>
            <NeonButton
              variant="secondary"
              icon={<IconWand />}
              onClick={() => onOpenInStudio(delivered.path)}
            >
              {r('done.openInStudio')}
            </NeonButton>
            <NeonButton icon={<IconFolderOpen />} onClick={() => onOpenFolder(delivered.path)}>
              {r('done.openFolder')}
            </NeonButton>
          </>
        )}
      </>
    )
  }
  const formShown = (phase.kind === 'form' || phase.kind === 'starting') && plan !== null
  return (
    <>
      <NeonButton variant="ghost" onClick={onClose} disabled={phase.kind === 'starting'}>
        {formShown ? t('common.cancel') : t('common.close')}
      </NeonButton>
      {formShown &&
        (plan.apInstalled ? (
          <NeonButton
            icon={<IconPlayerPlayFilled />}
            disabled={!canStart}
            loading={phase.kind === 'starting'}
            loadingLabel={r('starting')}
            onClick={onStart}
          >
            {willInstall ? r('installAndPrepare') : r('prepare')}
          </NeonButton>
        ) : (
          <NeonButton onClick={onInstallAp}>{r('noAp.action')}</NeonButton>
        ))}
    </>
  )
}
