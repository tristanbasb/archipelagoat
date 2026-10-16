import { ERROR_CODES, type ErrorCode } from './codes'

/** Serializable error: what crosses IPC. The renderer shows `t('errors.<code>', params)`. */
export interface AppErrorData {
  code: ErrorCode
  params?: Record<string, string | number>
  detail?: string
  logPath?: string
}

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES)

function messageFor(code: ErrorCode, detail: string | undefined): string {
  return detail === undefined ? code : `${code}: ${detail}`
}

/** Copies the defined fields only, so the data compares and serializes cleanly. */
function pickData(data: AppErrorData): AppErrorData {
  const out: AppErrorData = { code: data.code }
  if (data.params !== undefined) out.params = data.params
  if (data.detail !== undefined) out.detail = data.detail
  if (data.logPath !== undefined) out.logPath = data.logPath
  return out
}

/** Error thrown by the main process. `message` is the code, then `: <detail>` when there is one. */
export class AppError extends Error {
  readonly code: ErrorCode
  declare readonly params?: Record<string, string | number>
  declare readonly detail?: string
  declare readonly logPath?: string

  constructor(
    code: ErrorCode,
    params?: Record<string, string | number>,
    opts: { detail?: string; logPath?: string; cause?: unknown } = {},
  ) {
    super(messageFor(code, opts.detail), opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'AppError'
    this.code = code
    if (params !== undefined) this.params = params
    if (opts.detail !== undefined) this.detail = opts.detail
    if (opts.logPath !== undefined) this.logPath = opts.logPath
  }

  toData(): AppErrorData {
    return pickData(this)
  }
}

export function isAppErrorData(x: unknown): x is AppErrorData {
  if (typeof x !== 'object' || x === null) return false
  const { code, params, detail, logPath } = x as Record<string, unknown>
  if (typeof code !== 'string' || !KNOWN_CODES.has(code)) return false
  if (detail !== undefined && typeof detail !== 'string') return false
  if (logPath !== undefined && typeof logPath !== 'string') return false
  if (params === undefined) return true
  if (typeof params !== 'object' || params === null) return false
  return Object.values(params).every((v) => typeof v === 'string' || typeof v === 'number')
}

/** Any thrown value as error data; anything that is not one of our errors becomes `AP_UNKNOWN`. */
export function toAppErrorData(e: unknown): AppErrorData {
  if (isAppErrorData(e)) return pickData(e)
  return { code: 'AP_UNKNOWN', detail: String(e) }
}

/** A plain object that has the shape of a GoatError (what the preload sends over the bridge). */
export function isGoatError(x: unknown): x is GoatError {
  return isAppErrorData(x) && (x as { name?: unknown }).name === 'GoatError'
}

/**
 * The error `window.goat.invoke` rejects with in the renderer.
 *
 * contextBridge keeps only the `message` of an Error that crosses it, so the preload rejects with a
 * plain object `{ name: 'GoatError', message, code, params?, detail?, logPath? }` instead. `instanceof
 * GoatError` (and `isGoatError`) accept both that object and real instances; read the fields, never
 * rely on the prototype.
 */
export class GoatError extends Error implements AppErrorData {
  readonly code: ErrorCode
  declare readonly params?: Record<string, string | number>
  declare readonly detail?: string
  declare readonly logPath?: string

  constructor(data: AppErrorData) {
    super(messageFor(data.code, data.detail))
    this.name = 'GoatError'
    this.code = data.code
    if (data.params !== undefined) this.params = data.params
    if (data.detail !== undefined) this.detail = data.detail
    if (data.logPath !== undefined) this.logPath = data.logPath
  }

  static [Symbol.hasInstance](x: unknown): x is GoatError {
    return isGoatError(x)
  }
}
