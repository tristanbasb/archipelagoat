import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOpenRequests, parseArgvRequests } from '@main/core/system/open-requests'
import { createServices } from '@main/services'
// The `openRequests` entry of Services.
import type {} from '@main/services/openRequests.service'
import type { OpenRequest } from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'

const URI = 'archipelago://archipelago.gg:38281'
const OTHER_URI = 'archipelago://Joueur:@archipelago.gg:51234?game=Celeste'

let dir: string
let core: TestCore
let exe: string
let patch: string
let entry: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat open requests é-'))
  core = createTestContext(dir)
  exe = join(dir, 'ArchipelaGOAT.exe')
  patch = join(dir, 'AP_123_P1_Joueur.apz5')
  entry = join(dir, 'out', 'main', 'index.js')
  mkdirSync(join(dir, 'out', 'main'), { recursive: true })
  for (const file of [exe, patch, entry]) writeFileSync(file, '')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Every app:openRequest the bus emits. */
function collectEvents(): OpenRequest[] {
  const events: OpenRequest[] = []
  core.ctx.bus.on('app:openRequest', (request) => void events.push(request))
  return events
}

describe('parseArgvRequests', () => {
  it('parseArgvRequests extracts uri and existing file, skips flags, exe and dev entry point', () => {
    const missing = join(dir, 'missing.apz5')
    // Packaged: argv[0] is the app; Chromium adds its own switches, in any position.
    expect(
      parseArgvRequests(
        [exe, '--allow-file-access-from-files', URI, patch, missing, '--original-process-start-time=1', dir],
        false,
      ),
    ).toEqual([
      { kind: 'uri', value: URI },
      { kind: 'file', value: patch },
    ])

    // Development (and Playwright): Electron runs the entry point, which is no file to open.
    expect(parseArgvRequests([exe, entry, '--inspect=5858', patch], true)).toEqual([
      { kind: 'file', value: patch },
    ])
    expect(parseArgvRequests([exe, entry], false)).toEqual([{ kind: 'file', value: entry }])
  })

  it('accepts file:// urls and archipelago links in any case, but no relative path', () => {
    expect(parseArgvRequests([exe, pathToFileURL(patch).href, 'ARCHIPELAGO://host:1'], false)).toEqual([
      { kind: 'file', value: patch },
      { kind: 'uri', value: 'ARCHIPELAGO://host:1' },
    ])
    // Relative to which folder? A second instance does not say: nothing is guessed.
    expect(parseArgvRequests([exe, 'AP_123_P1_Joueur.apz5', 'file://%%'], false)).toEqual([])
    expect(parseArgvRequests([], false)).toEqual([])
  })
})

describe('open requests queue', () => {
  it('cold-start requests wait in the queue for app:pendingOpenRequests', () => {
    const events = collectEvents()
    const queue = createOpenRequests({
      bus: core.ctx.bus,
      lifecycle: core.ctx.lifecycle,
      argv: [exe, URI, patch],
      defaultApp: false,
    })
    core.lifecycle.windowReady()

    expect(queue.drain()).toEqual([
      { kind: 'uri', value: URI },
      { kind: 'file', value: patch },
    ])
    expect(queue.drain()).toEqual([])
    expect(events).toEqual([])
  })

  it('a request that arrives before the renderer drained the queue waits for it', () => {
    const events = collectEvents()
    const queue = createOpenRequests({
      bus: core.ctx.bus,
      lifecycle: core.ctx.lifecycle,
      argv: [exe],
      defaultApp: false,
    })
    // The window is ready, but the renderer has not subscribed yet: an event would be lost.
    core.lifecycle.windowReady()
    core.lifecycle.secondInstance([exe, OTHER_URI])
    expect(events).toEqual([])
    expect(queue.drain()).toEqual([{ kind: 'uri', value: OTHER_URI }])

    core.lifecycle.openFile(patch)
    expect(events).toEqual([{ kind: 'file', value: patch }])
  })

  it('the queue drained before the window is ready is flushed as events once it is', () => {
    const events = collectEvents()
    const queue = createOpenRequests({
      bus: core.ctx.bus,
      lifecycle: core.ctx.lifecycle,
      argv: [exe],
      defaultApp: false,
    })
    expect(queue.drain()).toEqual([])
    core.lifecycle.secondInstance([exe, URI])
    core.lifecycle.openFile(join(dir, 'missing.apworld'))
    expect(events).toEqual([])

    core.lifecycle.windowReady()
    expect(events).toEqual([{ kind: 'uri', value: URI }])
    expect(queue.drain()).toEqual([])
  })

  it('second instance argv is forwarded as app:openRequest', () => {
    const events = collectEvents()
    // What src/main/index.ts does: eager services first, then the window loads.
    const services = createServices(core.ctx)
    services.startEager()
    core.lifecycle.windowReady()
    expect(services.get('openRequests').drain()).toEqual([])

    core.lifecycle.secondInstance([exe, '--allow-file-access-from-files', OTHER_URI, patch])
    expect(events).toEqual([
      { kind: 'uri', value: OTHER_URI },
      { kind: 'file', value: patch },
    ])
  })

  it('a second instance before the window loads is replayed into the queue', () => {
    const events = collectEvents()
    // Electron may fire second-instance before the services exist: the lifecycle keeps it.
    core.lifecycle.secondInstance([exe, URI])
    const services = createServices(core.ctx)
    services.startEager()
    core.lifecycle.windowReady()
    expect(services.get('openRequests').drain()).toEqual([{ kind: 'uri', value: URI }])
    expect(events).toEqual([])
  })
})
