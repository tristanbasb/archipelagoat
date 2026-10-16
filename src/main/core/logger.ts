// Logging for the main process. A Logger fans each entry out to sinks (console, rotating file). Every
// line a sink writes goes through `redact`, so no secret reaches a log, the crash handlers' included.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './system/redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  level: LogLevel
  message: string
  data?: unknown
}

export type LogSink = (entry: LogEntry) => void

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

function formatData(data: unknown): string {
  if (data instanceof Error) return data.stack ?? `${data.name}: ${data.message}`
  try {
    return JSON.stringify(data) ?? String(data)
  } catch {
    return '[unserializable]'
  }
}

/**
 * One line: `<ISO time> <LEVEL> <message> [data as JSON, or the error stack]`, secrets masked. It is
 * the one place a line is made, so the masking covers the message and the data alike.
 */
export function formatLogEntry(entry: LogEntry): string {
  const head = `${entry.ts} ${entry.level.toUpperCase()} ${entry.message}`
  return redact(entry.data === undefined ? head : `${head} ${formatData(entry.data)}`)
}

export const consoleSink: LogSink = (entry) => {
  const line = formatLogEntry(entry)
  if (entry.level === 'error') console.error(line)
  else console.log(line)
}

export function createLogger(sinks: LogSink[]): Logger {
  const write = (level: LogLevel, message: string, data: unknown): void => {
    const entry: LogEntry = { ts: new Date().toISOString(), level, message }
    if (data !== undefined) entry.data = data
    for (const sink of sinks) {
      try {
        sink(entry)
      } catch {
        // A broken sink (full disk, closed stream) must never take the app down.
      }
    }
  }
  return {
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  }
}

const LOG_STEM = 'archipelagoat'
export const FILE_LOG_NAME = `${LOG_STEM}.log`
export const FILE_LOG_MAX_FILES = 5
export const FILE_LOG_MAX_BYTES = 5 * 1024 * 1024

export interface FileSinkOptions {
  /** Size at which the current file is rotated. Default 5 MiB. */
  maxBytes?: number
  /** Files kept, the current one included: `archipelagoat.log`, `archipelagoat.1.log`… Default 5. */
  maxFiles?: number
}

const rotatedName = (index: number): string => `${LOG_STEM}.${index}.log`

function renameIfExists(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function sizeOrZero(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Appends every line to `<dir>/archipelagoat.log` (the folder is created on the first line). When a
 * line would take the file over `maxBytes`, the files move up one number and the oldest is deleted.
 * The writes are synchronous so that the line of a crash is on disk before the process exits.
 * Throws when the file cannot be written: `createLogger` keeps such a failure from the app.
 */
export function createFileSink(dir: string, opts: FileSinkOptions = {}): LogSink {
  const maxBytes = opts.maxBytes ?? FILE_LOG_MAX_BYTES
  const maxFiles = Math.max(1, opts.maxFiles ?? FILE_LOG_MAX_FILES)
  const current = join(dir, FILE_LOG_NAME)
  let size: number | null = null

  const rotate = (): void => {
    if (maxFiles === 1) return rmSync(current, { force: true })
    rmSync(join(dir, rotatedName(maxFiles - 1)), { force: true })
    for (let i = maxFiles - 2; i >= 1; i--)
      renameIfExists(join(dir, rotatedName(i)), join(dir, rotatedName(i + 1)))
    renameIfExists(current, join(dir, rotatedName(1)))
  }

  return (entry) => {
    const line = `${formatLogEntry(entry)}\n`
    const bytes = Buffer.byteLength(line)
    if (size === null) {
      mkdirSync(dir, { recursive: true })
      size = sizeOrZero(current)
    }
    if (size > 0 && size + bytes > maxBytes) {
      try {
        rotate()
      } catch {
        // A file held by another program (antivirus, an editor) cannot be renamed on Windows: keep
        // writing to this one and try again after another `maxBytes`.
      }
      size = 0
    }
    appendFileSync(current, line)
    size += bytes
  }
}

/** A logger that only writes the rotating, masked file of `dir`. */
export function createFileLogger(dir: string, opts?: FileSinkOptions): Logger {
  return createLogger([createFileSink(dir, opts)])
}
