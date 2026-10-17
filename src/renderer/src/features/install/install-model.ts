// What the install screen offers, from the detected install and the latest release.
import type { ApInstall, ApInstallKind } from '@shared/types'

/** Where Archipelago stands compared with the latest release. */
export type ApState =
  /** Nothing installed. */
  | 'missing'
  /** Installed, older than the latest release. */
  | 'update'
  /** Installed, as recent as the latest release (or newer). */
  | 'current'
  /** Installed, but its version cannot be read or compared. */
  | 'unknown'
  /** An AppImage: never updated by the app, which offers its managed install instead. */
  | 'appimage'
  /** Installed, while the latest release is still unknown (loading or unreachable). */
  | 'unchecked'

export type Offer = 'install' | 'update' | 'reinstall' | 'migrate'

/** The query keys of `ap:detect` and `ap:latestRelease` (useIpcQuery keys a query by [channel, input]). */
export const DETECT_KEY = ['ap:detect', undefined] as const
export const RELEASE_KEY = ['ap:latestRelease', {}] as const

const OFFERS: Record<ApState, Offer | null> = {
  missing: 'install',
  update: 'update',
  unknown: 'reinstall',
  appimage: 'migrate',
  current: null,
  unchecked: null,
}

/** Whether the user picked this install's folder by hand (it then wins over every other one). */
export function isHandPicked(installed: ApInstall | null): boolean {
  return installed?.kind === 'custom'
}

/**
 * The one thing to do about Archipelago, if any. Never for a folder picked by hand: an install goes
 * to the usual folder, which the app does not use while that one is chosen.
 */
export function offerFor(state: ApState, installed: ApInstall | null): Offer | null {
  return isHandPicked(installed) ? null : OFFERS[state]
}

/** The task stages of an install, in order (Task 9). */
export const INSTALL_STAGES = ['download', 'verify', 'backup', 'quarantine', 'install', 'detect'] as const
export type InstallStage = (typeof INSTALL_STAGES)[number]

export function isInstallStage(stage: string | undefined): stage is InstallStage {
  return (INSTALL_STAGES as readonly string[]).includes(stage ?? '')
}

/** `x.y.z` as numbers (a missing patch is 0), or null when it does not look like a version. */
function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
}

/** Whether `installed` is older than `latest`; null when either cannot be read. */
export function isOlder(installed: string, latest: string): boolean | null {
  const a = versionParts(installed)
  const b = versionParts(latest)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

export function apState(installed: ApInstall | null, latest: string | null): ApState {
  if (!installed) return 'missing'
  if (installed.kind === 'linux-appimage') return 'appimage'
  if (!installed.version) return 'unknown'
  if (!latest) return 'unchecked'
  const older = isOlder(installed.version, latest)
  if (older === null) return 'unknown'
  return older ? 'update' : 'current'
}

/** Installs the app can remove: the ones the official installer or the app itself made. */
const REMOVABLE: readonly ApInstallKind[] = ['windows-installer', 'linux-managed']

export function canUninstall(install: ApInstall): boolean {
  return REMOVABLE.includes(install.kind)
}
