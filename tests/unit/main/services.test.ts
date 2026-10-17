import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreContext } from '@main/core/context'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry, type HandlerModule } from '@main/ipc/registry'
import { createServices } from '@main/services'
import { createServiceRegistry } from '@main/services/registry'
import { createTestContext } from '../../helpers/core'

interface TestServices {
  alpha: { name: string; beta: { n: number } }
  beta: { n: number }
  a: { id: string }
  b: { id: string }
  c: { id: string }
}

const ctx = {} as CoreContext
const meta = { senderId: 1 }

describe('service registry', () => {
  it('instantiates services lazily once and resolves dependencies via get', () => {
    const registry = createServiceRegistry<TestServices>()
    const alpha = vi.fn(
      (_ctx: CoreContext, get: <N extends keyof TestServices>(n: N) => TestServices[N]) => ({
        name: 'alpha',
        beta: get('beta'),
      }),
    )
    const beta = vi.fn(() => ({ n: 1 }))
    registry.defineService('alpha', alpha)
    registry.defineService('beta', beta)

    const services = registry.createServices(ctx)
    expect(alpha).not.toHaveBeenCalled()
    expect(beta).not.toHaveBeenCalled()

    const instance = services.get('alpha')
    expect(instance.beta).toBe(services.get('beta'))
    expect(services.get('alpha')).toBe(instance)
    expect(alpha).toHaveBeenCalledOnce()
    expect(alpha).toHaveBeenCalledWith(ctx, expect.any(Function))
    expect(beta).toHaveBeenCalledOnce()
    expect(services.ctx).toBe(ctx)
  })

  it('throws on dependency cycle with the cycle path', () => {
    const registry = createServiceRegistry<TestServices>()
    registry.defineService('a', (_ctx, get) => ({ id: get('b').id }))
    registry.defineService('b', (_ctx, get) => ({ id: get('c').id }))
    registry.defineService('c', (_ctx, get) => ({ id: get('a').id }))
    const services = registry.createServices(ctx)
    expect(() => services.get('a')).toThrow('service cycle: a → b → c → a')
    expect(() => services.get('b')).toThrow('service cycle: b → c → a → b')
  })

  it('startEager instantiates only eager services', () => {
    const registry = createServiceRegistry<TestServices>()
    const a = vi.fn(() => ({ id: 'a' }))
    const b = vi.fn(() => ({ id: 'b' }))
    const c = vi.fn(() => ({ id: 'c' }))
    registry.defineService('a', a, { eager: true })
    registry.defineService('b', b)
    registry.defineService('c', c, { eager: false })
    const services = registry.createServices(ctx)
    services.startEager()
    services.startEager()
    expect(a).toHaveBeenCalledOnce()
    expect(b).not.toHaveBeenCalled()
    expect(c).not.toHaveBeenCalled()
  })

  it('refuses a duplicate definition and unknown names', () => {
    const registry = createServiceRegistry<TestServices>()
    registry.defineService('a', () => ({ id: 'a' }))
    expect(() => registry.defineService('a', () => ({ id: 'again' }))).toThrow(/already defined: a/)
    expect(() => registry.createServices(ctx).get('b')).toThrow(/unknown service: b/)
  })

  it('does not cache a factory that failed', () => {
    const registry = createServiceRegistry<TestServices>()
    let attempts = 0
    registry.defineService('a', () => {
      attempts += 1
      if (attempts === 1) throw new Error('first try fails')
      return { id: 'a' }
    })
    const services = registry.createServices(ctx)
    expect(() => services.get('a')).toThrow('first try fails')
    expect(services.get('a')).toEqual({ id: 'a' })
  })
})

describe('services and handlers wiring', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goat-services-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('registerHandlers runs every handler module of src/main/ipc', async () => {
    const ipcDir = fileURLToPath(new URL('../../../src/main/ipc/', import.meta.url))
    const files = readdirSync(ipcDir).filter(
      (f) => f.endsWith('.ts') && !['index.ts', 'registry.ts'].includes(f),
    )
    expect(files).toContain('app.ts')
    const services = createServices(createTestContext(dir).ctx)

    // What each module registers when it is imported on its own…
    const expected: string[] = []
    for (const file of files) {
      const module = (await import(/* @vite-ignore */ join(ipcDir, file))) as { default: HandlerModule }
      module.default((name) => void expected.push(name), services)
    }
    // …is exactly what the glob of src/main/ipc/index.ts registers.
    const registered: string[] = []
    registerHandlers(services, (name) => void registered.push(name))
    expect(registered.sort()).toEqual(expected.sort())
  })

  it('app:openPath rejects paths outside allowed roots and accepts a root added by a provider', async () => {
    const core = createTestContext(dir)
    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    const outside = join(dir, 'outside')
    mkdirSync(outside)

    expect(await ipc.dispatch('app:openPath', { path: outside }, meta)).toMatchObject({
      ok: false,
      error: { code: 'PATH_FORBIDDEN' },
    })
    expect(await ipc.dispatch('app:openPath', { path: core.platform.paths.dataRoot }, meta)).toEqual({
      ok: true,
      value: undefined,
    })

    core.ctx.paths.addAllowedRoots(() => Promise.resolve([outside]))
    expect(await ipc.dispatch('app:openPath', { path: outside }, meta)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(core.openPath.mock.calls).toEqual([[core.platform.paths.dataRoot], [outside]])
  })
})
