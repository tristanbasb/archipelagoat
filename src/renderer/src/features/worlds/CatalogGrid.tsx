// The "Catalog" tab: the worlds of the community index for this Archipelago version, joined with
// the Archipelago wiki (status, maintainer, categories), then the worlds only the wiki lists. Search,
// filters, and an install button that goes through the trust screen.
import { useQueryClient } from '@tanstack/react-query'
import {
  IconArrowBigUpLines,
  IconBook2,
  IconCircleCheck,
  IconCloudOff,
  IconDisc,
  IconDownload,
  IconExternalLink,
  IconFilterOff,
  IconLicense,
  IconMap2,
  IconRating18Plus,
  IconRefresh,
  IconRoute,
  IconWorldSearch,
} from '@tabler/icons-react'
import { useId, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { isInstallable } from '@shared/catalog'
import { isAllowedExternalUrl } from '@shared/external-url'
import type { CatalogEntry, CatalogSnapshot, CatalogSource } from '@shared/types'
import {
  Badge,
  EmptyState,
  ErrorPanel,
  NeonButton,
  Select,
  Spinner,
  StatusPill,
  Tooltip,
  TrustBadge,
  type SelectOption,
  type Tone,
} from '../../design/components'
import { cx, toneClass } from '../../design/classes'
import { sfx } from '../../design/sfx'
import { useIpcMutation, useIpcQuery } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import { useConfig } from '../../stores/config'
import { GameCover } from './GameCover'
import { spriteTone } from './GameSprite'
import { hasUpdate, matchesQuery, statusTone, visibleEntries } from './model'
import { SearchField } from './SearchField'
import { useErrorToast } from './useErrorToast'
import './CatalogGrid.css'

const WIKI_URL = 'https://archipelago.miraheze.org'
const INDEX_URL = 'https://github.com/ionium-ap/Archipelago-index'

/** Cards rendered at first, and added by each "show more". */
const PAGE = 48
const SKELETON_CARDS = 8
/** The value of the "any" option of the status and tag filters. */
const ANY = '*'
/** The index tags its After Dark worlds "ad": the 18+ badge and filter say it already. */
const AFTER_DARK_TAG = 'ad'

type RomFilter = 'any' | 'none' | 'needed'
type SourceFilter = 'any' | CatalogSource

interface Filters {
  query: string
  status: string
  tag: string
  rom: RomFilter
  source: SourceFilter
  installed: boolean
  updates: boolean
  popTracker: boolean
  afterDark: boolean
}

const NO_FILTERS: Filters = {
  query: '',
  status: ANY,
  tag: ANY,
  rom: 'any',
  source: 'any',
  installed: false,
  updates: false,
  popTracker: false,
  afterDark: false,
}

function isFiltering(filters: Filters): boolean {
  return (Object.keys(NO_FILTERS) as (keyof Filters)[]).some((key) =>
    key === 'query' ? filters.query.trim() !== '' : filters[key] !== NO_FILTERS[key],
  )
}

function keep(entry: CatalogEntry, filters: Filters): boolean {
  return (
    matchesQuery(
      filters.query,
      [
        entry.displayName,
        entry.game,
        // The id of a wiki entry only repeats its title.
        entry.source === 'index' ? entry.id : null,
        entry.wiki?.maintainer,
        ...entry.tags,
      ],
      // A whole word: "x" or "de" must not find every world of the index.
      [entry.source],
    ) &&
    (filters.status === ANY || entry.wiki?.status === filters.status) &&
    (filters.tag === ANY || entry.tags.includes(filters.tag)) &&
    (filters.rom === 'any' || entry.requiresRomAtGeneration === (filters.rom === 'needed')) &&
    (filters.source === 'any' || entry.source === filters.source) &&
    (!filters.installed || entry.installedVersion !== null) &&
    (!filters.updates || hasUpdate(entry)) &&
    (!filters.popTracker || entry.hasPopTracker) &&
    (!filters.afterDark || entry.afterDark)
  )
}

function distinct(values: readonly (string | null | undefined)[], collator: Intl.Collator): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(collator.compare)
}

export interface CatalogGridProps {
  /** Starts the install of a catalog world (trust screen first). */
  onInstall: (entry: CatalogEntry) => void
}

export function CatalogGrid({ onInstall }: CatalogGridProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const showError = useErrorToast()
  const { showAfterDark } = useConfig()
  const catalog = useIpcQuery('catalog:list', {})
  const refresh = useIpcMutation('catalog:list', {
    onSuccess: (snapshot) => queryClient.setQueryData<CatalogSnapshot>(['catalog:list', {}], snapshot),
    onError: showError,
  })
  const openExternal = useIpcMutation('app:openExternal', { onError: showError })
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [limit, setLimit] = useState(PAGE)
  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { sensitivity: 'base', numeric: true }),
    [i18n.language],
  )

  const filter = (patch: Partial<Filters>): void => {
    setFilters((current) => ({ ...current, ...patch }))
    setLimit(PAGE)
  }
  const open = (url: string): void => openExternal.mutate({ url })
  const refreshButton = (label: string, variant: 'secondary' | 'ghost' = 'ghost'): React.JSX.Element => (
    <NeonButton
      variant={variant}
      size="sm"
      icon={<IconRefresh />}
      loading={refresh.isPending}
      loadingLabel={t('screens.worlds.catalog.refreshing')}
      onClick={() => refresh.mutate({ force: true })}
    >
      {label}
    </NeonButton>
  )

  if (catalog.isPending) {
    return (
      <div className="worlds-catalog">
        <Spinner label={t('screens.worlds.catalog.loading')} className="worlds-catalog__spinner" />
        <ul className="catalog-grid" aria-hidden="true">
          {Array.from({ length: SKELETON_CARDS }, (_, index) => (
            <li key={index} className="catalog-card catalog-card--skeleton pixel-border" />
          ))}
        </ul>
      </div>
    )
  }

  if (catalog.isError) {
    const { title, body, detail, action } = describeError(catalog.error, t)
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
              onClick={() => void catalog.refetch()}
            >
              {t('common.retry')}
            </NeonButton>
          </>
        }
      />
    )
  }

  const snapshot = catalog.data
  const entries = visibleEntries(snapshot.entries, showAfterDark)
  const active = { ...filters, afterDark: filters.afterDark && showAfterDark }
  const shown = entries
    .filter((entry) => keep(entry, active))
    .sort((a, b) => collator.compare(a.displayName, b.displayName))
  const filtering = isFiltering(active)
  const statuses = distinct(
    entries.map((entry) => entry.wiki?.status),
    collator,
  )
  const tags = distinct(
    entries.flatMap((entry) => entry.tags).filter((tag) => tag !== AFTER_DARK_TAG),
    collator,
  )
  const fromWiki = entries.some((entry) => entry.source === 'wiki')
  const fetchedAt = snapshot.fetchedAt
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(snapshot.fetchedAt),
      )
    : null

  const anyOption = (label: string): SelectOption<string> => ({ value: ANY, label })

  return (
    <div className="worlds-catalog">
      {snapshot.stale && (
        <StaleNotice
          snapshot={snapshot}
          fetchedAt={fetchedAt}
          action={refreshButton(t('common.retry'), 'secondary')}
        />
      )}

      <div className="worlds-toolbar">
        <SearchField
          className="worlds-toolbar__search"
          label={t('screens.worlds.catalog.search')}
          placeholder={t('screens.worlds.catalog.searchPlaceholder')}
          clearLabel={t('screens.worlds.searchClear')}
          value={filters.query}
          onChange={(query) => filter({ query })}
        />
        {statuses.length > 0 && (
          <Select
            className="worlds-toolbar__select"
            label={t('screens.worlds.catalog.status')}
            hideLabel
            value={filters.status}
            onChange={(status) => filter({ status })}
            options={[
              anyOption(t('screens.worlds.catalog.allStatuses')),
              ...statuses.map((status) => ({ value: status, label: status })),
            ]}
          />
        )}
        {tags.length > 0 && (
          <Select
            className="worlds-toolbar__select"
            label={t('screens.worlds.catalog.tag')}
            hideLabel
            value={filters.tag}
            onChange={(tag) => filter({ tag })}
            options={[
              anyOption(t('screens.worlds.catalog.allTags')),
              ...tags.map((tag) => ({ value: tag, label: tag })),
            ]}
          />
        )}
        <Select<RomFilter>
          className="worlds-toolbar__select"
          label={t('screens.worlds.catalog.rom')}
          hideLabel
          value={filters.rom}
          onChange={(rom) => filter({ rom })}
          options={(['any', 'none', 'needed'] as const).map((rom) => ({
            value: rom,
            label: t(`screens.worlds.catalog.roms.${rom}`),
          }))}
        />
        {fromWiki && (
          <Select<SourceFilter>
            className="worlds-toolbar__select"
            label={t('screens.worlds.catalog.source')}
            hideLabel
            value={filters.source}
            onChange={(source) => filter({ source })}
            options={(['any', 'index', 'wiki'] as const).map((source) => ({
              value: source,
              label: t(`screens.worlds.catalog.sources.${source}`),
            }))}
          />
        )}
      </div>

      <div className="worlds-catalog__bar">
        <div role="group" aria-label={t('screens.worlds.catalog.quickFilters')} className="worlds-chips">
          <FilterChip
            pressed={filters.installed}
            icon={<IconCircleCheck />}
            onChange={(installed) => filter({ installed })}
          >
            {t('screens.worlds.catalog.installedOnly')}
          </FilterChip>
          <FilterChip
            pressed={filters.updates}
            icon={<IconArrowBigUpLines />}
            onChange={(updates) => filter({ updates })}
          >
            {t('screens.worlds.catalog.updatesOnly')}
          </FilterChip>
          <FilterChip
            pressed={filters.popTracker}
            icon={<IconMap2 />}
            onChange={(popTracker) => filter({ popTracker })}
          >
            {t('screens.worlds.catalog.popTracker')}
          </FilterChip>
          {showAfterDark && (
            <FilterChip
              pressed={filters.afterDark}
              icon={<IconRating18Plus />}
              tone="pink"
              onChange={(afterDark) => filter({ afterDark })}
            >
              {t('screens.worlds.catalog.afterDark')}
            </FilterChip>
          )}
        </div>
        <div className="worlds-catalog__status">
          <p className="worlds-catalog__count" aria-live="polite">
            {t('screens.worlds.catalog.results', { count: shown.length })}
          </p>
          {filtering && shown.length > 0 && (
            <NeonButton variant="ghost" size="sm" icon={<IconFilterOff />} onClick={() => filter(NO_FILTERS)}>
              {t('screens.worlds.clearFilters')}
            </NeonButton>
          )}
          {fetchedAt && !snapshot.stale && (
            <span className="worlds-catalog__fetched">
              {t('screens.worlds.catalog.fetchedAt', { date: fetchedAt })}
            </span>
          )}
          {!snapshot.stale && refreshButton(t('screens.worlds.catalog.refresh'))}
        </div>
      </div>

      {/* Kept mounted when empty, so that the list does not jump in and out while typing. */}
      <ul className="catalog-grid" aria-label={t('screens.worlds.catalog.listLabel')}>
        {shown.slice(0, limit).map((entry) => (
          <li key={entry.id}>
            <CatalogCard entry={entry} onInstall={onInstall} onOpen={open} />
          </li>
        ))}
      </ul>

      {shown.length > limit && (
        <div className="worlds-catalog__more">
          <NeonButton variant="secondary" onClick={() => setLimit((current) => current + PAGE)}>
            {t('screens.worlds.catalog.more', { count: shown.length - limit })}
          </NeonButton>
        </div>
      )}

      {shown.length === 0 &&
        (filtering ? (
          <EmptyState
            tone="yellow"
            icon={<IconWorldSearch />}
            title={t('screens.worlds.noMatch.title')}
            body={t('screens.worlds.noMatch.body')}
            headingLevel={2}
            action={
              <NeonButton variant="secondary" icon={<IconFilterOff />} onClick={() => filter(NO_FILTERS)}>
                {t('screens.worlds.clearFilters')}
              </NeonButton>
            }
          />
        ) : (
          <EmptyState
            tone="cyan"
            title={t('screens.worlds.catalog.emptyTitle')}
            body={t('screens.worlds.catalog.emptyBody')}
            headingLevel={2}
            action={refreshButton(t('screens.worlds.catalog.refresh'), 'secondary')}
          />
        ))}

      <footer className="catalog-credits">
        <IconLicense className="catalog-credits__icon" aria-hidden="true" />
        <div className="catalog-credits__text">
          <p>
            <Trans
              i18nKey="screens.worlds.catalog.creditsWiki"
              components={{ wiki: <TextLink url={WIKI_URL} onOpen={open} /> }}
            />
          </p>
          <p>
            <Trans
              i18nKey="screens.worlds.catalog.creditsIndex"
              components={{ index: <TextLink url={INDEX_URL} onOpen={open} /> }}
            />
          </p>
        </div>
      </footer>
    </div>
  )
}

function StaleNotice({
  snapshot,
  fetchedAt,
  action,
}: {
  snapshot: CatalogSnapshot
  fetchedAt: string | null
  action: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const titleId = useId()
  const code = snapshot.errors[0]
  const reason = code ? describeError({ code }, t) : null
  return (
    <section className="catalog-notice pixel-border tone-yellow" aria-labelledby={titleId}>
      <IconCloudOff className="catalog-notice__icon" aria-hidden="true" />
      <div className="catalog-notice__text">
        <h2 id={titleId} className="catalog-notice__title">
          {t('screens.worlds.catalog.staleTitle')}
        </h2>
        {reason && (
          <p>
            <strong>{reason.title}.</strong> {reason.body}
          </p>
        )}
        <p className="catalog-notice__copy">
          {fetchedAt
            ? t('screens.worlds.catalog.staleCopy', { date: fetchedAt })
            : t('screens.worlds.catalog.staleNoCopy')}
        </p>
      </div>
      <div className="catalog-notice__actions">
        {action}
        {reason?.action?.to !== undefined && (
          <NeonButton variant="ghost" size="sm" onClick={() => void navigate(reason.action?.to ?? '/')}>
            {t(reason.action.labelKey)}
          </NeonButton>
        )}
      </div>
    </section>
  )
}

function FilterChip({
  pressed,
  onChange,
  icon,
  tone = 'violet',
  children,
}: {
  pressed: boolean
  onChange: (pressed: boolean) => void
  icon: ReactNode
  tone?: Tone
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cx('worlds-chip', toneClass(tone))}
      aria-pressed={pressed}
      onClick={() => {
        sfx.play('blip')
        onChange(!pressed)
      }}
    >
      <span className="worlds-chip__icon" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </button>
  )
}

interface CatalogCardProps {
  entry: CatalogEntry
  onInstall: (entry: CatalogEntry) => void
  onOpen: (url: string) => void
}

function CatalogCard({ entry, onInstall, onOpen }: CatalogCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const game = entry.displayName
  const status = entry.wiki?.status ?? null
  const maintainer = entry.wiki?.maintainer ?? null
  const installed = entry.installedVersion !== null
  const update = hasUpdate(entry)

  return (
    <article
      className={cx('catalog-card pixel-border', toneClass(spriteTone(entry.game)))}
      aria-labelledby={titleId}
      data-installed={installed || undefined}
    >
      <div className="catalog-card__banner">
        {/* Decorative: the update button says it in words. */}
        {update && (
          <span className="catalog-card__ribbon t-display" aria-hidden="true">
            1UP
          </span>
        )}
        <GameCover game={entry.game} size="lg" className="catalog-card__cover" />
        <TrustBadge
          tier={entry.trust}
          label={t(`trust.${entry.trust}.label`)}
          description={t(`trust.${entry.trust}.description`)}
        />
      </div>
      <div className="catalog-card__body">
        <h3 id={titleId} className="catalog-card__title" title={game}>
          {game}
        </h3>
        <p className="catalog-card__meta">
          {entry.latest &&
            (update ? (
              <span className="catalog-card__delta">
                {t('screens.worlds.catalog.updateFromTo', {
                  from: entry.installedVersion,
                  to: entry.latest.version,
                })}
              </span>
            ) : (
              <span className="catalog-card__version">
                {t('screens.worlds.catalog.version', { version: entry.latest.version })}
              </span>
            ))}
          {/* Its version is only known once installed: GitHub is not asked for every card. */}
          {!entry.latest && entry.download?.kind === 'github-latest' && (
            <span className="catalog-card__version">{t('screens.worlds.catalog.latestRelease')}</span>
          )}
          {maintainer && (
            <span className="catalog-card__maintainer">
              {t('screens.worlds.catalog.by', { name: maintainer })}
            </span>
          )}
        </p>
        <div className="catalog-card__badges">
          {entry.source === 'wiki' && (
            <HelpBadge
              tone="violet"
              icon={<IconBook2 />}
              label={t('screens.worlds.catalog.wikiBadge')}
              help={t('screens.worlds.catalog.wikiHelp')}
            />
          )}
          {status && <Badge tone={statusTone(status)}>{status}</Badge>}
          {entry.requiresRomAtGeneration && (
            <HelpBadge
              tone="yellow"
              icon={<IconDisc />}
              label={t('screens.worlds.catalog.roms.needed')}
              help={t('screens.worlds.catalog.romHelp')}
            />
          )}
          {entry.hasPopTracker && (
            <HelpBadge
              tone="cyan"
              icon={<IconMap2 />}
              label={t('screens.worlds.catalog.popTracker')}
              help={t('screens.worlds.catalog.popTrackerHelp')}
            />
          )}
          {entry.afterDark && (
            <HelpBadge
              tone="pink"
              icon={<IconRating18Plus />}
              label={t('screens.worlds.catalog.afterDark')}
              help={t('screens.worlds.catalog.afterDarkHelp')}
            />
          )}
          {entry.tags
            .filter((tag) => tag !== AFTER_DARK_TAG)
            .slice(0, 3)
            .map((tag) => (
              <Badge key={tag} tone="neutral" outline>
                {tag}
              </Badge>
            ))}
        </div>
      </div>
      <footer className="catalog-card__foot">
        <InstallAction entry={entry} onInstall={onInstall} onOpen={onOpen} />
        <div className="catalog-card__links">
          {entry.wiki && (
            <LinkButton
              tip={t('screens.worlds.catalog.wikiPage')}
              label={t('screens.worlds.catalog.wikiPageOf', { game })}
              icon={<IconBook2 />}
              onClick={() => entry.wiki && onOpen(entry.wiki.url)}
            />
          )}
          {entry.wiki?.setupUrl && (
            <LinkButton
              tip={t('screens.worlds.catalog.setup')}
              label={t('screens.worlds.catalog.setupOf', { game })}
              icon={<IconRoute />}
              onClick={() => entry.wiki?.setupUrl && onOpen(entry.wiki.setupUrl)}
            />
          )}
          {entry.homepage && (
            <LinkButton
              tip={t('screens.worlds.catalog.homepage')}
              label={t('screens.worlds.catalog.homepageOf', { game })}
              icon={<IconExternalLink />}
              onClick={() => entry.homepage && onOpen(entry.homepage)}
            />
          )}
        </div>
      </footer>
    </article>
  )
}

function InstallAction({ entry, onInstall, onOpen }: CatalogCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const game = entry.displayName
  if (hasUpdate(entry)) {
    return (
      <NeonButton
        variant="secondary"
        size="sm"
        icon={<IconArrowBigUpLines />}
        aria-label={t('screens.worlds.catalog.updateGame', { game })}
        onClick={() => onInstall(entry)}
      >
        {t('screens.worlds.catalog.update')}
      </NeonButton>
    )
  }
  if (entry.installedVersion !== null) {
    const pill = (
      <StatusPill
        status="ok"
        label={t('screens.worlds.catalog.installedPill', { version: entry.installedVersion })}
      />
    )
    // Its latest release is only asked when installing: the player asks again, the trust screen
    // shows which version it found before anything is replaced.
    if (entry.latest === null && entry.download?.kind === 'github-latest') {
      return (
        <span className="catalog-card__installed">
          {pill}
          <LinkButton
            tip={t('screens.worlds.catalog.checkUpdate')}
            label={t('screens.worlds.catalog.checkUpdateOf', { game })}
            icon={<IconRefresh />}
            onClick={() => onInstall(entry)}
          />
        </span>
      )
    }
    return pill
  }
  if (isInstallable(entry)) {
    return (
      <NeonButton
        variant="primary"
        size="sm"
        icon={<IconDownload />}
        aria-label={t('screens.worlds.catalog.installGame', { game })}
        onClick={() => onInstall(entry)}
      >
        {t('screens.worlds.catalog.install')}
      </NeonButton>
    )
  }
  if (entry.download?.kind === 'page') {
    // No release ArchipelaGOAT can fetch: the player downloads the file, then installs it.
    const { url } = entry.download
    // A site the app does not open (itch.io, GitLab…): the link is on the wiki page of the card.
    if (!isAllowedExternalUrl(url)) {
      return <StatusPill status="idle" label={t('screens.worlds.catalog.downloadOnWiki')} />
    }
    return (
      <Tooltip content={t('screens.worlds.catalog.downloadPageHelp')}>
        <NeonButton
          variant="secondary"
          size="sm"
          icon={<IconExternalLink />}
          aria-label={t('screens.worlds.catalog.downloadPageOf', { game })}
          onClick={() => onOpen(url)}
        >
          {t('screens.worlds.catalog.downloadPage')}
        </NeonButton>
      </Tooltip>
    )
  }
  return <StatusPill status="idle" label={t('screens.worlds.catalog.unavailable')} />
}

/** A badge whose meaning shows on hover; its label says enough for the keyboard and screen readers. */
function HelpBadge({
  tone,
  icon,
  label,
  help,
}: {
  tone: Tone
  icon: ReactNode
  label: string
  help: string
}): React.JSX.Element {
  return (
    <Tooltip content={help}>
      <span className="catalog-card__help">
        <Badge tone={tone} icon={icon}>
          {label}
        </Badge>
      </span>
    </Tooltip>
  )
}

function LinkButton({
  tip,
  label,
  icon,
  onClick,
}: {
  tip: string
  label: string
  icon: ReactElement
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip content={tip}>
      <NeonButton
        variant="ghost"
        size="sm"
        className="catalog-card__link"
        aria-label={label}
        icon={icon}
        onClick={onClick}
      />
    </Tooltip>
  )
}

/** An external link inside a sentence (Trans fills in its text). */
function TextLink({
  url,
  onOpen,
  children,
}: {
  url: string
  onOpen: (url: string) => void
  children?: ReactNode
}): React.JSX.Element {
  return (
    <button type="button" className="worlds-link" onClick={() => onOpen(url)}>
      {children}
      <IconExternalLink aria-hidden="true" />
    </button>
  )
}
