import { z } from 'zod'
import type { JoinPlan, JoinTarget, TaskRef } from '../types'
import { channel, nonEmpty } from './contract'

const Port = z.number().int().min(1).max(65535)

export const JoinTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('room'), roomId: nonEmpty }),
  z.strictObject({
    kind: z.literal('address'),
    host: nonEmpty,
    port: Port,
    slot: z.string().nullable(),
    password: z.string().nullable(),
    game: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal('patch'), path: nonEmpty }),
])

const planId = nonEmpty

export const joinChannels = {
  'join:resolve': channel(z.strictObject({ input: nonEmpty }))<JoinTarget>(),
  /** Task result: `JoinPlan`. */
  'join:prepare': channel(
    z.strictObject({ target: JoinTargetSchema, slotName: nonEmpty.optional() }),
  )<TaskRef>(),
  'join:refresh': channel(z.strictObject({ planId }))<JoinPlan>(),
  'join:play': channel(z.strictObject({ planId }))<{ pid: number }>(),
  'join:textClient': channel(
    z.strictObject({
      host: nonEmpty,
      port: Port,
      /** Without it, the Text Client asks the player for the slot name. */
      slot: nonEmpty.optional(),
      password: z.string().optional(),
    }),
  )<{ pid: number }>(),
}
