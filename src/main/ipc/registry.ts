// Main side of the IPC contract: one ipcMain handler per channel. Every input is validated with the
// channel's zod schema; every answer is an IpcResult, so errors cross IPC as data, secrets masked.
import type { Logger } from '@main/core/logger'
import { redact } from '@main/core/system/redact'
import type { ServiceContainer } from '@main/services/registry'
import { toAppErrorData, type AppErrorData } from '@shared/errors'
import { channels } from '@shared/ipc'
import {
  describeZodError,
  type ChannelInput,
  type ChannelName,
  type ChannelOutput,
  type IpcResult,
} from '@shared/ipc/contract'

export interface HandlerMeta {
  senderId: number
}

export type Handler<C extends ChannelName> = (
  input: ChannelInput<C>,
  meta: HandlerMeta,
) => Promise<ChannelOutput<C>>

export type RegisterHandler = <C extends ChannelName>(name: C, fn: Handler<C>) => void

/** Default export of each src/main/ipc/<domain>.ts module. */
export type HandlerModule = (register: RegisterHandler, services: ServiceContainer) => void

/** The part of Electron's ipcMain (and of its invoke event) the registry uses. */
export interface IpcEventLike {
  sender: { id: number }
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void
}

export interface IpcRegistry {
  registerHandler: RegisterHandler
  /** Registers every channel of the contract on ipcMain; unregistered ones answer NOT_IMPLEMENTED. */
  installIpc(ipcMain: IpcMainLike, opts?: { log?: Logger }): void
  /** What a renderer call goes through (exposed for tests). */
  dispatch(name: string, raw: unknown, meta: HandlerMeta, log?: Logger): Promise<IpcResult<unknown>>
}

type AnyHandler = (input: unknown, meta: HandlerMeta) => Promise<unknown>

const isChannel = (name: string): name is ChannelName => Object.hasOwn(channels, name)

/** The error as the renderer gets it: it shows the detail and the params raw, so secrets are masked. */
function redactError(error: AppErrorData): IpcResult<never> {
  const safe: AppErrorData = { ...error }
  if (error.detail !== undefined) safe.detail = redact(error.detail)
  if (error.params !== undefined) {
    safe.params = Object.fromEntries(
      Object.entries(error.params).map(([key, value]) => [
        key,
        typeof value === 'string' ? redact(value) : value,
      ]),
    )
  }
  return { ok: false, error: safe }
}

export function createIpcRegistry(): IpcRegistry {
  const handlers = new Map<ChannelName, AnyHandler>()

  const dispatch: IpcRegistry['dispatch'] = async (name, raw, meta, log) => {
    if (!isChannel(name)) return redactError({ code: 'NOT_FOUND', detail: name })
    const handler = handlers.get(name)
    if (!handler) return { ok: false, error: { code: 'NOT_IMPLEMENTED' } }
    const parsed = channels[name].input.safeParse(raw)
    if (!parsed.success) return redactError({ code: 'INVALID_INPUT', detail: describeZodError(parsed.error) })
    try {
      return { ok: true, value: await handler(parsed.data, meta) }
    } catch (error) {
      const data = toAppErrorData(error)
      // Our own errors are expected outcomes; anything else is a bug worth a stack trace.
      if (data.code === 'AP_UNKNOWN') log?.error(`ipc ${name} failed`, error)
      return redactError(data)
    }
  }

  return {
    registerHandler(name, fn) {
      if (handlers.has(name)) throw new Error(`ipc handler already registered: ${name}`)
      handlers.set(name, fn as AnyHandler)
    },
    installIpc(ipcMain, opts = {}) {
      for (const name of Object.keys(channels)) {
        ipcMain.handle(name, (event, raw) => dispatch(name, raw, { senderId: event.sender.id }, opts.log))
      }
    },
    dispatch,
  }
}

const registry = createIpcRegistry()

export const registerHandler: RegisterHandler = (name, fn) => registry.registerHandler(name, fn)

export const installIpc: IpcRegistry['installIpc'] = (ipcMain, opts) => registry.installIpc(ipcMain, opts)
