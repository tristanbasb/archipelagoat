import { z } from 'zod'
import type { EditorDoc, GameSchema, Issue, PlayerDoc, StudioGame } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

export const OptionValueSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('value'), value: z.unknown() }),
  z.strictObject({ mode: z.literal('weighted'), weights: z.record(z.string(), z.number()) }),
  z.strictObject({ mode: z.literal('raw'), yaml: z.string() }),
])

export const EditorDocSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  game: z.string(),
  requiresVersion: z.string().nullable(),
  options: z.record(z.string(), OptionValueSchema),
  extraRoot: z.record(z.string(), z.unknown()),
})

export const studioChannels = {
  'studio:games': channel(voidInput)<StudioGame[]>(),
  'studio:schema': channel(z.strictObject({ game: nonEmpty }))<GameSchema>(),
  'studio:parse': channel(z.strictObject({ text: z.string() }))<{ docs: EditorDoc[]; issues: Issue[] }>(),
  'studio:render': channel(z.strictObject({ doc: EditorDocSchema }))<{ text: string; issues: Issue[] }>(),
  'studio:validate': channel(z.strictObject({ text: z.string(), fileName: nonEmpty.optional() }))<
    PlayerDoc[]
  >(),
  /** Without `path`, the main process shows an open dialog; `null` when it is cancelled. */
  'studio:open': channel(z.strictObject({ path: nonEmpty.optional() }))<{
    path: string
    text: string
  } | null>(),
  'studio:save': channel(
    z.strictObject({ text: z.string(), path: nonEmpty.nullable(), suggestedName: nonEmpty }),
  )<{ path: string } | null>(),
}
