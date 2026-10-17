// The support bundle (spec §3.15): a zip of the logs and of the health check, made on this computer
// and never sent. Every file goes through `redact`, with the secrets the app knows as literals too.
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { ZipFile } from 'yazl'
import type { DoctorCheck, OS } from '@shared/types'
import type { Locator } from '../ap/locator'
import type { PlatformPaths } from '../context'
import { writeStreamAtomic } from './fsx'
import { redact } from './redact'

/** Archipelago's logs (its own folder, and the sessions' generations and servers) from this far back… */
export const AP_LOGS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** …the newest first, within this many bytes. */
export const AP_LOGS_MAX_BYTES = 20 * 1024 * 1024

export interface SupportBundleDeps {
  paths: Pick<PlatformPaths, 'dataRoot' | 'downloads'>
  appVersion: string
  os: OS
  locator: Pick<Locator, 'detect'>
  runDoctor: () => Promise<DoctorCheck[]>
  /** Passwords and tokens the app keeps, masked wherever they appear. */
  extraSecrets?: () => Promise<string[]>
  now?: () => Date
}

interface LogFile {
  /** The path inside the zip. */
  name: string
  file: string
  size: number
  mtime: Date
}

/** The files directly in `dir`, named `<prefix>/<file>` in the zip; [] when it cannot be read. */
async function listLogs(dir: string, prefix: string): Promise<LogFile[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: LogFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = path.join(dir, entry.name)
    const info = await stat(file).catch(() => null)
    if (info) files.push({ name: `${prefix}/${entry.name}`, file, size: info.size, mtime: info.mtime })
  }
  return files
}

/** The Archipelago logs to bundle: recent ones, newest first, while they fit (a big one is skipped). */
function pickApLogs(candidates: LogFile[], now: Date): LogFile[] {
  const since = now.getTime() - AP_LOGS_MAX_AGE_MS
  const picked: LogFile[] = []
  let total = 0
  for (const log of [...candidates].sort((a, b) => b.mtime.getTime() - a.mtime.getTime())) {
    if (log.mtime.getTime() < since || total + log.size > AP_LOGS_MAX_BYTES) continue
    picked.push(log)
    total += log.size
  }
  return picked
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `YYYYMMDD-HHmmss`, local time. */
function stamp(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Writes `<downloads>/archipelagoat-support-<YYYYMMDD-HHmmss>.zip` and returns its path: `doctor.json`,
 * the app's logs (`app-logs/`), and Archipelago's logs of the last 7 days, 20 MB at most (`ap-logs/`
 * for its own folder, `session-logs/<id>/` for the generations and servers of the sessions).
 */
export async function createSupportBundle(deps: SupportBundleDeps): Promise<string> {
  const now = deps.now?.() ?? new Date()
  const { dataRoot, downloads } = deps.paths
  const [secrets, install, checks] = await Promise.all([
    deps.extraSecrets?.() ?? Promise.resolve([]),
    deps.locator.detect().catch(() => null),
    deps.runDoctor(),
  ])

  const sessionsDir = path.join(dataRoot, 'sessions')
  const sessionIds = (await readdir(sessionsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  const apCandidates = [
    ...(install ? await listLogs(install.paths.logs, 'ap-logs') : []),
    ...(
      await Promise.all(
        sessionIds.map((id) => listLogs(path.join(sessionsDir, id, 'logs'), `session-logs/${id}`)),
      )
    ).flat(),
  ]
  const logs = [
    ...(await listLogs(path.join(dataRoot, 'logs'), 'app-logs')),
    ...pickApLogs(apCandidates, now),
  ]

  const zip = new ZipFile()
  const add = (name: string, text: string, mtime: Date): void =>
    zip.addBuffer(Buffer.from(redact(text, secrets), 'utf8'), name, { mtime })
  const report = { createdAt: now.toISOString(), appVersion: deps.appVersion, os: deps.os, checks }
  add('doctor.json', `${JSON.stringify(report, null, 2)}\n`, now)
  for (const log of logs) {
    // A log rotated or removed meanwhile is left out.
    const text = await readFile(log.file, 'utf8').catch(() => null)
    if (text !== null) add(log.name, text, log.mtime)
  }
  zip.end()

  const dest = path.join(downloads, `archipelagoat-support-${stamp(now)}.zip`)
  // yazl's output is a PassThrough, typed as the older stream interface.
  await writeStreamAtomic(dest, zip.outputStream as Readable)
  return redact(dest)
}
