// Linux desktop integration (spec §3.15): an entry in ~/.local/share/applications that opens
// archipelago:// links, .apworld files and patches with ArchipelaGOAT, the shared-mime-info types of
// those files, then the desktop databases refreshed and the app made their default handler. Archipelago
// registers none of this on Linux (research brief §1.3). Nothing needs root.
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { PATCH_ROUTES } from '@shared/data/patch-routes'
import { AppError } from '@shared/errors'
import type { ExecFn } from '../exec'
import { pathExists, writeFileAtomic } from './fsx'

/** The desktop file id, which `xdg-mime default` names. */
export const DESKTOP_FILE = 'archipelagoat.desktop'
const MIME_FILE = 'archipelagoat.xml'
const ICON_NAME = 'archipelagoat'

export const LINUX_MIME_TYPES = [
  'x-scheme-handler/archipelago',
  'application/x-apworld',
  'application/x-archipelago-patch',
] as const

const TOOL_TIMEOUT_MS = 15_000

/** `${XDG_DATA_HOME:-~/.local/share}`, where the user's applications, MIME types and icons live. */
export function linuxDataHome(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_DATA_HOME
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share')
}

/** The files the integration owns under `dataHome`. */
function integrationFiles(dataHome: string): { desktop: string; mime: string; icon: string } {
  return {
    desktop: path.join(dataHome, 'applications', DESKTOP_FILE),
    mime: path.join(dataHome, 'mime', 'packages', MIME_FILE),
    icon: path.join(dataHome, 'icons', 'hicolor', '512x512', 'apps', `${ICON_NAME}.png`),
  }
}

/**
 * One argument of `Exec`, as the Desktop Entry spec asks: quoted, with `"`, `` ` ``, `$` and `\`
 * escaped inside the quotes; then the string escape of the file doubles every backslash once more,
 * and a literal `%` is written `%%`.
 */
function execArg(arg: string): string {
  if (/[\p{Cc}]/u.test(arg)) {
    throw new AppError('INVALID_INPUT', undefined, { detail: 'a control character in the Exec path' })
  }
  const quoted = arg.replace(/["`$\\]/g, '\\$&')
  return `"${quoted.replaceAll('\\', '\\\\').replaceAll('%', '%%')}"`
}

export interface DesktopEntryOptions {
  /** What runs: `process.env.APPIMAGE ?? process.execPath` (an AppImage's execPath is a temporary mount). */
  execPath: string
  /** In development, the entry point Electron runs. */
  args?: string[]
  /** An absolute icon file, or the name of an icon of the theme. */
  iconPath: string
}

/** The `.desktop` file: `Exec="<execPath>" %u` takes one link or file at a time. */
export function desktopEntry({ execPath, args = [], iconPath }: DesktopEntryOptions): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=ArchipelaGOAT',
    `Exec=${[execPath, ...args].map(execArg).join(' ')} %u`,
    `Icon=${iconPath}`,
    'Terminal=false',
    'Categories=Game;',
    `MimeType=${LINUX_MIME_TYPES.map((type) => `${type};`).join('')}`,
    '',
  ].join('\n')
}

/** Patch files are named after their world's `patch_file_ending`: the ones the join flow opens. */
const PATCH_SUFFIXES = [...new Set(PATCH_ROUTES.map((route) => route.suffix))]

/** The shared-mime-info types of .apworld files and patches (both are zip archives). */
export function mimeXml(): string {
  const type = (name: string, en: string, fr: string, suffixes: readonly string[]): string[] => [
    `  <mime-type type="${name}">`,
    `    <comment>${en}</comment>`,
    `    <comment xml:lang="fr">${fr}</comment>`,
    '    <sub-class-of type="application/zip"/>',
    ...suffixes.map((suffix) => `    <glob pattern="*${suffix}"/>`),
    '  </mime-type>',
  ]
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
    ...type('application/x-apworld', 'Archipelago world', 'Monde Archipelago', ['.apworld']),
    ...type('application/x-archipelago-patch', 'Archipelago patch', 'Patch Archipelago', PATCH_SUFFIXES),
    '</mime-info>',
    '',
  ].join('\n')
}

export interface LinuxIntegrationPaths {
  /** `linuxDataHome(...)`. */
  dataHome: string
  execPath: string
  args?: string[]
  /** The app's icon (`$APPDIR/.DirIcon` in an AppImage); null or missing: the theme's `archipelagoat`. */
  iconSource: string | null
}

/** What the desktop tools could not do: they are missing on some systems, which is no reason to fail. */
export interface ToolsReport {
  failed: string[]
}

async function runTools(
  exec: ExecFn,
  commands: readonly (readonly [string, string[]])[],
): Promise<ToolsReport> {
  const failed: string[] = []
  for (const [command, args] of commands) {
    try {
      const result = await exec(command, args, { timeoutMs: TOOL_TIMEOUT_MS })
      if (result.code !== 0) failed.push(command)
    } catch {
      failed.push(command)
    }
  }
  return { failed }
}

const refreshCommands = (dataHome: string): [string, string[]][] => [
  ['update-mime-database', [path.join(dataHome, 'mime')]],
  ['update-desktop-database', [path.join(dataHome, 'applications')]],
]

const isFile = (p: string): Promise<boolean> =>
  stat(p).then(
    (info) => info.isFile(),
    () => false,
  )

/** True when the desktop entry is there. */
export function isLinuxIntegrationInstalled(dataHome: string): Promise<boolean> {
  return pathExists(integrationFiles(dataHome).desktop)
}

/**
 * Writes the entry, the MIME types and the icon, refreshes the databases, then makes the app the
 * default handler of its types. Throws when a file cannot be written; a tool that fails is reported.
 */
export async function installLinuxIntegration(
  exec: ExecFn,
  paths: LinuxIntegrationPaths,
): Promise<ToolsReport> {
  const files = integrationFiles(paths.dataHome)
  let iconPath = ICON_NAME
  if (paths.iconSource !== null && (await isFile(paths.iconSource))) {
    await mkdir(path.dirname(files.icon), { recursive: true })
    await copyFile(paths.iconSource, files.icon)
    iconPath = files.icon
  }
  const entry = desktopEntry({ execPath: paths.execPath, args: paths.args ?? [], iconPath })
  await writeFileAtomic(files.mime, mimeXml())
  await writeFileAtomic(files.desktop, entry)
  return runTools(exec, [
    ...refreshCommands(paths.dataHome),
    ['xdg-mime', ['default', DESKTOP_FILE, ...LINUX_MIME_TYPES]],
  ])
}

/** Removes what `installLinuxIntegration` wrote and refreshes the databases. */
export async function removeLinuxIntegration(
  exec: ExecFn,
  paths: Pick<LinuxIntegrationPaths, 'dataHome'>,
): Promise<ToolsReport> {
  const files = integrationFiles(paths.dataHome)
  for (const file of [files.desktop, files.mime, files.icon]) await rm(file, { force: true })
  return runTools(exec, refreshCommands(paths.dataHome))
}
