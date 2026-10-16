// The typed IPC contract: each channel pairs a strict zod input schema with a phantom output type.
// `channels` (./index.ts) merges one file per domain. The preload imports this file with `import type`
// only, so zod never reaches the sandboxed preload bundle.
import { z } from 'zod'
import type { AppErrorData } from '../errors'
import type { Channels } from './index'

declare const output: unique symbol

export interface ChannelDef<I extends z.ZodType, O> {
  readonly input: I
  /** Phantom: never set at runtime, it only carries the output type. */
  readonly [output]?: O
}

/** `channel(inputSchema)<Output>()`. */
export function channel<I extends z.ZodType>(input: I): <O>() => ChannelDef<I, O> {
  return <O>(): ChannelDef<I, O> => ({ input })
}

/** Input of a channel that takes nothing. */
export const voidInput = z.undefined().optional()

/** Ids, names and paths: a string that cannot be empty. */
export const nonEmpty = z.string().min(1)

/** `path.to.field: message; …` — the technical detail of an INVALID_INPUT error. */
export function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '<input>'}: ${issue.message}`)
    .join('; ')
}

export type ChannelName = keyof Channels
export type ChannelInput<C extends ChannelName> = z.input<Channels[C]['input']>
export type ChannelOutput<C extends ChannelName> =
  Channels[C] extends ChannelDef<z.ZodType, infer O> ? O : never

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorData }
