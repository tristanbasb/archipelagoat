import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApSettings, SettingsPath } from '@main/core/ap/settings'
import { createVault, type Vault } from '@main/core/play/roms'
import { createSessionStore, type SessionStore } from '@main/core/sessions/store'
import {
  buildValidationContext,
  createSessionValidator,
  resolveRomNeeds,
  type SessionValidatorDeps,
  type ValidationContextDeps,
} from '@main/core/sessions/validate-session'
import type { TaskHandle } from '@main/core/tasks'
import { parseTemplate } from '@main/core/yaml/template-parser'
import { AppError } from '@shared/errors'
import type { ApInstall, ApPaths, CatalogEntry, GameSchema, RomTableEntry } from '@shared/types'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'
import { makeZip } from './helpers'

const YAMLS = fileURLToPath(new URL('../../fixtures/yamls/', import.meta.url))
const TEMPLATES = fileURLToPath(new URL('../../fixtures/templates/', import.meta.url))
const TUNIC = parseTemplate(readFileSync(join(TEMPLATES, 'TUNIC.yaml'), 'utf8'))

const LTTP = 'A Link to the Past'
const md5 = (data: Buffer): string => createHash('md5').update(data).digest('hex')
/** A synthetic ROM: nobody can build a file with the MD5 of a real game. */
const ROM_BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) & 0xff))

const LTTP_ENTRY: RomTableEntry = {
  game: LTTP,
  label: `${LTTP} (test)`,
  md5s: [md5(ROM_BYTES)],
  header: 'none',
  settingsKey: 'lttp_options.rom_file',
  requiredAtGeneration: true,
  extensions: ['.sfc'],
}
// A ROM only the client needs: never a need of the generation.
const EMERALD_ENTRY: RomTableEntry = {
  ...LTTP_ENTRY,
  game: 'Pokemon Emerald',
  label: 'Pokemon Emerald (test)',
  settingsKey: 'pokemon_emerald_settings.rom_file',
  requiredAtGeneration: false,
  extensions: ['.gba'],
}
const TABLE = [LTTP_ENTRY, EMERALD_ENTRY]

let root: string
let core: TestCore
let install: ApInstall | null
let installed: Map<string, { worldVersion: string | null }>
let settingsValues: Record<string, unknown>
/** The loaded custom worlds whose game nothing tells. */
let unknownWorlds: string[]
let schemas: GameSchema[]
let catalog: Map<string, CatalogEntry>
let vault: Vault
let store: SessionStore
let deps: SessionValidatorDeps

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

function catalogEntry(
  id: string,
  game: string,
  latest: boolean,
  download: CatalogEntry['download'] = null,
): CatalogEntry {
  return {
    id,
    source: download === null ? 'index' : 'wiki',
    game,
    displayName: game,
    homepage: null,
    tags: [],
    supported: false,
    afterDark: false,
    requiresRomAtGeneration: false,
    hasPopTracker: false,
    wiki: null,
    latest: latest ? { version: '1.0.0', url: `https://example.org/${id}.apworld`, sha256: null } : null,
    download,
    installedVersion: null,
    trust: 'indexed-verified',
  }
}

const settings: Pick<ApSettings, 'get' | 'set'> = {
  get: (path: SettingsPath) => Promise.resolve(settingsValues[path.join('.')]),
  set: () => Promise.resolve(),
}

function task(): TaskHandle {
  return {
    id: 'task-1',
    signal: new AbortController().signal,
    progress: () => undefined,
    log: () => undefined,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat validate é-'))
  core = createTestContext(join(root, 'core'))
  const base = join(root, 'Archipelago')
  install = { kind: 'custom', version: '0.6.8', root: base, appImagePath: null, paths: apPaths(base) }
  installed = new Map([
    ['TUNIC', { worldVersion: '3.1.0' }],
    [LTTP, { worldVersion: null }],
  ])
  settingsValues = {}
  unknownWorlds = []
  schemas = [TUNIC]
  catalog = new Map([
    ['Hollow Knight', catalogEntry('hk', 'Hollow Knight', true)],
    [
      'Wiki Only',
      catalogEntry('wiki:Wiki Only', 'Wiki Only', false, {
        kind: 'page',
        url: 'https://github.com/owner/fork/releases?q=Wiki+Only',
      }),
    ],
    [
      'Itch Only',
      {
        ...catalogEntry('wiki:Itch Only', 'Itch Only', false, {
          kind: 'page',
          url: 'https://someone.itch.io/itch-only',
        }),
        wiki: {
          title: 'Itch Only',
          url: 'https://archipelago.miraheze.org/wiki/Itch_Only',
          status: 'Custom',
          maintainer: null,
          setupUrl: null,
        },
      },
    ],
    [
      'Wiki Release',
      catalogEntry('wiki:Wiki Release', 'Wiki Release', false, {
        kind: 'github-latest',
        repo: 'owner/wiki-release',
        pageUrl: 'https://github.com/owner/wiki-release/releases/latest',
      }),
    ],
  ])
  const locator = { detect: () => Promise.resolve(install) }
  vault = createVault(core.ctx, { settings, locator, table: TABLE })
  const context: ValidationContextDeps = {
    locator,
    worlds: {
      installedGames: () => Promise.resolve(new Map(installed)),
      unknownWorlds: () => Promise.resolve([...unknownWorlds]),
    },
    templates: {
      getSchema: (game) => {
        const found = schemas.find((schema) => schema.game === game)
        return found ? Promise.resolve(found) : Promise.reject(new AppError('NOT_FOUND', { game }))
      },
    },
    settings,
    log: silentLogger,
  }
  deps = { ...context, catalog: { lookupByGame: (game) => catalog.get(game) ?? null }, vault, table: TABLE }
  store = createSessionStore(core.ctx, {
    validationContext: (games, plando) => buildValidationContext(context, games, plando),
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

const player = (name: string, game: string): string => `name: ${name}\ngame: ${game}\n${game}: {}\n`

function writeRom(name: string, data: Buffer = ROM_BYTES): string {
  const file = join(root, 'Mes ROMs', name)
  mkdirSync(join(root, 'Mes ROMs'), { recursive: true })
  writeFileSync(file, data)
  return file
}

async function sessionWith(...files: [string, string][]): Promise<string> {
  const { id } = await store.create('Goat')
  for (const [name, text] of files) await store.addText(id, name, text)
  return id
}

const validator = () => createSessionValidator(store, deps)

describe('validateSession', () => {
  it('validateSession is blocking on missing world and lists catalogId', async () => {
    const id = await sessionWith(
      ['Alice.yaml', player('Alice', 'TUNIC')],
      ['Bob.yaml', player('Bob', 'Hollow Knight')],
      ['Carol.yaml', player('Carol', 'Zork')],
      [
        'Dave.yaml',
        `name: Dave\ngame: {Wiki Only: 1, Hollow Knight: 1, TUNIC: 0}\nWiki Only: {}\nHollow Knight: {}\n`,
      ],
      ['Erin.yaml', player('Erin', 'Wiki Release')],
      ['Frank.yaml', player('Frank', 'Itch Only')],
    )
    const result = await validator().validateSession(id)
    expect(result.missingWorlds).toEqual([
      { game: 'Hollow Knight', catalogId: 'hk', downloadPage: null },
      { game: 'Zork', catalogId: null, downloadPage: null },
      // In the catalog, but with nothing to download: its page is opened in the browser.
      {
        game: 'Wiki Only',
        catalogId: null,
        downloadPage: 'https://github.com/owner/fork/releases?q=Wiki+Only',
      },
      // Only on the wiki: its latest GitHub release is resolved when it is installed.
      { game: 'Wiki Release', catalogId: 'wiki:Wiki Release', downloadPage: null },
      // A page on a site the app does not open: its wiki page, which links to it.
      {
        game: 'Itch Only',
        catalogId: null,
        downloadPage: 'https://archipelago.miraheze.org/wiki/Itch_Only',
      },
    ])
    expect(result.blocking).toBe(true)
    const session = await store.get(id)
    expect(result.files.map((f) => f.fileId)).toEqual(session.players.map((p) => p.id))
    expect(result.files[1]?.docs[0]?.issues.map((i) => i.code)).toEqual(['game-not-installed'])
    expect(result.romNeeds).toEqual([])
  })

  it('does not block on a game that a world without a readable game may provide', async () => {
    unknownWorlds = ['rhythm_doctor']
    const id = await sessionWith(
      ['Alice.yaml', player('Alice', 'TUNIC')],
      ['Bob.yaml', player('Bob', 'Rhythm Doctor')],
    )
    const result = await validator().validateSession(id)
    expect(result.missingWorlds).toEqual([])
    expect(result.blocking).toBe(false)
    expect(result.files[1]?.docs[0]?.issues).toEqual([
      {
        severity: 'warning',
        code: 'game-unconfirmed',
        path: 'game',
        params: { game: 'Rhythm Doctor', worlds: 'rhythm_doctor' },
      },
    ])
  })

  it('is not blocking when every world is installed and only warnings remain', async () => {
    const { id } = await store.create('Goat')
    const zip = await makeZip(join(root, 'in', 'latin.zip'), {
      'Heloise.yaml': readFileSync(join(YAMLS, 'windows-1252.yaml')),
    })
    await store.addFiles(id, [zip])
    await store.addText(id, 'Alice.yaml', player('Alice', 'TUNIC'))
    const result = await validator().validateSession(id)
    expect(result).toEqual({
      files: [
        {
          fileId: expect.any(String) as unknown,
          docs: [expect.objectContaining({ name: 'Alice', issues: [] }) as unknown],
        },
        {
          fileId: expect.any(String) as unknown,
          // The Windows-1252 file keeps its warning when it is validated again.
          docs: [
            expect.objectContaining({
              name: 'Héloïse',
              issues: [{ severity: 'warning', code: 'encoding-fallback' }],
            }),
          ],
        },
      ],
      sessionIssues: [],
      missingWorlds: [],
      romNeeds: [],
      blocking: false,
    })
  })

  it('validates with the schemas of the installed games and the session plando modules', async () => {
    const id = await sessionWith([
      'Alice.yaml',
      'name: Alice\ngame: TUNIC\nrequires: {plando: items}\nTUNIC: {hexagon_goal: 500}\n',
    ])
    const codes = async (): Promise<string[]> =>
      (await validator().validateSession(id)).files[0]!.docs[0]!.issues.map((i) => i.code)
    expect(await codes()).toEqual(['requires-plando-disabled', 'option-invalid-value'])
    await store.update(id, { rules: { ...(await store.get(id)).rules, plando: ['items'], preset: 'custom' } })
    expect(await codes()).toEqual(['option-invalid-value'])
  })

  it('names repeated across files, a YAML error or no player at all block the generation', async () => {
    const dup = await sessionWith(['A.yaml', player('Goat', 'TUNIC')], ['B.yaml', player('goat', 'TUNIC')])
    const result = await validator().validateSession(dup)
    expect(result.sessionIssues).toEqual([
      { severity: 'error', code: 'name-duplicate', params: { name: 'Goat', count: 2 } },
    ])
    expect(result.blocking).toBe(true)

    const broken = await sessionWith(['A.yaml', 'name: [\n'])
    expect(await validator().validateSession(broken)).toMatchObject({
      files: [{ docs: [{ name: null, issues: [expect.objectContaining({ code: 'yaml-syntax' })] }] }],
      blocking: true,
    })

    const empty = await sessionWith()
    expect(await validator().validateSession(empty)).toEqual({
      files: [],
      sessionIssues: [],
      missingWorlds: [],
      romNeeds: [],
      blocking: true,
    })
  })

  it('romNeed is ok when the effective rom_file key points to a matching file', async () => {
    const rom = writeRom('Zelda no Densetsu.sfc')
    settingsValues['lttp_options.rom_file'] = rom
    const id = await sessionWith(['Link.yaml', player('Link', LTTP)])
    const result = await validator().validateSession(id)
    expect(result.romNeeds).toEqual([
      { game: LTTP, settingsKey: 'lttp_options.rom_file', status: 'ok', path: rom, vaultPath: null },
    ])
    expect(result.blocking).toBe(false)
  })

  it('romNeed is ok with vaultPath when only the vault has a verified match', async () => {
    const rom = writeRom('zelda.sfc')
    await vault.scan([rom], task())
    const id = await sessionWith(['Link.yaml', player('Link', LTTP)])
    const result = await validator().validateSession(id)
    expect(result.romNeeds).toEqual([
      { game: LTTP, settingsKey: 'lttp_options.rom_file', status: 'ok', path: rom, vaultPath: rom },
    ])
    expect(result.blocking).toBe(false)
  })

  it('romNeed is bad-hash when the key points to a wrong file and the vault has nothing', async () => {
    settingsValues['lttp_options.rom_file'] = writeRom('wrong.sfc', Buffer.from('not the right rom'))
    const id = await sessionWith(['Link.yaml', player('Link', LTTP)])
    const result = await validator().validateSession(id)
    expect(result.romNeeds).toEqual([
      { game: LTTP, settingsKey: 'lttp_options.rom_file', status: 'bad-hash', path: null, vaultPath: null },
    ])
    expect(result.blocking).toBe(true)
    // No key and no vault ROM: missing, blocking as well.
    delete settingsValues['lttp_options.rom_file']
    expect(await validator().validateSession(id)).toMatchObject({
      romNeeds: [{ status: 'missing', path: null, vaultPath: null }],
      blocking: true,
    })
  })
})

describe('resolveRomNeeds', () => {
  it('asks the vault for the ROMs the generation needs, for the games of the session only', async () => {
    const rom = writeRom('zelda.sfc')
    const asked: string[] = []
    const fake: Pick<Vault, 'resolveRomForEntry'> = {
      resolveRomForEntry: (entry) => {
        asked.push(entry.game)
        return Promise.resolve({ status: 'ok', path: rom, vaultPath: rom })
      },
    }
    expect(await resolveRomNeeds(['TUNIC', 'Pokemon Emerald'], { vault: fake, table: TABLE })).toEqual([])
    expect(await resolveRomNeeds([LTTP, 'TUNIC', LTTP], { vault: fake, table: TABLE })).toEqual([
      { game: LTTP, settingsKey: 'lttp_options.rom_file', status: 'ok', path: rom, vaultPath: rom },
    ])
    expect(asked).toEqual([LTTP])
    // The real table by default: A Link to the Past needs its ROM to generate.
    expect((await resolveRomNeeds([LTTP], { vault: fake })).map((need) => need.settingsKey)).toEqual([
      'lttp_options.rom_file',
    ])
  })
})

describe('buildValidationContext', () => {
  it('reads allow_quantity and plando_options from the settings unless plando is given', async () => {
    const context = (plando: string[] | null) => buildValidationContext(deps, ['TUNIC', 'Zork'], plando)
    let ctx = await context(null)
    expect(ctx.apVersion).toBe('0.6.8')
    expect(ctx.allowQuantity).toBe(false)
    expect(ctx.plandoEnabled).toEqual(['bosses', 'connections', 'texts'])
    expect([...ctx.installedGames.keys()]).toEqual(['TUNIC', LTTP])
    expect(ctx.schemaFor('TUNIC')).toBe(TUNIC)
    expect(ctx.schemaFor('Zork')).toBeUndefined()
    settingsValues = { 'generator.allow_quantity': true, 'generator.plando_options': 'Items, bosses' }
    ctx = await context(null)
    expect(ctx.allowQuantity).toBe(true)
    expect(ctx.plandoEnabled).toEqual(['items', 'bosses'])
    expect((await context(['texts'])).plandoEnabled).toEqual(['texts'])
  })

  it('without Archipelago: no version, no quantity, the default plando modules', async () => {
    install = null
    settingsValues = { 'generator.allow_quantity': true }
    const ctx = await buildValidationContext(deps, ['TUNIC'], null)
    expect(ctx).toMatchObject({
      apVersion: '',
      allowQuantity: false,
      plandoEnabled: ['bosses', 'connections', 'texts'],
    })
  })
})
