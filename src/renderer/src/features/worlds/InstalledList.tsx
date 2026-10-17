// The "Installed" tab: every world Archipelago can see (added ones first, then the ones it ships),
// with its state, version and actions: open its folder, set it aside, remove it.
import {
  IconAlertOctagon,
  IconBan,
  IconCircleCheck,
  IconCursorText,
  IconEyeOff,
  IconFileAlert,
  IconFolderOpen,
  IconLock,
  IconPackageOff,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { WorldInfo, WorldState } from '@shared/types'
import {
  Badge,
  EmptyState,
  ErrorPanel,
  Modal,
  NeonButton,
  Segmented,
  Select,
  Spinner,
  Tooltip,
  useToast,
  type SelectOption,
  type Tone,
} from '../../design/components'
import { cx } from '../../design/classes'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { WORLD_QUERIES } from '../../hooks/useWorldInstall'
import { describeError } from '../../lib/errors'
import { GameSprite } from './GameSprite'
import {
  ACTIONABLE_STATES,
  badgeStates,
  countStates,
  formatBytes,
  matchesQuery,
  parentDir,
  STATE_ORDER,
  worldName,
} from './model'
import { SearchField } from './SearchField'
import { useErrorToast } from './useErrorToast'
import './InstalledList.css'

type StateFilter = 'all' | WorldState
type Origin = 'all' | 'custom' | 'core'

const STATE_TONE: Record<WorldState, Tone> = {
  ok: 'green',
  'no-manifest': 'yellow',
  incompatible: 'pink',
  corrupt: 'pink',
  shadowed: 'cyan',
  'core-loose': 'neutral',
  disabled: 'neutral',
  'bad-name': 'pink',
}

const STATE_ICON: Record<WorldState, ReactNode> = {
  ok: <IconCircleCheck />,
  'no-manifest': <IconFileAlert />,
  incompatible: <IconBan />,
  corrupt: <IconAlertOctagon />,
  shadowed: <IconEyeOff />,
  'core-loose': <IconLock />,
  disabled: <IconPlayerPause />,
  'bad-name': <IconCursorText />,
}

const SKELETON_ROWS = 5

export interface InstalledListProps {
  /** Switches to the catalog tab. */
  onBrowseCatalog: () => void
}

export function InstalledList({ onBrowseCatalog }: InstalledListProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const showError = useErrorToast()
  const worlds = useIpcQuery('worlds:list', undefined)
  const [query, setQuery] = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [origin, setOrigin] = useState<Origin>('all')
  const [removing, setRemoving] = useState<WorldInfo | null>(null)
  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { sensitivity: 'base', numeric: true }),
    [i18n.language],
  )

  const openFolder = useIpcMutation('app:openPath', { onError: showError })
  const setEnabled = useIpcMutation('worlds:setEnabled', {
    invalidates: WORLD_QUERIES,
    onSuccess: (world, { enabled }) => {
      const game = worldName(world)
      toast.push({
        tone: 'ok',
        title: t(enabled ? 'screens.worlds.installed.enabled' : 'screens.worlds.installed.disabled', {
          game,
        }),
        body: t('screens.worlds.installed.restartHint'),
      })
    },
    onError: showError,
  })
  // Enabling a misnamed world renames it after its module, which Archipelago imports.
  const rename = useIpcMutation('worlds:setEnabled', {
    invalidates: WORLD_QUERIES,
    onSuccess: (world) => {
      toast.push({
        tone: 'ok',
        title: t('screens.worlds.installed.renamed', { game: worldName(world), name: world.fileName }),
        body: t('screens.worlds.installed.restartHint'),
      })
    },
    onError: showError,
  })

  if (worlds.isPending) {
    return (
      <div className="worlds-installed worlds-installed--loading">
        <Spinner label={t('screens.worlds.installed.loading')} className="worlds-installed__spinner" />
        <ul className="world-list" aria-hidden="true">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <li key={index} className="world-row world-row--skeleton pixel-border" />
          ))}
        </ul>
      </div>
    )
  }

  if (worlds.isError) {
    const { title, body, detail, action } = describeError(worlds.error, t)
    return (
      <ErrorPanel
        title={title}
        body={body}
        detail={detail}
        detailLabel={t('common.technicalDetails')}
        headingLevel={2}
        actions={
          <>
            {action?.to !== undefined && (
              <NeonButton variant="primary" size="sm" onClick={() => void navigate(action.to ?? '/')}>
                {t(action.labelKey)}
              </NeonButton>
            )}
            <NeonButton
              variant="secondary"
              size="sm"
              icon={<IconRefresh />}
              onClick={() => void worlds.refetch()}
            >
              {t('common.retry')}
            </NeonButton>
          </>
        }
      />
    )
  }

  const all = worlds.data
  const counts = countStates(all)
  const filtering = query.trim() !== '' || stateFilter !== 'all'
  const byName = (a: WorldInfo, b: WorldInfo): number => collator.compare(worldName(a), worldName(b))
  const shown = all
    .filter(
      (world) =>
        (stateFilter === 'all' || world.states.includes(stateFilter)) &&
        matchesQuery(query, [
          worldName(world),
          world.module,
          world.fileName,
          ...(world.manifest?.authors ?? []),
        ]),
    )
    .sort(byName)
  const added = origin === 'core' ? [] : shown.filter((world) => world.location !== 'core')
  const core = origin === 'custom' ? [] : shown.filter((world) => world.location === 'core')
  // No world added at all: an invitation to the catalog rather than an empty list.
  const invite = origin !== 'core' && !all.some((world) => world.location !== 'core')
  const noMatch = added.length === 0 && core.length === 0 && (filtering || !invite)

  const stateOptions: SelectOption<StateFilter>[] = [
    { value: 'all', label: t('screens.worlds.installed.allStates', { count: all.length }) },
    ...STATE_ORDER.filter((state) => counts[state] > 0 || state === stateFilter).map((state) => ({
      value: state,
      label: t('screens.worlds.installed.stateOption', {
        label: t(`screens.worlds.states.${state}.label`),
        count: counts[state],
      }),
    })),
  ]

  const clearFilters = (): void => {
    setQuery('')
    setStateFilter('all')
  }

  const rowProps = {
    busyId: setEnabled.isPending
      ? setEnabled.variables.worldId
      : rename.isPending
        ? rename.variables.worldId
        : null,
    onOpen: (world: WorldInfo) => openFolder.mutate({ path: parentDir(world.path) }),
    onToggle: (world: WorldInfo) =>
      setEnabled.mutate({ worldId: world.id, enabled: world.location === 'disabled' }),
    onRename: (world: WorldInfo) => rename.mutate({ worldId: world.id, enabled: true }),
    onRemove: setRemoving,
  }

  return (
    <div className="worlds-installed">
      {counts.corrupt > 0 && (
        <ErrorPanel
          className="worlds-installed__alert"
          title={t('errors.WORLD_CORRUPT_BLOCKING')}
          body={t('screens.worlds.installed.corruptBody', { count: counts.corrupt })}
          headingLevel={2}
          actions={
            <NeonButton
              variant="danger"
              size="sm"
              icon={<IconAlertOctagon />}
              onClick={() => {
                setQuery('')
                setOrigin('all')
                setStateFilter('corrupt')
              }}
            >
              {t('screens.worlds.installed.corruptAction')}
            </NeonButton>
          }
        />
      )}

      <div className="worlds-toolbar">
        <SearchField
          className="worlds-toolbar__search"
          label={t('screens.worlds.installed.search')}
          placeholder={t('screens.worlds.installed.searchPlaceholder')}
          clearLabel={t('screens.worlds.searchClear')}
          value={query}
          onChange={setQuery}
        />
        <Select
          className="worlds-toolbar__select worlds-toolbar__select--wide"
          label={t('screens.worlds.installed.stateFilter')}
          hideLabel
          options={stateOptions}
          value={stateFilter}
          onChange={setStateFilter}
        />
        <Segmented
          size="sm"
          label={t('screens.worlds.installed.origin')}
          value={origin}
          onChange={setOrigin}
          options={[
            { value: 'all', label: t('screens.worlds.installed.origins.all') },
            { value: 'custom', label: t('screens.worlds.installed.origins.custom') },
            { value: 'core', label: t('screens.worlds.installed.origins.core') },
          ]}
        />
      </div>

      {invite && (
        <WorldSection title={t('screens.worlds.installed.sections.custom')} count={0}>
          <EmptyState
            tone="cyan"
            icon={<IconPackageOff />}
            title={t('screens.worlds.installed.emptyTitle')}
            body={t('screens.worlds.installed.emptyBody')}
            headingLevel={3}
            action={
              <NeonButton variant="primary" onClick={onBrowseCatalog}>
                {t('screens.worlds.installed.browseCatalog')}
              </NeonButton>
            }
          />
        </WorldSection>
      )}

      {added.length > 0 && (
        <WorldSection title={t('screens.worlds.installed.sections.custom')} count={added.length}>
          <WorldRows worlds={added} label={t('screens.worlds.installed.sections.custom')} {...rowProps} />
        </WorldSection>
      )}

      {core.length > 0 && (
        <WorldSection title={t('screens.worlds.installed.sections.core')} count={core.length}>
          <WorldRows worlds={core} label={t('screens.worlds.installed.sections.core')} {...rowProps} />
        </WorldSection>
      )}

      {noMatch && (
        <EmptyState
          tone="yellow"
          title={t('screens.worlds.noMatch.title')}
          body={t('screens.worlds.noMatch.body')}
          headingLevel={2}
          action={
            filtering ? (
              <NeonButton variant="secondary" onClick={clearFilters}>
                {t('screens.worlds.clearFilters')}
              </NeonButton>
            ) : undefined
          }
        />
      )}

      <RemoveDialog world={removing} onClose={() => setRemoving(null)} />
    </div>
  )
}

function WorldSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section className="worlds-section" aria-labelledby={headingId}>
      <header className="worlds-section__head">
        <h2 id={headingId} className="worlds-section__title">
          {title}
        </h2>
        {count > 0 && (
          <span className="worlds-section__count" aria-hidden="true">
            {count}
          </span>
        )}
      </header>
      {children}
    </section>
  )
}

interface RowActions {
  busyId: string | null
  onOpen: (world: WorldInfo) => void
  onToggle: (world: WorldInfo) => void
  onRename: (world: WorldInfo) => void
  onRemove: (world: WorldInfo) => void
}

function WorldRows({
  worlds,
  label,
  ...actions
}: { worlds: WorldInfo[]; label: string } & RowActions): React.JSX.Element {
  return (
    <ul className="world-list" aria-label={label}>
      {worlds.map((world) => (
        <li key={world.id}>
          <WorldRow world={world} {...actions} />
        </li>
      ))}
    </ul>
  )
}

function WorldRow({
  world,
  busyId,
  onOpen,
  onToggle,
  onRename,
  onRemove,
}: { world: WorldInfo } & RowActions): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const nameId = useId()
  const game = worldName(world)
  const version = world.manifest?.worldVersion ?? null
  const disabled = world.location === 'disabled'
  const editable = world.location !== 'core'
  const busy = busyId === world.id
  const states = badgeStates(world)

  return (
    <article
      className={cx('world-row pixel-border', disabled && 'world-row--disabled')}
      aria-labelledby={nameId}
      data-problem={states.some((state) => STATE_TONE[state] === 'pink') || undefined}
    >
      <GameSprite name={world.game ?? world.module} />
      <div className="world-row__main">
        <h3 id={nameId} className="world-row__name">
          {game}
        </h3>
        <p className="world-row__meta">
          <span className="world-row__file" title={world.path}>
            {world.fileName}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(world.sizeBytes, i18n.language)}</span>
        </p>
      </div>
      <div className="world-row__states">
        {states.map((state) => (
          <StateBadge key={state} state={state} />
        ))}
      </div>
      <span className="world-row__version" data-unknown={version === null || undefined}>
        {version ?? (
          <span aria-hidden="true" title={t('screens.worlds.installed.versionUnknown')}>
            —
          </span>
        )}
        {version === null && <span className="sr-only">{t('screens.worlds.installed.versionUnknown')}</span>}
      </span>
      <div className="world-row__actions">
        {/* An AppImage's core worlds sit inside its mount: they have no folder to open. */}
        {world.path !== '' && (
          <RowButton
            tip={t('screens.worlds.installed.openFolder')}
            label={t('screens.worlds.installed.openFolderOf', { game })}
            icon={<IconFolderOpen />}
            onClick={() => onOpen(world)}
          />
        )}
        {editable && !disabled && world.states.includes('bad-name') && (
          <RowButton
            tip={t('screens.worlds.installed.rename', { name: `${world.module}.apworld` })}
            label={t('screens.worlds.installed.renameGame', { game, name: `${world.module}.apworld` })}
            icon={<IconCursorText />}
            busy={busy}
            onClick={() => onRename(world)}
          />
        )}
        {editable && (
          <>
            <RowButton
              tip={t(disabled ? 'screens.worlds.installed.enable' : 'screens.worlds.installed.disable')}
              label={t(
                disabled ? 'screens.worlds.installed.enableGame' : 'screens.worlds.installed.disableGame',
                { game },
              )}
              icon={disabled ? <IconPlayerPlay /> : <IconPlayerPause />}
              busy={busy}
              onClick={() => onToggle(world)}
            />
            <RowButton
              tip={t('screens.worlds.installed.remove')}
              label={t('screens.worlds.installed.removeGame', { game })}
              icon={<IconTrash />}
              danger
              disabled={busy}
              onClick={() => onRemove(world)}
            />
          </>
        )}
      </div>
    </article>
  )
}

function StateBadge({ state }: { state: WorldState }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Tooltip content={t(`screens.worlds.states.${state}.help`)}>
      <span
        className="world-state"
        data-state={state}
        tabIndex={ACTIONABLE_STATES.has(state) ? 0 : undefined}
      >
        <Badge tone={STATE_TONE[state]} icon={STATE_ICON[state]}>
          {t(`screens.worlds.states.${state}.label`)}
        </Badge>
      </span>
    </Tooltip>
  )
}

interface RowButtonProps {
  /** Short text of the tooltip. */
  tip: string
  /** Accessible name, with the game. */
  label: string
  icon: ReactNode
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  danger?: boolean
}

function RowButton({ tip, label, icon, onClick, busy, disabled, danger }: RowButtonProps): React.JSX.Element {
  return (
    <Tooltip content={tip}>
      <NeonButton
        variant="ghost"
        size="sm"
        className={cx('world-row__button', danger && 'world-row__button--danger')}
        aria-label={label}
        icon={icon}
        loading={busy}
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
  )
}

function RemoveDialog({
  world,
  onClose,
}: {
  world: WorldInfo | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const remove = useIpcMutation('worlds:remove', {
    invalidates: WORLD_QUERIES,
    onSuccess: () => {
      if (world)
        toast.push({ tone: 'ok', title: t('screens.worlds.remove.done', { game: worldName(world) }) })
      close()
    },
  })
  const close = (): void => {
    remove.reset()
    onClose()
  }
  const failure = remove.error ? describeError(remove.error, t) : null
  const game = world ? worldName(world) : ''

  return (
    <Modal
      open={world !== null}
      onClose={close}
      dismissible={!remove.isPending}
      closeLabel={t('common.closeDialog')}
      tone="pink"
      size="sm"
      eyebrow={t('screens.worlds.remove.eyebrow')}
      title={t('screens.worlds.remove.title', { game })}
      footer={
        <>
          <NeonButton variant="ghost" onClick={close} disabled={remove.isPending}>
            {t('common.cancel')}
          </NeonButton>
          <NeonButton
            variant="danger"
            icon={<IconTrash />}
            loading={remove.isPending}
            loadingLabel={t('screens.worlds.remove.removing')}
            onClick={() => {
              if (world) remove.mutate({ worldId: world.id })
            }}
          >
            {t('screens.worlds.remove.confirm')}
          </NeonButton>
        </>
      }
    >
      <div className="worlds-remove">
        <p className="worlds-remove__body">
          {t('screens.worlds.remove.body', { file: world?.fileName ?? '' })}
        </p>
        {failure && (
          <ErrorPanel
            title={failure.title}
            body={failure.body}
            detail={failure.detail}
            detailLabel={t('common.technicalDetails')}
          />
        )}
      </div>
    </Modal>
  )
}
