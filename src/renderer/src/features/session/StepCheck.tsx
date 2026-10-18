// Step 2: what stops the game from generating, with a fix next to each problem: install a missing
// world, rename a player, provide a ROM, or fix the YAML in the Studio. Next stays locked while the
// validation is blocking, and says why. The Checks panel below tells how long each player's game will be.
import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconCircleCheck,
  IconDisc,
  IconDownload,
  IconExternalLink,
  IconFileCode,
  IconFileUpload,
  IconPencil,
  IconRefresh,
  IconUsers,
  IconWorld,
} from '@tabler/icons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { IssueCode } from '@shared/codes'
import type { Issue, PlayerDoc, RomNeed, Session, SessionValidation, WorldSource } from '@shared/types'
import {
  Badge,
  ErrorPanel,
  NeonButton,
  PixelPanel,
  Spinner,
  StatTile,
  StatusPill,
  useToast,
  type Status,
  type Tone,
} from '../../design/components'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { useWorldInstall, type WorldInstall } from '../../hooks/useWorldInstall'
import { describeError } from '../../lib/errors'
import { ChecksPanel } from './ChecksPanel'
import { PlayerGames } from './PlayerGames'
import { RenameDialog, type RenameTarget } from './RenameDialog'
import { StepNav } from './StepNav'
import { studioLink } from './steps'
import './StepCheck.css'

/** Issues a new name fixes. */
const RENAME_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>(['name-duplicate', 'name-too-long'])
/** Counted once, as a missing world, rather than once per player of that game. */
const COUNTED_AS_WORLD: IssueCode = 'game-not-installed'

interface DocReport {
  doc: PlayerDoc
  /** Its own issues, plus the session's duplicate-name issue when it wears that name. */
  issues: Issue[]
}

interface FileReport {
  fileId: string
  name: string
  docs: DocReport[]
  multiDoc: boolean
}

interface Report {
  /** Files with something to fix or look at. */
  files: FileReport[]
  okFiles: number
  /** Session issues no player row shows. */
  sessionIssues: Issue[]
  players: number
  errors: number
  warnings: number
  romsNeeded: number
}

/** The names (lower case) a session-level `name-duplicate` points at. */
function duplicatedNames(validation: SessionValidation): Set<string> {
  const flagged = validation.sessionIssues.filter((issue) => issue.code === 'name-duplicate')
  if (flagged.length === 0) return new Set()
  const named = flagged.map((issue) => issue.params?.name).filter((name) => typeof name === 'string')
  if (named.length > 0) return new Set(named.map((name) => name.toLowerCase()))
  // No name given: every name worn by more than one player.
  const counts = new Map<string, number>()
  for (const doc of validation.files.flatMap((file) => file.docs)) {
    if (doc.name) counts.set(doc.name.toLowerCase(), (counts.get(doc.name.toLowerCase()) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
}

function buildReport(validation: SessionValidation, session: Session): Report {
  const duplicated = duplicatedNames(validation)
  let attachedDuplicates = false
  const reports = validation.files.map((file): FileReport => {
    const docs = file.docs.map((doc): DocReport => {
      const issues = [...doc.issues]
      const isDuplicate = doc.name !== null && duplicated.has(doc.name.toLowerCase())
      if (isDuplicate && !issues.some((issue) => issue.code === 'name-duplicate')) {
        issues.push({ severity: 'error', code: 'name-duplicate' })
        attachedDuplicates = true
      }
      return { doc, issues }
    })
    const name = session.players.find((player) => player.id === file.fileId)?.originalName ?? file.fileId
    return { fileId: file.fileId, name, docs, multiDoc: file.docs.length > 1 }
  })
  const own = validation.files.flatMap((file) => file.docs.flatMap((doc) => doc.issues))
  const all = [...own, ...validation.sessionIssues]
  return {
    files: reports.filter((file) => file.docs.some((doc) => doc.issues.length > 0)),
    okFiles: reports.filter((file) => file.docs.every((doc) => doc.issues.length === 0)).length,
    sessionIssues: validation.sessionIssues.filter(
      (issue) => !(attachedDuplicates && issue.code === 'name-duplicate'),
    ),
    players: validation.files.reduce((sum, file) => sum + file.docs.length, 0),
    errors: all.filter((issue) => issue.severity === 'error' && issue.code !== COUNTED_AS_WORLD).length,
    warnings: all.filter((issue) => issue.severity === 'warning').length,
    romsNeeded: validation.romNeeds.filter((need) => need.status !== 'ok').length,
  }
}

export interface StepCheckProps {
  session: Session
  onBack: () => void
  onNext: () => void
}

export function StepCheck({ session, onBack, onNext }: StepCheckProps): React.JSX.Element {
  const { t } = useTranslation()
  const validation = useIpcQuery('session:validate', { id: session.id }, { refetchOnMount: 'always' })
  // Held by the step, so queued installs live on when the last missing world leaves the list.
  const worldInstall = useWorldInstall()
  const [renaming, setRenaming] = useState<RenameTarget | null>(null)

  const data = validation.data
  const report = data ? buildReport(data, session) : null

  const reasons = report
    ? [
        report.errors > 0 && t('screens.session.check.reasons.errors', { count: report.errors }),
        data &&
          data.missingWorlds.length > 0 &&
          t('screens.session.check.reasons.worlds', { count: data.missingWorlds.length }),
        report.romsNeeded > 0 && t('screens.session.check.reasons.roms', { count: report.romsNeeded }),
      ].filter((reason) => typeof reason === 'string')
    : []
  const blockedReason = data?.blocking
    ? reasons.length > 0
      ? t('screens.session.check.blocked', { reasons: reasons.join(', ') })
      : t('screens.session.check.blockedUnknown')
    : undefined

  return (
    <>
      <div className="check-step">
        <div className="check-step__bar">
          <NeonButton
            variant="ghost"
            size="sm"
            icon={<IconRefresh />}
            loading={validation.isFetching && data !== undefined}
            onClick={() => void validation.refetch()}
          >
            {t('screens.session.check.recheck')}
          </NeonButton>
        </div>

        {validation.isPending && (
          <div className="check-step__loading">
            <Spinner label={t('screens.session.check.checking')} />
          </div>
        )}
        {validation.isError && !data && (
          <CheckError error={validation.error} onRetry={() => void validation.refetch()} />
        )}

        {data && report && (
          <>
            <Summary report={report} worlds={data.missingWorlds.length} />
            {!data.blocking && (
              <div className="check-ready pixel-border tone-green" role="status">
                <IconCircleCheck className="check-ready__icon" aria-hidden="true" />
                <div>
                  <p className="check-ready__title">{t('screens.session.check.readyTitle')}</p>
                  <p className="check-ready__body">
                    {report.warnings > 0
                      ? t('screens.session.check.readyWarnings')
                      : t('screens.session.check.readyBody')}
                  </p>
                </div>
              </div>
            )}
            {data.missingWorlds.length > 0 && (
              <MissingWorlds
                worlds={data.missingWorlds}
                start={worldInstall.start}
                onInstalled={() => void validation.refetch()}
              />
            )}
            {data.romNeeds.length > 0 && <Roms needs={data.romNeeds} />}
            {report.files.map((file) => (
              <FilePanel key={file.fileId} sessionId={session.id} file={file} onRename={setRenaming} />
            ))}
            {report.sessionIssues.length > 0 && (
              <PixelPanel tone="yellow" padding="md" title={t('screens.session.check.sessionTitle')}>
                <ul className="check-issues">
                  {report.sessionIssues.map((issue, index) => (
                    <IssueLine key={index} issue={issue} />
                  ))}
                </ul>
              </PixelPanel>
            )}
            {/* Informative: how many checks each player has. It never blocks the step. */}
            {session.players.length > 0 && <ChecksPanel session={session} />}
            {report.okFiles > 0 && (
              <p className="check-step__ok">
                <IconCircleCheck aria-hidden="true" />
                {t('screens.session.check.filesOk', { count: report.okFiles })}
              </p>
            )}
          </>
        )}
      </div>
      {worldInstall.dialog}
      <RenameDialog sessionId={session.id} target={renaming} onClose={() => setRenaming(null)} />
      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!data || data.blocking}
        blockedReason={blockedReason}
      />
    </>
  )
}

function CheckError({ error, onRetry }: { error: unknown; onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { title, body, detail } = describeError(error, t)
  return (
    <ErrorPanel
      title={title}
      body={body}
      detail={detail}
      detailLabel={t('common.technicalDetails')}
      actions={
        <NeonButton variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </NeonButton>
      }
    />
  )
}

function Summary({ report, worlds }: { report: Report; worlds: number }): React.JSX.Element {
  const { t } = useTranslation()
  const lit = (count: number, tone: Tone): Tone => (count > 0 ? tone : 'neutral')
  return (
    <section className="check-summary" aria-label={t('screens.session.check.summaryLabel')}>
      <StatTile
        icon={<IconUsers />}
        tone="violet"
        label={t('screens.session.check.summary.players')}
        value={report.players}
      />
      <StatTile
        icon={<IconAlertOctagon />}
        tone={lit(report.errors, 'pink')}
        label={t('screens.session.check.summary.errors')}
        value={report.errors}
      />
      <StatTile
        icon={<IconAlertTriangle />}
        tone={lit(report.warnings, 'yellow')}
        label={t('screens.session.check.summary.warnings')}
        value={report.warnings}
      />
      <StatTile
        icon={<IconWorld />}
        tone={lit(worlds, 'cyan')}
        label={t('screens.session.check.summary.worlds')}
        value={worlds}
      />
      <StatTile
        icon={<IconDisc />}
        tone={lit(report.romsNeeded, 'pink')}
        label={t('screens.session.check.summary.roms')}
        value={report.romsNeeded}
      />
    </section>
  )
}

interface MissingWorldsProps {
  worlds: SessionValidation['missingWorlds']
  /** useWorldInstall().start: installs wait in its queue, one after another. */
  start: WorldInstall['start']
  onInstalled: () => void
}

/** A catalog world installs from the catalog; one outside it asks for its file first. */
function MissingWorlds({ worlds, start, onInstalled }: MissingWorldsProps): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [askingFiles, setAskingFiles] = useState(false)
  const showError = (error: unknown): void => {
    const { title, body } = describeError(error, t)
    toast.push({ tone: 'error', title, body })
  }
  const pick = useIpcMutation('app:pickPaths', { onError: showError })
  const open = useIpcMutation('app:openExternal', { onError: showError })

  const askFile = async (game: string): Promise<string | null> => {
    try {
      const [path] = await pick.mutateAsync({
        mode: 'file',
        title: t('screens.session.check.pickTitle', { game }),
        filters: [{ name: 'APWorld', extensions: ['apworld'] }],
      })
      return path ?? null
    } catch {
      return null
    }
  }

  const install = (jobs: { game: string; source: WorldSource }[]): void => {
    setPending((games) => new Set([...games, ...jobs.map((job) => job.game)]))
    for (const { game, source } of jobs) {
      void start(source).then(({ installed }) => {
        setPending((games) => new Set([...games].filter((other) => other !== game)))
        if (installed) onInstalled()
      })
    }
  }

  const installOne = async (world: (typeof worlds)[number]): Promise<void> => {
    if (world.catalogId)
      return install([{ game: world.game, source: { kind: 'catalog', id: world.catalogId } }])
    const path = await askFile(world.game)
    if (path) install([{ game: world.game, source: { kind: 'file', path } }])
  }

  const installAll = async (): Promise<void> => {
    setAskingFiles(true)
    const jobs: { game: string; source: WorldSource }[] = []
    // The files are asked for first, so the trust dialogs then follow one another without a gap.
    for (const world of worlds) {
      if (pending.has(world.game)) continue
      if (world.catalogId) {
        jobs.push({ game: world.game, source: { kind: 'catalog', id: world.catalogId } })
      } else {
        const path = await askFile(world.game)
        if (path) jobs.push({ game: world.game, source: { kind: 'file', path } })
      }
    }
    setAskingFiles(false)
    install(jobs)
  }

  const allPending = worlds.every((world) => pending.has(world.game))
  return (
    <PixelPanel
      tone="cyan"
      padding="md"
      title={t('screens.session.check.worldsTitle')}
      actions={
        <NeonButton
          size="sm"
          icon={<IconDownload />}
          disabled={allPending}
          loading={askingFiles}
          onClick={() => void installAll()}
        >
          {t('screens.session.check.installAll')}
        </NeonButton>
      }
    >
      <p className="check-panel__body">{t('screens.session.check.worldsBody')}</p>
      <ul className="check-rows">
        {worlds.map((world) => (
          <li key={world.game} className="check-row">
            <span className="check-row__icon tone-cyan" aria-hidden="true">
              <IconWorld />
            </span>
            <span className="check-row__main">
              <span className="check-row__title">{world.game}</span>
              {world.catalogId ? (
                <Badge tone="cyan" outline>
                  {t('screens.session.check.fromCatalog')}
                </Badge>
              ) : (
                <span className="check-row__hint">
                  {t(
                    world.downloadPage
                      ? 'screens.session.check.onPage'
                      : 'screens.session.check.notInCatalog',
                  )}
                </span>
              )}
            </span>
            {/* A world of the wiki the catalog cannot install: its file is on its page. */}
            {!world.catalogId && world.downloadPage && (
              <NeonButton
                variant="ghost"
                size="sm"
                icon={<IconExternalLink />}
                aria-label={t('screens.session.check.openPageLabel', { game: world.game })}
                onClick={() => world.downloadPage && open.mutate({ url: world.downloadPage })}
              >
                {t('screens.session.check.openPage')}
              </NeonButton>
            )}
            {world.catalogId ? (
              <NeonButton
                variant="secondary"
                size="sm"
                icon={<IconDownload />}
                aria-label={t('screens.session.check.installLabel', { game: world.game })}
                loading={pending.has(world.game)}
                onClick={() => void installOne(world)}
              >
                {t('screens.session.check.install')}
              </NeonButton>
            ) : (
              <NeonButton
                variant="secondary"
                size="sm"
                icon={<IconFileUpload />}
                aria-label={t('screens.session.check.pickFileLabel', { game: world.game })}
                loading={pending.has(world.game)}
                onClick={() => void installOne(world)}
              >
                {t('screens.session.check.pickFile')}
              </NeonButton>
            )}
          </li>
        ))}
      </ul>
    </PixelPanel>
  )
}

type RomState = 'vault' | 'settings' | 'missing' | 'bad-hash'

const ROM_PILL: Record<RomState, Status> = {
  vault: 'ok',
  settings: 'ok',
  missing: 'error',
  'bad-hash': 'error',
}

/**
 * A ready ROM comes from the effective settings key, or else from the vault: generation then writes
 * the vault path into the session host.yaml, so there is nothing to do but say so.
 */
function romState(need: RomNeed): RomState {
  if (need.status !== 'ok') return need.status
  return need.vaultPath !== null && (need.path === null || need.path === need.vaultPath)
    ? 'vault'
    : 'settings'
}

function Roms({ needs }: { needs: RomNeed[] }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <PixelPanel
      tone={needs.some((need) => need.status !== 'ok') ? 'yellow' : 'neutral'}
      padding="md"
      title={t('screens.session.check.romsTitle')}
    >
      <p className="check-panel__body">{t('screens.session.check.romsBody')}</p>
      <ul className="check-rows">
        {needs.map((need) => {
          const state = romState(need)
          return (
            <li key={need.settingsKey} className="check-row" data-state={state}>
              <span className="check-row__icon tone-yellow" aria-hidden="true">
                <IconDisc />
              </span>
              <span className="check-row__main">
                <span className="check-row__title">{need.game}</span>
                <StatusPill status={ROM_PILL[state]} label={t(`screens.session.check.rom.${state}`)} />
                {need.path && (
                  <code className="check-row__path" title={need.path}>
                    {need.path}
                  </code>
                )}
              </span>
              {(state === 'missing' || state === 'bad-hash') && (
                <NeonButton
                  variant="secondary"
                  size="sm"
                  icon={<IconDisc />}
                  onClick={() => void navigate('/vault')}
                >
                  {t('screens.session.check.openVault')}
                </NeonButton>
              )}
            </li>
          )
        })}
      </ul>
    </PixelPanel>
  )
}

interface FilePanelProps {
  sessionId: string
  file: FileReport
  onRename: (target: RenameTarget) => void
}

function FilePanel({ sessionId, file, onRename }: FilePanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const hasError = file.docs.some((doc) => doc.issues.some((issue) => issue.severity === 'error'))
  return (
    <PixelPanel
      tone={hasError ? 'pink' : 'yellow'}
      padding="md"
      title={file.name}
      className="check-file"
      actions={
        <NeonButton
          variant="secondary"
          size="sm"
          icon={<IconFileCode />}
          onClick={() => void navigate(studioLink(sessionId, file.fileId))}
        >
          {t('screens.session.check.fixInStudio')}
        </NeonButton>
      }
    >
      <div className="check-docs">
        {file.docs
          .filter((report) => report.issues.length > 0)
          .map(({ doc, issues }) => {
            const name = doc.name ?? t('screens.session.check.unnamed')
            const canRename = doc.name !== null && issues.some((issue) => RENAME_CODES.has(issue.code))
            return (
              <div key={doc.index} className="check-doc">
                <div className="check-doc__head">
                  <span className="check-doc__name">{name}</span>
                  <PlayerGames games={doc.games} className="check-doc__games" />
                  {canRename && doc.name !== null && (
                    <NeonButton
                      variant="ghost"
                      size="sm"
                      icon={<IconPencil />}
                      aria-label={t('screens.session.check.renameLabel', { name: doc.name })}
                      onClick={() =>
                        onRename({
                          fileId: file.fileId,
                          docIndex: doc.index,
                          name: doc.name ?? '',
                          multiDoc: file.multiDoc,
                        })
                      }
                    >
                      {t('screens.session.check.rename')}
                    </NeonButton>
                  )}
                </div>
                <ul className="check-issues">
                  {issues.map((issue, index) => (
                    <IssueLine key={index} issue={issue} />
                  ))}
                </ul>
              </div>
            )
          })}
      </div>
    </PixelPanel>
  )
}

function IssueLine({ issue }: { issue: Issue }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <li className="check-issue" data-severity={issue.severity}>
      {issue.severity === 'error' ? (
        <IconAlertOctagon className="check-issue__icon" aria-hidden="true" />
      ) : (
        <IconAlertTriangle className="check-issue__icon" aria-hidden="true" />
      )}
      <span className="sr-only">{t(`screens.session.check.severity.${issue.severity}`)}</span>
      <span className="check-issue__text">{t(`issues.${issue.code}`, issue.params ?? {})}</span>
      {issue.path && <code className="check-issue__path">{issue.path}</code>}
    </li>
  )
}
