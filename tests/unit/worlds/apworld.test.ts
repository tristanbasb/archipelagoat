import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gameFromSource, inspectApworld, parseWorldManifest, readApworld } from '@main/core/worlds/apworld'
import { AppError } from '@shared/errors'
import { apworldManifest, makeApworld, patchZipNames } from '../../helpers/make-apworld'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat apworld é-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

describe('inspectApworld', () => {
  it('reads manifest at root or inside module folder', async () => {
    const inModule = await makeApworld(join(root, 'foo.apworld'), {
      manifest: apworldManifest('Foo Quest', {
        world_version: '1.2.3',
        minimum_ap_version: '0.6.0',
        maximum_ap_version: '0.6.9',
        authors: ['Ann', 'Bob'],
      }),
    })
    expect(await inspectApworld(inModule)).toEqual({
      module: 'foo',
      hasInit: true,
      manifest: {
        game: 'Foo Quest',
        worldVersion: '1.2.3',
        minimumApVersion: '0.6.0',
        maximumApVersion: '0.6.9',
        authors: ['Ann', 'Bob'],
        version: 7,
        compatibleVersion: 7,
      },
      manifestError: null,
      sha256: sha256(inModule),
      sizeBytes: statSync(inModule).size,
    })

    const atRoot = await makeApworld(join(root, 'bar.apworld'), { manifestAt: 'root', game: 'Bar' })
    expect(await inspectApworld(atRoot)).toMatchObject({
      module: 'bar',
      manifest: { game: 'Bar', worldVersion: null, minimumApVersion: null, authors: [] },
      manifestError: null,
    })

    // Like Archipelago: the root manifest first, else the first entry named …archipelago.json.
    const both = await makeApworld(join(root, 'baz.apworld'), {
      manifestAt: 'root',
      game: 'From the root',
      files: { 'baz/archipelago.json': JSON.stringify(apworldManifest('From the folder')) },
    })
    expect((await inspectApworld(both)).manifest?.game).toBe('From the root')
  })

  it('reports a missing or broken manifest without refusing the world', async () => {
    const none = await makeApworld(join(root, 'none.apworld'), { manifest: null })
    expect(await inspectApworld(none)).toMatchObject({ manifest: null, manifestError: 'missing' })

    const garbage = await makeApworld(join(root, 'garbage.apworld'), { manifest: '{ nope' })
    expect(await inspectApworld(garbage)).toMatchObject({ manifest: null, manifestError: 'invalid-json' })

    // Not packaged by Archipelago: the game is there, compatible_version is not (AP refuses it).
    const loose = await makeApworld(join(root, 'loose.apworld'), { manifest: { game: 'Loose' } })
    expect(await inspectApworld(loose)).toMatchObject({
      manifest: { game: 'Loose', version: null, compatibleVersion: null },
      manifestError: 'missing-compatible_version',
    })
  })

  it('rejects traversal entry and zip bomb', async () => {
    const traversal = await makeApworld(join(root, 'evil.apworld'), { files: { 'evil/xx/payload.py': 'x' } })
    patchZipNames(traversal, 'evil/xx/', 'evil/../')
    expect(await failure(inspectApworld(traversal))).toMatchObject({
      code: 'WORLD_INVALID',
      params: { reason: 'traversal' },
    })

    const bomb = await makeApworld(join(root, 'bomb.apworld'), {
      files: { 'bomb/data.bin': Buffer.alloc(4 * 1024 * 1024) },
    })
    expect(await failure(inspectApworld(bomb))).toMatchObject({
      code: 'WORLD_INVALID',
      params: { reason: 'zip-bomb' },
    })
  })

  it('rejects what Archipelago would not install', async () => {
    const notZip = join(root, 'text.apworld')
    writeFileSync(notZip, 'this is no zip')
    const roots = await makeApworld(join(root, 'two.apworld'), {
      module: 'two',
      files: { 'other/x.py': 'x' },
    })
    const noRoot = await makeApworld(join(root, 'flat.apworld'), {
      init: false,
      manifestAt: 'root',
      files: { '__init__.py': 'x' },
    })
    const noInit = await makeApworld(join(root, 'noinit.apworld'), { init: false })
    // The folder must appear in the file stem, case included.
    const mismatch = await makeApworld(join(root, 'Foo-v1.apworld'), { module: 'foo' })

    const reasons = await Promise.all(
      [notZip, roots, noRoot, noInit, mismatch].map(
        async (file) => (await failure(inspectApworld(file))).params,
      ),
    )
    expect(reasons).toEqual([
      { reason: 'not-zip' },
      { reason: 'multiple-roots' },
      { reason: 'no-init' },
      { reason: 'no-init' },
      { reason: 'name-mismatch' },
    ])
    expect(await failure(inspectApworld(join(root, 'missing.apworld')))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a module folder Windows cannot name, or that Archipelago would skip', async () => {
    const device = await makeApworld(join(root, 'aux.apworld'), { module: 'aux' })
    expect(await failure(inspectApworld(device))).toMatchObject({ params: { reason: 'traversal' } })
    const skipped = await makeApworld(join(root, '_private.apworld'), { module: '_private' })
    expect(await failure(inspectApworld(skipped))).toMatchObject({ params: { reason: 'traversal' } })
  })
})

describe('readApworld', () => {
  it('lists the root folders and reads the manifest without judging the structure', async () => {
    const file = await makeApworld(join(root, 'Foo-v1.apworld'), {
      module: 'foo',
      init: false,
      files: { 'other/readme.txt': 'x', 'notes.txt': 'y' },
    })
    expect(await readApworld(file)).toEqual({
      roots: ['foo', 'other'],
      initRoots: [],
      manifest: expect.objectContaining({ game: 'foo' }) as unknown,
      manifestError: null,
      sourceGame: null,
    })
  })

  it('reads the game a world without a manifest declares in its code, without running it', async () => {
    const world = [
      'from worlds.AutoWorld import World, WebWorld',
      '',
      'class RhythmWeb(WebWorld):',
      '    game = "Not this one"',
      '',
      'class RhythmDoctorWorld(World):',
      "    '''The world.'''",
      '    game: ClassVar[str] = "Rhythm Doctor"',
      '    topology_present = False',
      '',
    ].join('\r\n')
    const file = await makeApworld(join(root, 'rhythm_doctor.apworld'), {
      manifest: null,
      files: { 'rhythm_doctor/world.py': world, 'rhythm_doctor/items.py': 'game = "Items"\n' },
    })
    expect(await readApworld(file)).toMatchObject({
      manifest: null,
      manifestError: 'missing',
      sourceGame: 'Rhythm Doctor',
    })
    // A manifest game wins: the code is not read.
    const declared = await makeApworld(join(root, 'declared.apworld'), {
      game: 'Declared',
      files: { 'declared/world.py': world },
    })
    expect(await readApworld(declared)).toMatchObject({ sourceGame: null })
  })
})

describe('gameFromSource', () => {
  it('takes the game of the first World class, in any spelling Archipelago worlds use', () => {
    expect(gameFromSource("class A(World):\n    game = 'Alpha'\n")).toBe('Alpha')
    expect(gameFromSource('class B(AutoWorld.World):\n    game: str = "Beta"\n')).toBe('Beta')
    expect(gameFromSource('class C(SomeBaseWorld, Mixin):\n    # doc\n\n    game = "Gamma"\n')).toBe('Gamma')
  })

  it('reads nothing outside a World class body, and nothing from WebWorld', () => {
    expect(gameFromSource('game = "Top level"\nclass A(World):\n    pass\n')).toBeNull()
    expect(gameFromSource('class W(WebWorld):\n    game = "Web"\n')).toBeNull()
    expect(gameFromSource('class A(World):\n    pass\ngame_name = 1\nclass B:\n    game = "x"\n')).toBeNull()
    expect(gameFromSource('class A(World):\n    game = some_constant\n')).toBeNull()
  })
})

describe('parseWorldManifest', () => {
  it('keeps the fields Archipelago reads and names the first problem', () => {
    expect(parseWorldManifest(null)).toEqual({ manifest: null, error: 'missing' })
    expect(parseWorldManifest('[1, 2]')).toEqual({ manifest: null, error: 'not-an-object' })
    expect(parseWorldManifest('{"game": ""}')).toEqual({ manifest: null, error: 'invalid-game' })
    expect(parseWorldManifest('{"game": 3}')).toEqual({ manifest: null, error: 'invalid-game' })

    const bad = parseWorldManifest(
      JSON.stringify({ game: 'G', world_version: '1.0', authors: 'Solo', compatible_version: 7 }),
    )
    expect(bad).toEqual({
      manifest: {
        game: 'G',
        worldVersion: null,
        minimumApVersion: null,
        maximumApVersion: null,
        authors: ['Solo'],
        version: null,
        compatibleVersion: 7,
      },
      error: 'invalid-world_version',
    })

    const tooNew = parseWorldManifest(JSON.stringify(apworldManifest('G', { compatible_version: 8 })))
    expect(tooNew).toMatchObject({ manifest: { compatibleVersion: 8 }, error: 'compatible-version-too-new' })
    expect(parseWorldManifest('{"game":"G","compatible_version":"7"}').error).toBe(
      'invalid-compatible_version',
    )

    // A folder world needs its game only.
    expect(parseWorldManifest('{"game":"G"}', { packaged: false }).error).toBeNull()
    // A byte order mark is not an error.
    expect(
      parseWorldManifest(String.fromCharCode(0xfeff) + '{"game":"G"}', { packaged: false }).manifest?.game,
    ).toBe('G')
  })
})
