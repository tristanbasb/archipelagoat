import { z } from 'zod'
import type { TaskRef, WebRoom, WebRoomRef } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

const roomId = nonEmpty

export const webhostChannels = {
  /** Needs the explicit consent given for this hosting (spec §6.2). Task result: `WebRoom`. */
  'webhost:host': channel(z.strictObject({ sessionId: nonEmpty, consent: z.literal(true) }))<TaskRef>(),
  'webhost:room': channel(z.strictObject({ roomId }))<WebRoom>(),
  'webhost:wake': channel(z.strictObject({ roomId }))<WebRoom>(),
  'webhost:command': channel(z.strictObject({ roomId, command: nonEmpty }))<void>(),
  'webhost:log': channel(z.strictObject({ roomId, fromByte: z.number().int().min(0) }))<{
    text: string
    nextByte: number
  }>(),
  'webhost:myRooms': channel(voidInput)<WebRoomRef[]>(),
  'webhost:openAsOwner': channel(z.strictObject({ roomId }))<void>(),
}
