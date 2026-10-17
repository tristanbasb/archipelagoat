// The `doctor` service (Task 21): the health check, its automatic fixes and the support bundle.
import type { CoreContext } from '@main/core/context'
import { fixDoctor, runDoctor, type DoctorDeps } from '@main/core/system/doctor'
import { createSupportBundle } from '@main/core/system/support-bundle'
import type { DoctorCheckId } from '@shared/codes'
import type { DoctorCheck } from '@shared/types'
import { defineService, type ServiceGetter, type Services } from './registry'
// The entries of Services used below.
import type {} from './bizhawk.service'
import type {} from './locator.service'
import type {} from './processes.service'
import type {} from './servers.service'
import type {} from './sessions.service'
import type {} from './settings.service'

export interface Doctor {
  run(): Promise<DoctorCheck[]>
  /** The automatic fix of a check, then every check again (INVALID_INPUT for a check without one). */
  fix(checkId: DoctorCheckId): Promise<DoctorCheck[]>
  /** The path of a new support bundle, in the downloads folder. */
  supportBundle(): Promise<string>
}

declare module '@main/services/registry' {
  interface Services {
    doctor: Doctor
  }
}

const GITHUB_TOKEN = 'github.token'

export function createDoctor(ctx: CoreContext, get: ServiceGetter<Services>): Doctor {
  // The services are asked for when a check runs: the doctor itself is created on first use.
  const deps: DoctorDeps = {
    ctx,
    locator: get('locator'),
    settingsFile: () => get('settings').file(),
    bizhawkState: () => get('bizhawk').state(),
    listProcesses: () => get('processes').list(),
    ownServerPorts: () => {
      const servers = get('servers')
      return servers.running().flatMap((id) => servers.get(id)?.port ?? [])
    },
  }

  /** Every password and token the app keeps: masked in the bundle wherever they appear. */
  async function knownSecrets(): Promise<string[]> {
    const secrets = [ctx.secrets.get(GITHUB_TOKEN)]
    try {
      const sessions = get('sessions')
      for (const { id } of await sessions.list()) {
        const { password, serverPassword } = await sessions.getSecrets(id)
        secrets.push(password, serverPassword)
      }
    } catch (error) {
      ctx.log.warn('doctor: cannot read the session passwords for the support bundle', error)
    }
    return secrets.filter((secret): secret is string => Boolean(secret))
  }

  return {
    run: () => runDoctor(deps),
    fix: (checkId) => fixDoctor(checkId, deps),
    supportBundle: () =>
      createSupportBundle({
        paths: ctx.platform.paths,
        appVersion: ctx.platform.appVersion,
        os: ctx.platform.os,
        locator: deps.locator,
        runDoctor: () => runDoctor(deps),
        extraSecrets: knownSecrets,
      }),
  }
}

defineService('doctor', (ctx, get) => createDoctor(ctx, get), { eager: false })
