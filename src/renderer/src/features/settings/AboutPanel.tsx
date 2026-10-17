// About ArchipelaGOAT: version, the unofficial notice, attributions, dependency licenses (generated at
// packaging time, absent from development builds) and the auto-update state.
import { IconChevronRight, IconExternalLink, IconLicense } from '@tabler/icons-react'
import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '@shared/types'
import { cx } from '../../design/classes'
import { Badge, PixelPanel, StatusPill } from '../../design/components'
import { useIpcMutation } from '../../hooks/useIpc'
import { GoatMark, IslandMark, Wordmark } from '../../layout/Logo'
import { useErrorToast } from './feedback'
import { BUNDLED_LICENSES, type LicenseEntry } from './licenses'

/** The sources the app builds on, as the research brief asks to credit them (§ licensing). */
const CREDITS: readonly { id: string; url: string; license: string | null }[] = [
  { id: 'archipelago', url: 'https://github.com/ArchipelagoMW/Archipelago', license: 'MIT' },
  { id: 'wiki', url: 'https://archipelago.miraheze.org/', license: 'CC BY-NC-SA 4.0' },
  // The index publishes no license: it is credited, and fetched at runtime only.
  { id: 'ionium', url: 'https://github.com/ionium-ap/Archipelago-index', license: null },
]

export interface AboutPanelProps {
  info: AppInfo
  /** The bundled license list; null in development builds (tests pass their own). */
  licenses?: LicenseEntry[] | null
}

export function AboutPanel({ info, licenses = BUNDLED_LICENSES }: AboutPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const showError = useErrorToast()
  const openExternal = useIpcMutation('app:openExternal', { onError: showError })
  const k = (key: string): string => t(`screens.settings.about.${key}`)

  const follow = (event: MouseEvent<HTMLAnchorElement>, url: string): void => {
    // The page must not navigate: the main process hands allow-listed links to the browser.
    event.preventDefault()
    openExternal.mutate({ url })
  }

  return (
    <PixelPanel eyebrow={k('eyebrow')} title={k('title')} tone="violet" glow>
      <div className="about">
        <div className="about__hero">
          <div className="about__art" aria-hidden="true">
            <IslandMark kind="palm" size={44} className="about__island--left" />
            <GoatMark size={88} className="about__goat" />
            <IslandMark kind="rock" size={36} className="about__island--right" />
          </div>
          <div className="about__identity">
            <div className="about__name">
              <Wordmark className="about__wordmark" />
              <Badge tone="violet">{t('shell.status.version', { version: info.version })}</Badge>
            </div>
            <p className="about__unofficial">{t('common.unofficial')}</p>
            <p className="about__tagline">{k('tagline')}</p>
            <p className="about__affiliation">{k('notAffiliated')}</p>
          </div>
        </div>

        <dl className="about__facts">
          <div>
            <dt>{k('target')}</dt>
            <dd>{k('targetValue')}</dd>
          </div>
          <div>
            <dt>{k('system')}</dt>
            <dd>{k(`systems.${info.os}`)}</dd>
          </div>
          <div>
            <dt>{k('build')}</dt>
            <dd>{k(info.isPackaged ? 'builds.packaged' : 'builds.dev')}</dd>
          </div>
          <div>
            <dt>{k('updates')}</dt>
            <dd>
              <StatusPill status="idle" label={k('updatesState')} />
            </dd>
          </div>
        </dl>

        <div className="about__section">
          <h3 className="about__heading">{k('attributions')}</h3>
          <ul className="about__credits">
            {CREDITS.map(({ id, url, license }) => (
              <li key={id} className="about__credit">
                <a href={url} className="about__link" onClick={(event) => follow(event, url)}>
                  {k(`credits.${id}.name`)}
                  <IconExternalLink aria-hidden="true" />
                  <span className="sr-only"> {k('external')}</span>
                </a>
                <p>{k(`credits.${id}.body`)}</p>
                {license && (
                  <Badge tone="green" outline className="about__credit-license">
                    {t('screens.settings.about.license', { name: license })}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="about__section">
          <h3 className="about__heading">{k('licenses')}</h3>
          {licenses ? <LicenseList licenses={licenses} /> : <MissingLicenses />}
        </div>
      </div>
    </PixelPanel>
  )
}

function LicenseList({ licenses }: { licenses: LicenseEntry[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <details className="about__licenses">
      <summary>
        <IconChevronRight aria-hidden="true" className="about__chevron" />
        <IconLicense aria-hidden="true" />
        <span>{t('screens.settings.about.licensesShow')}</span>
        <Badge outline>{t('screens.settings.about.licensesCount', { count: licenses.length })}</Badge>
      </summary>
      <ul className="about__license-list">
        {licenses.map((entry) => (
          <li key={`${entry.name}@${entry.version}`}>
            <span className="about__package">{entry.name}</span>
            <span className="about__package-version">{entry.version}</span>
            <span className={cx('about__package-license', !entry.license && 'about__package-license--none')}>
              {entry.license ?? t('screens.settings.about.licenseUnknown')}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function MissingLicenses(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="about__missing">
      <IconLicense aria-hidden="true" />
      <div>
        <p className="about__missing-title">{t('screens.settings.about.licensesMissing')}</p>
        <p className="settings-muted">{t('screens.settings.about.licensesMissingBody')}</p>
      </div>
    </div>
  )
}
