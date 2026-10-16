import { z } from 'zod'
import type { Session, SessionSummary, SessionValidation, TaskRef } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

const ReleaseModeSchema = z.enum(['auto', 'enabled', 'disabled', 'goal', 'auto-enabled'])

export const RulesSchema = z.strictObject({
  preset: z.enum(['casual', 'async', 'race', 'custom']),
  spoiler: z.literal([0, 1, 2, 3]),
  race: z.boolean(),
  hintCost: z.number().int().min(0).max(100),
  locationCheckPoints: z.number().int().min(0),
  releaseMode: ReleaseModeSchema,
  collectMode: ReleaseModeSchema,
  remainingMode: z.enum(['enabled', 'disabled', 'goal']),
  countdownMode: z.enum(['enabled', 'disabled', 'auto']),
  itemCheat: z.boolean(),
  autoShutdown: z.number().int().min(0),
  plando: z.array(z.enum(['bosses', 'items', 'texts', 'connections'])),
  compatibility: z.literal([0, 1, 2]),
})

const id = nonEmpty

export const sessionChannels = {
  'session:list': channel(voidInput)<SessionSummary[]>(),
  'session:create': channel(z.strictObject({ name: nonEmpty }))<Session>(),
  'session:get': channel(z.strictObject({ id }))<Session>(),
  'session:update': channel(
    z.strictObject({ id, name: nonEmpty.optional(), rules: RulesSchema.optional() }),
  )<Session>(),
  'session:delete': channel(z.strictObject({ id }))<void>(),
  'session:addFiles': channel(z.strictObject({ id, paths: z.array(nonEmpty) }))<{
    session: Session
    ignored: string[]
  }>(),
  'session:addText': channel(z.strictObject({ id, fileName: nonEmpty, text: z.string() }))<Session>(),
  'session:removeFile': channel(z.strictObject({ id, fileId: nonEmpty }))<Session>(),
  'session:readFile': channel(z.strictObject({ id, fileId: nonEmpty }))<{ text: string }>(),
  'session:replaceFile': channel(z.strictObject({ id, fileId: nonEmpty, text: z.string() }))<Session>(),
  'session:getSecrets': channel(z.strictObject({ id }))<{
    password: string | null
    serverPassword: string | null
  }>(),
  'session:setSecrets': channel(
    z.strictObject({
      id,
      password: z.string().nullable().optional(),
      serverPassword: z.string().nullable().optional(),
    }),
  )<void>(),
  'session:validate': channel(z.strictObject({ id }))<SessionValidation>(),
  /** Task result: `Generation`. */
  'session:generate': channel(z.strictObject({ id }))<TaskRef>(),
}
