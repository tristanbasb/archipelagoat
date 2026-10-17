// doctor:* handlers: the health check, its automatic fixes and the support bundle.
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerDoctorHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const doctor = (): ReturnType<typeof services.get<'doctor'>> => services.get('doctor')

  register('doctor:run', () => doctor().run())

  register('doctor:fix', ({ checkId }) => doctor().fix(checkId))

  // Made in the downloads folder, which app:openPath may open.
  register('doctor:supportBundle', async () => ({ path: await doctor().supportBundle() }))
}
