// Service registry. Each task adds its service in its own src/main/services/<name>.service.ts:
//
//   declare module '@main/services/registry' { interface Services { settings: ApSettings } }
//   defineService('settings', (ctx, get) => createApSettings(ctx, get('locator')), { eager: false })
//
// Reserved names: locator, processes, settings, installer, worlds, catalog, templates, studio,
// sessions, generator, servers, webhost, vault, bizhawk, join, doctor, integration, openRequests,
// updater. Eager services (instantiated at startup, so their lifecycle hooks and app:openPath roots
// are registered): locator (Task 6), processes (Task 7), servers (Task 16), openRequests and
// integration (Task 21), updater (Task 35), checks (0.2: removes the measure folders left behind).
import type { CoreContext } from '@main/core/context'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled by declaration merging
export interface Services {}

export type ServiceGetter<S> = <N extends keyof S>(name: N) => S[N]

export type ServiceFactory<S, K extends keyof S> = (ctx: CoreContext, get: ServiceGetter<S>) => S[K]

export interface ServiceContainer<S = Services> {
  readonly ctx: CoreContext
  /** Instantiates the service on first use (and its dependencies), then returns the same instance. */
  get: ServiceGetter<S>
  /** Instantiates every eager service; src/main/index.ts calls it right after createServices. */
  startEager(): void
}

export interface ServiceRegistry<S> {
  defineService<K extends keyof S>(name: K, factory: ServiceFactory<S, K>, opts?: { eager?: boolean }): void
  createServices(ctx: CoreContext): ServiceContainer<S>
}

interface Definition<S> {
  factory: (ctx: CoreContext, get: ServiceGetter<S>) => unknown
  eager: boolean
}

export function createServiceRegistry<S>(): ServiceRegistry<S> {
  const definitions = new Map<keyof S, Definition<S>>()

  return {
    defineService(name, factory, opts = {}) {
      if (definitions.has(name)) throw new Error(`service already defined: ${String(name)}`)
      definitions.set(name, { factory, eager: opts.eager ?? false })
    },

    createServices(ctx) {
      const instances = new Map<keyof S, unknown>()
      const resolving: (keyof S)[] = []

      const get = <N extends keyof S>(name: N): S[N] => {
        if (instances.has(name)) return instances.get(name) as S[N]
        const definition = definitions.get(name)
        if (!definition) throw new Error(`unknown service: ${String(name)}`)
        const start = resolving.indexOf(name)
        if (start !== -1) {
          throw new Error(`service cycle: ${[...resolving.slice(start), name].map(String).join(' → ')}`)
        }
        resolving.push(name)
        try {
          const instance = definition.factory(ctx, get) as S[N]
          instances.set(name, instance)
          return instance
        } finally {
          resolving.pop()
        }
      }

      return {
        ctx,
        get,
        startEager() {
          for (const [name, definition] of definitions) if (definition.eager) get(name)
        },
      }
    },
  }
}

const registry = createServiceRegistry<Services>()

export const defineService: ServiceRegistry<Services>['defineService'] = (name, factory, opts) =>
  registry.defineService(name, factory, opts)

export const createServices: ServiceRegistry<Services>['createServices'] = (ctx) =>
  registry.createServices(ctx)
