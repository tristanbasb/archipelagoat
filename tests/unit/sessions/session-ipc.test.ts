import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFn } from '@main/core/exec'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
// The `sessions` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/sessions.service'
import { apExeFileName } from '@shared/data/ap-constants'
import { RULE_PRESETS } from '@shared/rules'
import type { Session, SessionSummary, SessionValidation } from '@shared/types'
import { createTestContext, hostOs, type TestCore } from '../../helpers/core'
import { apworldManifest, makeApworld } from '../../helpers/make-apworld'

let root: string
let core: TestCore
let call: <T>(name: string, input?: unknown) => Promise<T>
let raw: (name: string, input?: unknown) => Promise<unknown>

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat session ipc é-'))
  core = createTestContext(join(root, 'core'))
  // A fake Archipelago 0.6.8 with TUNIC installed, and no program running.
  const ap = join(root, 'AP')
  mkdirSync(ap)
  writeFileSync(join(ap, apExeFileName('ArchipelagoLauncher', hostOs)), '')
  writeFileSync(join(ap, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
  await makeApworld(join(ap, 'custom_worlds', 'tunic.apworld'), {
    manifest: apworldManifest('TUNIC', { world_version: '3.1.0' }),
  })
  core.ctx.config.updateInternal({ apPathOverride: ap })
  const exec: ExecFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
  core.ctx.exec = exec

  const ipc = createIpcRegistry()
  registerHandlers(createServices(core.ctx), ipc.registerHandler)
  raw = (name, input) => ipc.dispatch(name, input, { senderId: 1 })
  call = async <T>(name: string, input?: unknown): Promise<T> => {
    const result = await ipc.dispatch(name, input, { senderId: 1 })
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`)
    return result.value as T
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

describe('session handlers', () => {
  it('run the organizer flow of the wizard through the sessions service', async () => {
    const created = await call<Session>('session:create', { name: 'Soirée' })
    expect(await call<SessionSummary[]>('session:list')).toEqual([
      expect.objectContaining({ id: created.id, name: 'Soirée', playerCount: 0 }),
    ])

    const withAlice = await call<Session>('session:addText', {
      id: created.id,
      fileName: 'Alice.yaml',
      text: 'name: Alice\ngame: TUNIC\nTUNIC: {}\n',
    })
    const [file] = withAlice.players
    expect(file?.docs[0]).toMatchObject({ name: 'Alice', issues: [] })
    expect(await call('session:get', { id: created.id })).toEqual(withAlice)
    expect(await call('session:readFile', { id: created.id, fileId: file!.id })).toEqual({
      text: 'name: Alice\ngame: TUNIC\nTUNIC: {}\n',
    })

    expect(await call<SessionValidation>('session:validate', { id: created.id })).toMatchObject({
      missingWorlds: [],
      romNeeds: [],
      blocking: false,
    })
    await call('session:replaceFile', {
      id: created.id,
      fileId: file!.id,
      text: 'name: Alice\ngame: Zork\nZork: {}\n',
    })
    expect(await call<SessionValidation>('session:validate', { id: created.id })).toMatchObject({
      missingWorlds: [{ game: 'Zork', catalogId: null }],
      blocking: true,
    })

    const notes = join(root, 'notes.md')
    writeFileSync(notes, '# notes\n')
    const added = await call<{ session: Session; ignored: string[] }>('session:addFiles', {
      id: created.id,
      paths: [notes],
    })
    expect(added.ignored).toEqual([notes])

    expect(await call('session:update', { id: created.id, rules: RULE_PRESETS.async })).toMatchObject({
      rules: RULE_PRESETS.async,
    })
    expect(await call('session:setSecrets', { id: created.id, password: 'pw' })).toBeUndefined()
    expect(await call('session:getSecrets', { id: created.id })).toEqual({
      password: 'pw',
      serverPassword: null,
    })
    expect(await call<Session>('session:get', { id: created.id })).toMatchObject({ hasPassword: true })

    expect((await call<Session>('session:removeFile', { id: created.id, fileId: file!.id })).players).toEqual(
      [],
    )
    expect(await call('session:delete', { id: created.id })).toBeUndefined()
    expect(existsSync(created.workspace)).toBe(false)
    expect(await call('session:list')).toEqual([])
  })

  it('answers errors as codes; session:generate is not theirs', async () => {
    expect(await raw('session:get', { id: 's_missing' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'NOT_FOUND' }) as unknown,
    })
    const { id } = await call<Session>('session:create', { name: 'Goat' })
    expect(await raw('session:addFiles', { id, paths: ['relative.yaml'] })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'PATH_FORBIDDEN' }) as unknown,
    })
    expect(await raw('session:generate', { id })).toEqual({ ok: false, error: { code: 'NOT_IMPLEMENTED' } })
  })
})
