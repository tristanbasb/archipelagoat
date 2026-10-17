import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionStore, type SessionStore } from '@main/core/sessions/store'
import type { ValidationContext } from '@main/core/yaml/validate'
import { AppError } from '@shared/errors'
import { defaultRules, RULE_PRESETS } from '@shared/rules'
import type { Generation, Hosting } from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'
import { makeZip } from './helpers'

const BOM = String.fromCharCode(0xfeff)
const YAMLS = fileURLToPath(new URL('../../fixtures/yamls/', import.meta.url))

let root: string
let core: TestCore
let installed: string[]
let contexts: { games: string[]; plando: readonly string[] }[]
let store: SessionStore
let clock: number

function context(games: string[], plando: readonly string[]): Promise<ValidationContext> {
  contexts.push({ games, plando })
  return Promise.resolve({
    installedGames: new Map(installed.map((game) => [game, { worldVersion: null }])),
    apVersion: '0.6.8',
    schemaFor: () => undefined,
    allowQuantity: false,
    plandoEnabled: [...plando],
  })
}

function makeStore(): SessionStore {
  return createSessionStore(core.ctx, {
    validationContext: context,
    // Each call one second later: updatedAt always moves.
    now: () => new Date((clock += 1000)),
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat sessions é-'))
  core = createTestContext(join(root, 'core'))
  installed = ['TUNIC']
  contexts = []
  clock = Date.UTC(2026, 9, 17, 12, 0, 0)
  store = makeStore()
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

const dataRoot = (): string => core.platform.paths.dataRoot
const player = (name: string, game = 'TUNIC'): string => `name: ${name}\ngame: ${game}\n${game}: {}\n`

function userFile(name: string, data: string | Buffer): string {
  const file = join(root, 'Téléchargements', name)
  mkdirSync(join(root, 'Téléchargements'), { recursive: true })
  writeFileSync(file, data)
  return file
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

describe('session store: lifecycle', () => {
  it('create/list/get/update/delete roundtrip; delete moves to backups', async () => {
    expect(await store.list()).toEqual([])
    const created = await store.create('Soirée GOAT')
    expect(created.id).toMatch(/^s_[0-9a-z]+[0-9a-z]{4}$/)
    expect(created).toEqual({
      id: created.id,
      name: 'Soirée GOAT',
      createdAt: '2026-10-17T12:00:01.000Z',
      updatedAt: '2026-10-17T12:00:01.000Z',
      status: 'draft',
      players: [],
      rules: defaultRules(),
      hasPassword: false,
      hasServerPassword: false,
      generation: null,
      hosting: null,
      workspace: join(dataRoot(), 'sessions', created.id),
    })
    for (const dir of ['players', 'output', 'logs']) {
      expect(statSync(join(created.workspace, dir)).isDirectory()).toBe(true)
    }
    if (process.platform === 'linux') expect(statSync(created.workspace).mode & 0o777).toBe(0o700)

    // Another store (the next run of the app) reads the same session.
    expect(await makeStore().get(created.id)).toEqual(created)

    const renamed = await store.update(created.id, {
      name: '  Course du vendredi ',
      rules: RULE_PRESETS.race,
    })
    expect(renamed).toMatchObject({
      name: 'Course du vendredi',
      rules: RULE_PRESETS.race,
      createdAt: created.createdAt,
      updatedAt: '2026-10-17T12:00:02.000Z',
    })
    expect(await store.get(created.id)).toEqual(renamed)
    expect(await store.update(created.id, {})).toMatchObject({ name: 'Course du vendredi' })

    const other = await store.create('Async')
    await store.addText(other.id, 'Alice.yaml', player('Alice'))
    // Most recently updated first.
    expect(await store.list()).toEqual([
      {
        id: other.id,
        name: 'Async',
        status: 'draft',
        playerCount: 1,
        updatedAt: expect.any(String) as unknown,
        hostingMode: null,
      },
      {
        id: created.id,
        name: 'Course du vendredi',
        status: 'draft',
        playerCount: 0,
        updatedAt: renamed.updatedAt,
        hostingMode: null,
      },
    ])

    await store.delete(created.id)
    expect(existsSync(created.workspace)).toBe(false)
    expect((await store.list()).map((s) => s.id)).toEqual([other.id])
    expect(await failure(store.get(created.id))).toMatchObject({ code: 'NOT_FOUND' })
    const [backup] = readdirSync(join(dataRoot(), 'backups'))
    expect(backup).toMatch(/^\d{8}-\d{6}-session$/)
    expect(existsSync(join(dataRoot(), 'backups', backup!, created.id, 'session.json'))).toBe(true)
    expect(await failure(store.delete(created.id))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses an empty name and answers NOT_FOUND for an unknown or malformed id', async () => {
    expect(await failure(store.create('   '))).toMatchObject({ code: 'INVALID_INPUT' })
    const { id } = await store.create('Goat')
    expect(await failure(store.update(id, { name: ' ' }))).toMatchObject({ code: 'INVALID_INPUT' })
    for (const bad of ['s_nope', '../sessions', 's_..', '']) {
      expect(await failure(store.get(bad))).toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(await failure(store.readFile(id, 'f_nope'))).toMatchObject({ code: 'NOT_FOUND' })
    expect(await failure(store.removeFile(id, 'f_nope'))).toMatchObject({ code: 'NOT_FOUND' })
    expect(await failure(store.replaceFile(id, 'f_nope', 'x'))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('list skips a folder whose session.json is unreadable; get answers NOT_FOUND for it', async () => {
    const good = await store.create('Good')
    const bad = await store.create('Bad')
    writeFileSync(join(bad.workspace, 'session.json'), '{"version": 1, "id": ')
    // A session.json copied from another session's folder is not that session.
    const copied = await store.create('Copied')
    writeFileSync(join(copied.workspace, 'session.json'), readFileSync(join(good.workspace, 'session.json')))
    mkdirSync(join(dataRoot(), 'sessions', 'not-a-session'))
    expect((await store.list()).map((s) => s.id)).toEqual([good.id])
    expect(await failure(store.get(bad.id))).toMatchObject({ code: 'NOT_FOUND' })
    expect(await failure(store.get(copied.id))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('setGeneration and setHosting set the status', async () => {
    const { id } = await store.create('Goat')
    const generation: Generation = {
      seedName: '12345',
      zipPath: join(dataRoot(), 'sessions', id, 'output', 'AP_12345.zip'),
      spoilerName: 'AP_12345_Spoiler.txt',
      slots: [{ slot: 1, name: 'Alice', game: 'TUNIC', patchFile: null }],
      durationS: 42,
      logPath: join(dataRoot(), 'sessions', id, 'logs', 'generate.txt'),
    }
    expect(await store.setGeneration(id, generation)).toMatchObject({ status: 'generated', generation })
    const hosting: Hosting = { mode: 'local', port: 38281, savefile: join('x', 'AP_12345.apsave') }
    expect(await store.setHosting(id, hosting)).toMatchObject({ status: 'hosting', hosting, generation })
    expect((await store.list())[0]).toMatchObject({ status: 'hosting', hostingMode: 'local' })
    expect(await store.setHosting(id, null)).toMatchObject({ status: 'generated', hosting: null })
    expect(await store.setGeneration(id, null)).toMatchObject({ status: 'draft', generation: null })
    expect(await makeStore().get(id)).toMatchObject({ status: 'draft', generation: null, hosting: null })
  })
})

describe('session store: player files', () => {
  it('addFiles imports yaml from zip and reports README.md as ignored', async () => {
    const { id } = await store.create('Goat')
    const zip = await makeZip(join(root, 'Téléchargements', 'joueurs.zip'), {
      'joueurs/Alice.yaml': player('Alice'),
      'joueurs/Bob.yml': `${player('Bob')}---\n${player('Bobby')}`,
      'README.md': '# Bienvenue\n',
    })
    const { session, ignored } = await store.addFiles(id, [zip])
    expect(ignored).toEqual([join(zip, 'README.md')])
    expect(session.players.map((f) => [f.originalName, f.storedName, f.docs.map((d) => d.name)])).toEqual([
      ['Alice.yaml', 'Alice.yaml', ['Alice']],
      ['Bob.yml', 'Bob.yaml', ['Bob', 'Bobby']],
    ])
    expect(session.players[0]).toEqual({
      id: expect.stringMatching(/^f_[0-9a-f]+$/) as unknown,
      originalName: 'Alice.yaml',
      storedName: 'Alice.yaml',
      docs: [{ index: 0, name: 'Alice', games: [{ game: 'TUNIC', weight: 1 }], issues: [] }],
      addedAt: expect.any(String) as unknown,
    })
    expect(readFileSync(join(session.workspace, 'players', 'Alice.yaml'), 'utf8')).toBe(player('Alice'))
    expect(await store.get(id)).toEqual(session)
    // The validation used the session's plando modules.
    expect(contexts.at(-1)).toEqual({ games: ['TUNIC'], plando: defaultRules().plando })
  })

  it('players dir contains only .yaml files with deduped safe names', async () => {
    const { id } = await store.create('Goat')
    const first = await store.addFiles(id, [
      userFile('Alice.yaml', player('Alice')),
      userFile('Héloïse (copie).yml', player('Heloise')),
      userFile('Carol.txt', player('Carol')),
      userFile('notes.txt', 'Bring snacks.\n'),
      userFile('photo.png', Buffer.from([0x89, 0x50])),
      userFile('meta.yaml', player('Meta')),
    ])
    expect(first.ignored).toEqual([
      join(root, 'Téléchargements', 'notes.txt'),
      join(root, 'Téléchargements', 'photo.png'),
    ])
    const zip = await makeZip(join(root, 'Téléchargements', 'more.zip'), {
      'alice.yaml': player('Alice2'),
      'sub/Alice.yaml': player('Alice3'),
    })
    const { session } = await store.addFiles(id, [zip])
    const stored = readdirSync(join(session.workspace, 'players'))
    expect(stored.toSorted()).toEqual(
      [
        'Alice.yaml',
        'alice-2.yaml',
        'Alice-3.yaml',
        'Carol.yaml',
        'Heloise _copie.yaml',
        'meta-2.yaml',
      ].toSorted(),
    )
    for (const name of stored) expect(name).toMatch(/^[A-Za-z0-9 _.-]+\.yaml$/)
    // Archipelago's order: file names compared case-insensitively ('-' sorts before '.').
    expect(session.players.map((f) => f.storedName)).toEqual([
      'alice-2.yaml',
      'Alice-3.yaml',
      'Alice.yaml',
      'Carol.yaml',
      'Heloise _copie.yaml',
      'meta-2.yaml',
    ])
  })

  it('addFiles checks every path before importing anything', async () => {
    const { id } = await store.create('Goat')
    const good = userFile('Alice.yaml', player('Alice'))
    expect(await failure(store.addFiles(id, [good, 'relative/Bob.yaml']))).toMatchObject({
      code: 'PATH_FORBIDDEN',
    })
    expect(await failure(store.addFiles(id, [good, join(root, 'missing.yaml')]))).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect((await store.get(id)).players).toEqual([])
    expect(readdirSync(join(dataRoot(), 'sessions', id, 'players'))).toEqual([])
  })

  it('a failed import leaves no file in players/: each one would be a player', async () => {
    const { id, workspace } = await store.create('Goat')
    // Something in the way of the second file.
    mkdirSync(join(workspace, 'players', 'Bob.yaml'))
    const files = [userFile('Alice.yaml', player('Alice')), userFile('Bob.yaml', player('Bob'))]
    await expect(store.addFiles(id, files)).rejects.toThrow()
    expect(readdirSync(join(workspace, 'players'))).toEqual(['Bob.yaml'])
    expect((await store.get(id)).players).toEqual([])
  })

  it('a player file gone from players/ is NOT_FOUND', async () => {
    const { id, workspace } = await store.create('Goat')
    const { players } = await store.addText(id, 'Alice.yaml', player('Alice'))
    rmSync(join(workspace, 'players', 'Alice.yaml'))
    expect(await failure(store.readFile(id, players[0]!.id))).toMatchObject({ code: 'NOT_FOUND' })
    expect(await failure(store.loadPlayers(id))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a Windows-1252 yaml inside a zip keeps its encoding-fallback issue', async () => {
    const { id } = await store.create('Goat')
    const zip = await makeZip(join(root, 'Téléchargements', 'latin.zip'), {
      'Heloise.yaml': readFileSync(join(YAMLS, 'windows-1252.yaml')),
    })
    const { session } = await store.addFiles(id, [zip])
    const [file] = session.players
    expect(file?.docs[0]?.issues).toEqual([{ severity: 'warning', code: 'encoding-fallback' }])
    expect(file?.docs[0]?.name).toBe('Héloïse')
    // Stored as UTF-8, the only encoding Archipelago reads.
    const bytes = readFileSync(join(session.workspace, 'players', 'Heloise.yaml'))
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toContain('name: Héloïse')
    // The warning survives a new store and the players' sources.
    const reloaded = makeStore()
    expect((await reloaded.get(id)).players[0]?.docs[0]?.issues).toEqual([
      { severity: 'warning', code: 'encoding-fallback' },
    ])
    const { files } = await reloaded.loadPlayers(id)
    expect(files[0]?.importIssues).toEqual([{ severity: 'warning', code: 'encoding-fallback' }])
  })

  it('addText, readFile and removeFile', async () => {
    const { id } = await store.create('Goat')
    const added = await store.addText(id, '..\\Zoé.yaml', `${BOM}${player('Zoe')}`)
    const [file] = added.players
    expect(file).toMatchObject({ originalName: 'Zoé.yaml', storedName: 'Zoe.yaml' })
    expect(await store.readFile(id, file!.id)).toEqual({ text: player('Zoe') })
    // Without a name the player is called after the stored file, as Archipelago does.
    const nameless = await store.addText(id, 'Sans nom', 'game: TUNIC\nTUNIC: {}\n')
    expect(nameless.players.find((f) => f.originalName === 'Sans nom')?.docs[0]?.name).toBe('Sans nom')
    const removed = await store.removeFile(id, file!.id)
    expect(removed.players.map((f) => f.storedName)).toEqual(['Sans nom.yaml'])
    expect(readdirSync(join(added.workspace, 'players'))).toEqual(['Sans nom.yaml'])
  })

  it('replaceFile keeps storedName and revalidates', async () => {
    const { id } = await store.create('Goat')
    const zip = await makeZip(join(root, 'Téléchargements', 'latin.zip'), {
      'Héloïse.yaml': readFileSync(join(YAMLS, 'windows-1252.yaml')),
    })
    const { session } = await store.addFiles(id, [zip])
    const [file] = session.players
    expect(file?.storedName).toBe('Heloise.yaml')
    installed = []
    const replaced = await store.replaceFile(id, file!.id, `${BOM}${player('Zoe', 'Zork')}`)
    const [after] = replaced.players
    expect(after).toMatchObject({
      id: file!.id,
      originalName: 'Héloïse.yaml',
      storedName: 'Heloise.yaml',
      addedAt: file!.addedAt,
    })
    // Validated again, against the worlds installed now; the text is new, so the warning is gone.
    expect(after?.docs).toEqual([
      {
        index: 0,
        name: 'Zoe',
        games: [{ game: 'Zork', weight: 1 }],
        issues: [{ severity: 'error', code: 'game-not-installed', path: 'game', params: { game: 'Zork' } }],
      },
    ])
    expect(readFileSync(join(replaced.workspace, 'players', 'Heloise.yaml'), 'utf8')).toBe(
      player('Zoe', 'Zork'),
    )
    expect((await store.loadPlayers(id)).files[0]?.importIssues).toEqual([])
    expect(replaced.updatedAt > session.updatedAt).toBe(true)
    // The other files of the session stay as they were.
    const withBob = await store.addText(id, 'Bob.yaml', player('Bob'))
    const bob = withBob.players.find((f) => f.storedName === 'Bob.yaml')
    const again = await store.replaceFile(id, file!.id, player('Zoe'))
    expect(again.players.find((f) => f.id === bob?.id)).toEqual(bob)
  })

  it('serializes the changes of one session', async () => {
    const { id } = await store.create('Goat')
    await Promise.all(['A', 'B', 'C', 'D'].map((name) => store.addText(id, `${name}.yaml`, player(name))))
    expect((await makeStore().get(id)).players.map((f) => f.storedName)).toEqual([
      'A.yaml',
      'B.yaml',
      'C.yaml',
      'D.yaml',
    ])
  })
})

describe('session store: secrets', () => {
  it('secrets are not written to session.json', async () => {
    const { id, workspace } = await store.create('Goat')
    await store.setSecrets(id, { password: 'hunter2 é', serverPassword: 'admin-s3cret' })
    const session = await store.get(id)
    expect(session).toMatchObject({ hasPassword: true, hasServerPassword: true })
    expect(await store.getSecrets(id)).toEqual({ password: 'hunter2 é', serverPassword: 'admin-s3cret' })
    const raw = readFileSync(join(workspace, 'session.json'), 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('admin-s3cret')
    expect(core.ctx.secrets.get(`session.${id}.password`)).toBe('hunter2 é')
    expect(core.ctx.secrets.get(`session.${id}.serverPassword`)).toBe('admin-s3cret')

    // undefined keeps a secret; null or '' removes it.
    await store.setSecrets(id, { serverPassword: null })
    expect(await store.getSecrets(id)).toEqual({ password: 'hunter2 é', serverPassword: null })
    await store.setSecrets(id, { password: '' })
    expect(await store.getSecrets(id)).toEqual({ password: null, serverPassword: null })
    expect(await store.get(id)).toMatchObject({ hasPassword: false, hasServerPassword: false })
  })

  it('deleting a session forgets its secrets', async () => {
    const { id } = await store.create('Goat')
    await store.setSecrets(id, { password: 'pw', serverPassword: 'admin' })
    await store.delete(id)
    expect(core.ctx.secrets.get(`session.${id}.password`)).toBeNull()
    expect(core.ctx.secrets.get(`session.${id}.serverPassword`)).toBeNull()
    expect(await failure(store.getSecrets(id))).toMatchObject({ code: 'NOT_FOUND' })
  })
})
