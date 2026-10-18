import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Http } from '@main/core/context'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import { createTestContext, httpStub, type TestCore } from '../../helpers/core'

// The same real excerpt of /api/datapackage as datapackage.test.ts.
const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../fixtures/checks/datapackage-excerpt.json', import.meta.url)),
  'utf8',
)

const meta = { senderId: 1 }

let root: string
let core: TestCore
let fetchRaw: ReturnType<typeof vi.fn<Http['fetchRaw']>>
let call: (name: string, input?: unknown) => Promise<unknown>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat checks handler é-'))
  core = createTestContext(root)
  fetchRaw = vi.fn<Http['fetchRaw']>(() => Promise.resolve(new Response(FIXTURE)))
  core.ctx.http = { ...httpStub, fetchRaw }
  const ipc = createIpcRegistry()
  registerHandlers(createServices(core.ctx), ipc.registerHandler)
  call = (name, input) => ipc.dispatch(name, input, meta)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('checks:estimate', () => {
  it('answers at once from the table on disk, whatever the refresh is doing', async () => {
    // A request that never ends: an answer that waited for it would never come.
    fetchRaw.mockImplementation(() => new Promise<Response>(() => undefined))
    expect(await call('checks:estimate', { games: ['Hollow Knight', 'Unknown'] })).toEqual({
      ok: true,
      value: {
        'Hollow Knight': { max: null, profiles: null },
        Unknown: { max: null, profiles: null },
      },
    })
  })

  it('starts the refresh at the first ask of the run, and tells when the table has changed', async () => {
    const changed = new Promise<void>((resolve) => core.ctx.bus.on('checks:changed', () => resolve()))
    await call('checks:estimate', { games: ['Hollow Knight'] })
    await changed
    expect(fetchRaw).toHaveBeenCalledTimes(1)

    expect(await call('checks:estimate', { games: ['Hollow Knight', 'A Short Hike', 'Unknown'] })).toEqual({
      ok: true,
      value: {
        'Hollow Knight': { max: 740, profiles: null },
        'A Short Hike': { max: 131, profiles: null },
        Unknown: { max: null, profiles: null },
      },
    })
    expect(fetchRaw).toHaveBeenCalledTimes(1)
  })

  it('does not retry a refresh that failed at every ask', async () => {
    fetchRaw.mockRejectedValue(new TypeError('fetch failed'))
    await call('checks:estimate', { games: ['Hollow Knight'] })
    await vi.waitFor(() => expect(fetchRaw).toHaveBeenCalledTimes(1))
    await call('checks:estimate', { games: ['Hollow Knight'] })
    await call('checks:estimate', { games: ['A Short Hike'] })
    expect(fetchRaw).toHaveBeenCalledTimes(1)
  })

  it('refuses a name that is empty and more than 2000 games', async () => {
    expect(await call('checks:estimate', { games: [''] })).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(
      await call('checks:estimate', { games: Array.from({ length: 2001 }, (_, n) => `G${n}`) }),
    ).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(await call('checks:estimate', { games: [], extra: 1 })).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })
    expect(fetchRaw).not.toHaveBeenCalled()
  })
})
