// The sandboxed preload: exposes `window.goat` and nothing else. A sandboxed preload may only
// require('electron'), so the contract comes in as types only, plus the zod-free event name list;
// inputs are validated in the main process.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AppErrorData } from '@shared/errors'
import type { GoatApi, InvokeArgs } from '@shared/goat-api'
import type { ChannelName, ChannelOutput, IpcResult } from '@shared/ipc/contract'
import { EVENT_NAMES, type EventName } from '@shared/ipc/event-names'
import type { EventPayloads } from '@shared/ipc/events'

const knownEvents: ReadonlySet<string> = new Set(EVENT_NAMES)

type BridgedGoatError = AppErrorData & { name: 'GoatError'; message: string }

/**
 * contextBridge keeps only the message of an Error that crosses it, so `invoke` rejects with a plain
 * object shaped like GoatError instead; `instanceof GoatError` recognizes it in the renderer.
 */
function goatError(error: AppErrorData): BridgedGoatError {
  const message = error.detail === undefined ? error.code : `${error.code}: ${error.detail}`
  return { name: 'GoatError', message, ...error }
}

async function invoke<C extends ChannelName>(channel: C, ...args: InvokeArgs<C>): Promise<ChannelOutput<C>> {
  let result: IpcResult<ChannelOutput<C>>
  try {
    result = (await ipcRenderer.invoke(channel, args[0])) as IpcResult<ChannelOutput<C>>
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- see goatError
    throw goatError({ code: 'AP_UNKNOWN', detail: String(error) })
  }
  if (result.ok) return result.value
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- see goatError
  throw goatError(result.error)
}

function on<E extends EventName>(event: E, cb: (payload: EventPayloads[E]) => void): () => void {
  if (!knownEvents.has(event)) throw new Error(`unknown event: ${String(event)}`)
  // The renderer gets the payload only, never the IpcRendererEvent (it exposes `sender`).
  const listener = (_event: IpcRendererEvent, payload: EventPayloads[E]): void => cb(payload)
  ipcRenderer.on(event, listener)
  return () => {
    ipcRenderer.removeListener(event, listener)
  }
}

const goat: GoatApi = {
  invoke,
  on,
  os: process.platform === 'win32' ? 'win32' : 'linux',
  pathForFile: (file: Parameters<typeof webUtils.getPathForFile>[0]) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('goat', goat)
