import { z } from 'zod'
import { DOCTOR_CHECK_IDS } from '../codes'
import type { DoctorCheck } from '../types'
import { channel, voidInput } from './contract'

export const doctorChannels = {
  'doctor:run': channel(voidInput)<DoctorCheck[]>(),
  'doctor:fix': channel(z.strictObject({ checkId: z.enum(DOCTOR_CHECK_IDS) }))<DoctorCheck[]>(),
  'doctor:supportBundle': channel(voidInput)<{ path: string }>(),
}
