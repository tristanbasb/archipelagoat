// The left rail: seven screens, Ctrl+1…7, labels on hover and focus.
import {
  IconDisc,
  IconFileCode,
  IconHome2,
  IconPlugConnected,
  IconSettings,
  IconUsersGroup,
  IconWorld,
  type Icon,
} from '@tabler/icons-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'
import { Kbd } from '../design/components'
import { usePortalContainer } from '../design/useEffectsPrefs'
import './Rail.css'

export type NavKey = 'home' | 'session' | 'join' | 'studio' | 'worlds' | 'vault' | 'settings'

export interface NavItem {
  key: NavKey
  to: string
  icon: Icon
  /** Path prefixes that belong to this entry. */
  match: string[]
}

/** In shortcut order: Ctrl+1 is the first one. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', to: '/', icon: IconHome2, match: ['/doctor', '/install'] },
  { key: 'session', to: '/session/new', icon: IconUsersGroup, match: ['/session', '/play'] },
  { key: 'join', to: '/join', icon: IconPlugConnected, match: ['/join'] },
  { key: 'studio', to: '/studio', icon: IconFileCode, match: ['/studio'] },
  { key: 'worlds', to: '/worlds', icon: IconWorld, match: ['/worlds'] },
  { key: 'vault', to: '/vault', icon: IconDisc, match: ['/vault'] },
  { key: 'settings', to: '/settings', icon: IconSettings, match: ['/settings'] },
]

function isActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/' && pathname === '/') return true
  return item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

interface Flyout {
  item: NavItem
  shortcut: number
  top: number
  left: number
}

export function Rail(): React.JSX.Element {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const [flyout, setFlyout] = useState<Flyout | null>(null)
  const container = usePortalContainer()

  const show = (item: NavItem, shortcut: number, target: HTMLElement): void => {
    const box = target.getBoundingClientRect()
    setFlyout({ item, shortcut, top: box.top + box.height / 2, left: box.right + 12 })
  }
  const hide = (): void => setFlyout(null)

  const link = (item: NavItem): React.JSX.Element => {
    const shortcut = NAV_ITEMS.indexOf(item) + 1
    const active = isActive(item, pathname)
    const Glyph = item.icon
    return (
      <li key={item.key}>
        <Link
          to={item.to}
          className="rail__link"
          aria-label={t(`nav.${item.key}`)}
          aria-current={active ? 'page' : undefined}
          aria-keyshortcuts={`Control+${shortcut}`}
          onPointerEnter={(event) => show(item, shortcut, event.currentTarget)}
          onPointerLeave={hide}
          onFocus={(event) => show(item, shortcut, event.currentTarget)}
          onBlur={hide}
          onClick={hide}
        >
          <Glyph className="rail__icon" aria-hidden="true" stroke={1.75} />
        </Link>
      </li>
    )
  }

  return (
    <nav className="rail" aria-label={t('nav.label')}>
      <ul className="rail__list">{NAV_ITEMS.slice(0, -1).map(link)}</ul>
      <ul className="rail__list rail__list--end">{NAV_ITEMS.slice(-1).map(link)}</ul>
      {flyout &&
        createPortal(
          <div
            className="rail-flyout tone-violet"
            style={{ top: flyout.top, left: flyout.left }}
            aria-hidden="true"
          >
            <span className="rail-flyout__label">{t(`nav.${flyout.item.key}`)}</span>
            <span className="rail-flyout__hint">{t(`nav.hints.${flyout.item.key}`)}</span>
            <span className="rail-flyout__keys">
              <Kbd>Ctrl</Kbd>
              <Kbd>{flyout.shortcut}</Kbd>
            </span>
          </div>,
          container,
        )}
    </nav>
  )
}
