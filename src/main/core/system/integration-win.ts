// Windows integration (spec §3.15). Archipelago's installer already registers archipelago:// and most
// patch suffixes: the app only offers, both off by default and for the current user only (HKCU, which
// wins over HKLM and is undone without a trace), to open the links itself and to open the suffixes
// the installer leaves without a program.
import { AppError } from '@shared/errors'
import type { Platform } from '../context'
import type { ExecFn } from '../exec'
import { readRegistryValues } from './registry'

/** The ProgID of the patches the app opens. */
export const WIN_PATCH_PROG_ID = 'ArchipelaGOAT.Patch'

/** Patch suffixes Archipelago's installer associates with nothing (research brief §1.11). */
export const WIN_UNASSOCIATED_SUFFIXES = ['.apsml2'] as const

const CLASSES = 'HKCU\\Software\\Classes'
const PROG_KEY = `${CLASSES}\\${WIN_PATCH_PROG_ID}`
const REG_TIMEOUT_MS = 15_000

/** The program that opens a file: the app, and in development the entry point Electron runs. */
export interface WinCommand {
  exe: string
  args: string[]
}

const failed = (detail: string): AppError =>
  new AppError('INSTALL_FAILED', { reason: 'integration' }, { detail })

/** `"<exe>" "<args>…" "%1"`, the open command of a ProgID. */
export function winOpenCommand({ exe, args }: WinCommand): string {
  return [exe, ...args, '%1'].map((part) => `"${part}"`).join(' ')
}

/** Makes the app (or no longer) the archipelago:// handler of this account. */
export function setWinProtocol(platform: Pick<Platform, 'setProtocolClient'>, on: boolean): void {
  if (!platform.setProtocolClient(on)) {
    throw failed(`the system refused to ${on ? 'register' : 'remove'} the archipelago:// handler`)
  }
}

/** `reg add` and `reg delete` take wide arguments, so accented paths are written as they are. */
async function reg(exec: ExecFn, args: string[]): Promise<void> {
  const result = await exec('reg', args, { timeoutMs: REG_TIMEOUT_MS })
  if (result.code !== 0) throw failed(`reg ${args.slice(0, 2).join(' ')}: ${result.stderr.trim()}`)
}

/**
 * Writes (`on`) or removes the ProgID `ArchipelaGOAT.Patch` and the association of each suffix of
 * `WIN_UNASSOCIATED_SUFFIXES` under HKCU\Software\Classes. Removing leaves a suffix the user has
 * since given to another program, and every key the app did not write.
 */
export async function setWinAssociations(exec: ExecFn, on: boolean, command: WinCommand): Promise<void> {
  if (on) {
    await reg(exec, ['add', `${PROG_KEY}\\shell\\open\\command`, '/ve', '/d', winOpenCommand(command), '/f'])
    await reg(exec, ['add', `${PROG_KEY}\\DefaultIcon`, '/ve', '/d', `"${command.exe}",0`, '/f'])
    for (const suffix of WIN_UNASSOCIATED_SUFFIXES) {
      await reg(exec, ['add', `${CLASSES}\\${suffix}`, '/ve', '/d', WIN_PATCH_PROG_ID, '/f'])
    }
    return
  }
  // reg.exe prints in the OEM code page: the reads go through PowerShell (readRegistryValues).
  for (const suffix of WIN_UNASSOCIATED_SUFFIXES) {
    const key = `${CLASSES}\\${suffix}`
    const values = await readRegistryValues(exec, key, { view64: true })
    if (values?.[''] === WIN_PATCH_PROG_ID) await reg(exec, ['delete', key, '/ve', '/f'])
  }
  if ((await readRegistryValues(exec, PROG_KEY, { view64: true })) !== null) {
    await reg(exec, ['delete', PROG_KEY, '/f'])
  }
}
