import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApSettings } from '@main/core/ap/settings'
import { parseTemplate } from '@main/core/yaml/template-parser'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import { createStudio, type Studio, type StudioDeps } from '@main/services/studio.service'
import { AppError } from '@shared/errors'
import type { ApInstall, ApPaths, EditorDoc, GameSchema } from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'
import { makeApworld } from '../../helpers/make-apworld'

const TEMPLATES = fileURLToPath(new URL('../../fixtures/templates/', import.meta.url))
const TUNIC = parseTemplate(readFileSync(join(TEMPLATES, 'TUNIC.yaml'), 'utf8'))

let root: string
let core: TestCore
let install: ApInstall
let settings: Record<string, unknown>
let schemas: GameSchema[]
let detected: ApInstall | null

function apPaths(base: string): ApPaths {
  return {
    localPath: base,
    userPath: base,
    customWorlds: join(base, 'custom_worlds'),
    coreWorlds: join(base, 'lib', 'worlds'),
    players: join(base, 'Players'),
    templates: join(base, 'Players', 'Templates'),
    output: join(base, 'output'),
    logs: join(base, 'logs'),
    cache: join(base, 'cache'),
    settingsFile: join(base, 'host.yaml'),
  }
}

function studio(): Studio {
  const deps: StudioDeps = {
    locator: { detect: () => Promise.resolve(detected) },
    templates: {
      getSchema: (game) => {
        const found = schemas.find((schema) => schema.game === game)
        return found ? Promise.resolve(found) : Promise.reject(new AppError('NOT_FOUND', { game }))
      },
    },
    settings: {
      get: (path) => Promise.resolve(settings[path.join('.')]),
    } satisfies Pick<ApSettings, 'get'>,
  }
  return createStudio(core.ctx, deps)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat studio é-'))
  core = createTestContext(join(root, 'core'))
  const base = join(root, 'Archipelago')
  install = { kind: 'custom', version: '0.6.8', root: base, appImagePath: null, paths: apPaths(base) }
  mkdirSync(install.paths.coreWorlds, { recursive: true })
  await makeApworld(join(install.paths.customWorlds, 'tunic.apworld'), {
    game: 'TUNIC',
    manifest: { game: 'TUNIC', world_version: '3.1.0', version: 7, compatible_version: 7 },
  })
  // A disabled world does not count as installed.
  await makeApworld(join(core.platform.paths.dataRoot, 'disabled-worlds', 'zork.apworld'), { game: 'Zork' })
  detected = install
  settings = {}
  schemas = [TUNIC]
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

const doc = (...lines: string[]): string => [...lines, ''].join('\n')

describe('studio service: validate', () => {
  it('uses the installed worlds, the AP version and the schemas', async () => {
    const [player] = await studio().validate(
      doc(
        'game: TUNIC',
        'requires:',
        '  version: 0.6.8',
        '  game: {TUNIC: 3.0.0}',
        'TUNIC:',
        '  hexagon_goal: 500',
      ),
    )
    expect(player).toEqual({
      index: 0,
      name: 'Player',
      games: [{ game: 'TUNIC', weight: 1 }],
      issues: [
        {
          severity: 'error',
          code: 'option-invalid-value',
          path: 'TUNIC.hexagon_goal',
          params: { value: 500, min: 1, max: 100 },
        },
      ],
    })
    const errors = await studio().validate(doc('name: A', 'game: Zork', 'Zork: {}'), 'A.yaml')
    expect(errors[0]?.issues.map((i) => i.code)).toEqual(['game-not-installed'])
    const tooNew = await studio().validate(
      doc('name: A', 'game: TUNIC', 'requires: {game: {TUNIC: 4.0.0}}', 'TUNIC: {}'),
    )
    expect(tooNew[0]?.issues.map((i) => i.code)).toEqual(['requires-game-version'])
  })

  it('reads allow_quantity and plando_options from the settings, with their defaults', async () => {
    const text = doc('name: A', 'game: TUNIC', 'quantity: 2', 'requires: {plando: items}', 'TUNIC: {}')
    const codes = async (): Promise<string[]> => (await studio().validate(text))[0]!.issues.map((i) => i.code)
    expect(await codes()).toEqual(['quantity-disabled', 'requires-plando-disabled'])
    settings = { 'generator.allow_quantity': true, 'generator.plando_options': 'bosses, items' }
    expect(await codes()).toEqual([])
  })

  it('without Archipelago no game is installed; a missing schema skips the option checks', async () => {
    schemas = []
    expect((await studio().validate(doc('name: A', 'game: TUNIC', 'TUNIC: {zzz: 1}')))[0]?.issues).toEqual([])
    detected = null
    expect((await studio().validate(doc('name: A', 'game: TUNIC', 'TUNIC: {}')))[0]?.issues).toEqual([
      { severity: 'error', code: 'game-not-installed', path: 'game', params: { game: 'TUNIC' } },
    ])
  })

  it('flags duplicate names within the file and returns the YAML errors', async () => {
    const docs = await studio().validate(
      doc('name: A', 'game: TUNIC', 'TUNIC: {}', '---', 'name: a', 'game: TUNIC', 'TUNIC: {}'),
    )
    expect(docs.map((d) => d.issues)).toEqual([
      [{ severity: 'error', code: 'name-duplicate', path: 'name', params: { name: 'A', count: 2 } }],
      [{ severity: 'error', code: 'name-duplicate', path: 'name', params: { name: 'a', count: 2 } }],
    ])
    expect(await studio().validate('a: [\n')).toEqual([
      expect.objectContaining({
        index: 0,
        name: null,
        issues: [expect.objectContaining({ code: 'yaml-syntax' })],
      }),
    ])
  })
})

describe('studio service: parse and render', () => {
  it('render applies the schema of the game when there is one', async () => {
    const editor: EditorDoc = {
      name: 'Goat',
      description: '',
      game: 'TUNIC',
      requiresVersion: null,
      options: { hexagon_goal: { mode: 'value', value: 24.6 } },
      extraRoot: {},
    }
    expect((await studio().render(editor)).text).toBe('name: Goat\ngame: TUNIC\nTUNIC:\n  hexagon_goal: 25\n')
    schemas = []
    expect(await studio().render(editor)).toEqual({
      text: 'name: Goat\ngame: TUNIC\nTUNIC:\n  hexagon_goal: 24.6\n',
      issues: [],
    })
    expect((await studio().render({ ...editor, game: '' })).text).toBe('name: Goat\n')
  })

  it('parse gives the editor documents', () => {
    expect(studio().parse('name: A\ngame: TUNIC\nTUNIC: {}\n').docs).toEqual([
      { name: 'A', description: '', game: 'TUNIC', requiresVersion: null, options: {}, extraRoot: {} },
    ])
  })
})

describe('studio service: open and save', () => {
  it('opens a path given by the renderer, decoded, then may save over it', async () => {
    const file = join(root, 'players', 'Héloïse.yaml')
    mkdirSync(join(root, 'players'))
    writeFileSync(file, Buffer.from('name: H\xe9lo\xefse\n', 'latin1'))
    const s = studio()
    const opened = await s.open(file)
    expect(opened).toEqual({ path: file, text: 'name: Héloïse\n' })
    expect(await s.save('\uFEFFname: Zoé\n', file, 'Zoé.yaml')).toEqual({ path: file })
    // UTF-8 without BOM.
    expect(readFileSync(file)).toEqual(Buffer.from('name: Zoé\n', 'utf8'))
  })

  it('refuses to open what is not a YAML or text file', async () => {
    const file = join(root, 'setup.exe')
    writeFileSync(file, 'MZ')
    await expect(studio().open(file)).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' })
    await expect(studio().open(join(root, 'missing.yaml'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('opens through a dialog without a path; null when it is cancelled', async () => {
    const file = join(root, 'Goat.txt')
    writeFileSync(file, 'name: Goat\n')
    const s = studio()
    core.showOpenDialog.mockResolvedValueOnce([file])
    expect(await s.open()).toEqual({ path: file, text: 'name: Goat\n' })
    expect(core.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'file',
        filters: [{ name: 'YAML', extensions: ['yaml', 'yml', 'txt'] }],
      }),
    )
    expect(await s.open()).toBeNull()
    // A .txt file was opened: it can only be saved under a new name.
    await expect(s.save('name: Goat\n', file, 'Goat.yaml')).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' })
  })

  it('saves to a new path through a dialog, which can then be saved again', async () => {
    const target = join(root, 'out', 'Goat.yaml')
    mkdirSync(join(root, 'out'))
    const s = studio()
    core.showSaveDialog.mockResolvedValueOnce(target)
    expect(await s.save('name: Goat\n', null, 'Goat')).toEqual({ path: target })
    expect(core.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultName: 'Goat.yaml',
        filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      }),
    )
    expect(readFileSync(target, 'utf8')).toBe('name: Goat\n')
    expect(await s.save('name: Goat2\n', target, 'Goat.yaml')).toEqual({ path: target })
    expect(readFileSync(target, 'utf8')).toBe('name: Goat2\n')
    // Cancelled, or a name without a YAML extension.
    expect(await s.save('x', null, 'Goat.yaml')).toBeNull()
    core.showSaveDialog.mockResolvedValueOnce(join(root, 'out', 'Goat.txt'))
    await expect(s.save('x', null, 'Goat.yaml')).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' })
    expect(existsSync(join(root, 'out', 'Goat.txt'))).toBe(false)
  })

  it('the default name of the dialog is a bare YAML file name', async () => {
    const s = studio()
    await s.save('x', null, '..\\..\\Windows\\evil.yml')
    await s.save('x', null, 'notes.txt')
    expect(core.showSaveDialog.mock.calls.map(([opts]) => opts.defaultName)).toEqual([
      'evil.yml',
      'notes.txt.yaml',
    ])
  })
})

describe('studio IPC handlers', () => {
  let call: (name: string, input?: unknown) => Promise<unknown>

  beforeEach(() => {
    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    call = (name, input) => ipc.dispatch(name, input, { senderId: 1 })
  })

  it('studio:save refuses a path not returned by a dialog', async () => {
    const target = join(root, 'Goat.yaml')
    writeFileSync(target, 'name: Goat\n')
    expect(
      await call('studio:save', { text: 'name: Evil\n', path: target, suggestedName: 'Goat.yaml' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'PATH_FORBIDDEN' },
    })
    expect(readFileSync(target, 'utf8')).toBe('name: Goat\n')
    // Once opened in this session, the same path can be saved.
    expect(await call('studio:open', { path: target })).toEqual({
      ok: true,
      value: { path: target, text: 'name: Goat\n' },
    })
    expect(
      await call('studio:save', { text: 'name: Kid\n', path: target, suggestedName: 'Goat.yaml' }),
    ).toEqual({
      ok: true,
      value: { path: target },
    })
    expect(readFileSync(target, 'utf8')).toBe('name: Kid\n')
  })

  it('studio:parse answers through IPC', async () => {
    expect(await call('studio:parse', { text: 'name: [\n' })).toMatchObject({
      ok: true,
      value: { docs: [], issues: [{ code: 'yaml-syntax' }] },
    })
  })
})
