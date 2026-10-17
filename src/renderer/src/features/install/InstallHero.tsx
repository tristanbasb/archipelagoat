// The top of the screen: where Archipelago stands, the installed and latest versions side by side,
// and the one thing to do about it (install, update…), if any.
import {
  IconArrowBigUpLines,
  IconChevronsRight,
  IconCoin,
  IconDownload,
  IconPackageImport,
  IconQuestionMark,
  IconRefresh,
  IconShieldLock,
  IconTrophy,
  IconCircleCheck,
  IconEqual,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApInstall, ApRelease, OS } from '@shared/types'
import { cx, toneClass, type Tone } from '../../design/classes'
import { NeonButton, Spinner } from '../../design/components'
import { isHandPicked, type ApState, type Offer } from './install-model'

export type LatestStatus = 'loading' | 'error' | 'ok'

export interface InstallHeroProps {
  state: ApState
  installed: ApInstall | null
  latest: ApRelease | null
  latestStatus: LatestStatus
  os: OS | null
  offer: Offer | null
  onOffer: () => void
}

const STATE_TONE: Record<ApState, Tone> = {
  missing: 'yellow',
  update: 'cyan',
  current: 'green',
  unknown: 'yellow',
  appimage: 'cyan',
  unchecked: 'violet',
}

const STATE_ICON: Record<ApState, ReactNode> = {
  missing: <IconCoin />,
  update: <IconArrowBigUpLines />,
  current: <IconTrophy />,
  unknown: <IconQuestionMark />,
  appimage: <IconPackageImport />,
  unchecked: <IconCircleCheck />,
}

const OFFER_ICON: Record<Offer, ReactNode> = {
  install: <IconDownload />,
  update: <IconArrowBigUpLines />,
  reinstall: <IconRefresh />,
  migrate: <IconPackageImport />,
}

export function InstallHero({
  state,
  installed,
  latest,
  latestStatus,
  os,
  offer,
  onOffer,
}: InstallHeroProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const titleId = useId()
  const latestVersion = latest?.version ?? null
  const key = `screens.install.state.${state}`

  const title =
    state === 'unchecked' ? t(`${key}.title`, { version: installed?.version ?? '' }) : t(`${key}.title`)
  // A folder picked by hand gets no offer: the body says why and what to do instead.
  const handPicked = isHandPicked(installed) && (state === 'update' || state === 'unknown')
  const body =
    state === 'unchecked'
      ? t(latestStatus === 'loading' ? `${key}.checking` : `${key}.error`)
      : t(handPicked ? `${key}.handPicked` : `${key}.body`, { version: latestVersion ?? '' })

  const offerLabel = (choice: Offer): string => {
    if (choice === 'migrate') return t('screens.install.offer.migrate')
    if (!latestVersion)
      return t(`screens.install.offer.${choice === 'reinstall' ? 'reinstallAny' : 'installAny'}`)
    return t(`screens.install.offer.${choice}`, { version: latestVersion })
  }

  const published = latest ? formatDate(latest.publishedAt, i18n.language) : null

  return (
    <section
      className={cx('install-hero pixel-border', toneClass(STATE_TONE[state]))}
      aria-labelledby={titleId}
      data-state={state}
    >
      <div className="install-hero__main">
        <span className="install-hero__eyebrow t-display">
          <span className="install-hero__badge" aria-hidden="true">
            {STATE_ICON[state]}
          </span>
          {t(`${key}.eyebrow`)}
        </span>
        <h2 id={titleId} className="install-hero__title">
          {title}
        </h2>
        <p className="install-hero__body">{body}</p>
        {offer && (
          <div className="install-hero__cta">
            <NeonButton size="lg" icon={OFFER_ICON[offer]} sound="coin" onClick={onOffer}>
              {offerLabel(offer)}
            </NeonButton>
          </div>
        )}
        {offer && os === 'win32' && (
          <p className="install-note tone-cyan install-hero__uac">
            <IconShieldLock aria-hidden="true" />
            <span>{t('screens.install.offer.uac')}</span>
          </p>
        )}
      </div>

      <div className="install-hero__versions" role="group" aria-label={t('screens.install.versions.label')}>
        <VersionCard
          tone={installed ? STATE_TONE[state] : 'neutral'}
          label={t('screens.install.versions.installed')}
          value={
            !installed
              ? t('screens.install.versions.none')
              : (installed.version ?? t('screens.install.versions.unknown'))
          }
          hint={
            installed
              ? t(`screens.install.versions.kinds.${installed.kind}`)
              : t('screens.install.versions.notInstalled')
          }
          dim={!installed || !installed.version}
        />
        <span className="install-hero__arrow" aria-hidden="true">
          {state === 'current' ? <IconEqual /> : <IconChevronsRight />}
        </span>
        <VersionCard
          tone="violet"
          label={t('screens.install.versions.latest')}
          value={
            latestStatus === 'ok' && latest ? (
              latest.version
            ) : latestStatus === 'loading' ? (
              <Spinner size="sm" />
            ) : (
              '?'
            )
          }
          hint={
            latestStatus === 'loading'
              ? t('screens.install.versions.checking')
              : latestStatus === 'error'
                ? t('screens.install.versions.unavailable')
                : published
                  ? t('screens.install.versions.published', { date: published })
                  : undefined
          }
          dim={latestStatus !== 'ok'}
        />
      </div>
    </section>
  )
}

interface VersionCardProps {
  label: string
  value: ReactNode
  hint?: string
  tone: Tone
  dim?: boolean
}

/** A version shown like an arcade score. */
function VersionCard({ label, value, hint, tone, dim = false }: VersionCardProps): React.JSX.Element {
  return (
    <div className={cx('install-version pixel-border', toneClass(tone), dim && 'install-version--dim')}>
      <span className="install-version__label">{label}</span>{' '}
      <span className="install-version__value">{value}</span>
      {hint !== undefined && (
        <>
          {' '}
          <span className="install-version__hint">{hint}</span>
        </>
      )}
    </div>
  )
}

function formatDate(iso: string, lang: string): string | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(date)
}
