// Logging for the main process. A Logger fans each entry out to sinks; Task 3 adds a rotating file
// sink that redacts secrets.

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

/** One line: `<ISO time> <LEVEL> <message> [data as JSON, or the error stack]`. */
export function formatLogEntry(entry: LogEntry): string {
  const head = `${entry.ts} ${entry.level.toUpperCase()} ${entry.message}`
  return entry.data === undefined ? head : `${head} ${formatData(entry.data)}`
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
