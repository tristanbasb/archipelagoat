import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPatchManifest } from '@main/core/play/patch'
import { AppError } from '@shared/errors'
import { EMERALD_MD5, makePatchZip, patchManifest } from '../../helpers/make-patch.mjs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat patch é-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a failure')
}

const MM2_LC = '37f2c36ce7592f1e16b3434b3985c497'
const MM2_NES = '0527a0ee512f69e08b8db6dc97964632'

describe('readPatchManifest', () => {
  it('reads the manifest of a patch container', async () => {
    const file = await makePatchZip(join(root, 'AP_1_P1_Alice.apemerald'), patchManifest(), {
      'token_data.bin': 'tokens',
    })
    expect(await readPatchManifest(file)).toEqual({
      game: 'Pokemon Emerald',
      player: 1,
      playerName: 'Alice',
      // AP writes '' when the patch was made without a server (a local generation).
      server: null,
      patchFileEnding: '.apemerald',
      baseChecksums: [EMERALD_MD5],
      resultFileEnding: '.gba',
      compatibleVersion: 6,
      version: 7,
    })
  })

  it('readPatchManifest accepts base_checksum string or list', async () => {
    const one = await makePatchZip(join(root, 'one.apemerald'), patchManifest({ base_checksum: EMERALD_MD5 }))
    expect((await readPatchManifest(one)).baseChecksums).toEqual([EMERALD_MD5])

    // A list (worlds/mm2/rom.py:107), written in any case.
    const list = await makePatchZip(
      join(root, 'list.apmm2'),
      patchManifest({ game: 'Mega Man 2', base_checksum: [MM2_LC.toUpperCase(), MM2_NES] }),
    )
    expect((await readPatchManifest(list)).baseChecksums).toEqual([MM2_LC, MM2_NES])

    // A container that needs no ROM (APPlayerContainer: no base_checksum), or a hash AP left at None.
    const none = await makePatchZip(join(root, 'none.zip'), patchManifest({ base_checksum: undefined }))
    expect((await readPatchManifest(none)).baseChecksums).toEqual([])
    const nul = await makePatchZip(join(root, 'null.apemerald'), patchManifest({ base_checksum: null }))
    expect((await readPatchManifest(nul)).baseChecksums).toEqual([])
  })

  it('keeps the server the site wrote, and the optional fields as null when missing', async () => {
    const file = await makePatchZip(join(root, 'P1.apemerald'), {
      game: 'Factorio',
      player: 3,
      player_name: 'Rocket',
      server: 'archipelago.gg:38281',
      patch_file_ending: '.zip',
    })
    expect(await readPatchManifest(file)).toEqual({
      game: 'Factorio',
      player: 3,
      playerName: 'Rocket',
      server: 'archipelago.gg:38281',
      patchFileEnding: '.zip',
      baseChecksums: [],
      resultFileEnding: null,
      compatibleVersion: null,
      version: null,
    })
  })

  it('missing, invalid or incomplete manifest is PATCH_INVALID', async () => {
    const noManifest = await makePatchZip(join(root, 'none.apemerald'), null, { 'delta.bsdiff4': 'x' })
    const notJson = await makePatchZip(join(root, 'text.apemerald'), '{not json')
    const notObject = await makePatchZip(join(root, 'array.apemerald'), '[1, 2]')
    const noGame = await makePatchZip(join(root, 'nogame.apemerald'), patchManifest({ game: '' }))
    const badChecksum = await makePatchZip(join(root, 'bad.apemerald'), patchManifest({ base_checksum: [1] }))
    const notZip = join(root, 'plain.apemerald')
    writeFileSync(notZip, 'not a zip at all')

    for (const file of [noManifest, notJson, notObject, noGame, badChecksum, notZip]) {
      const error = await failure(readPatchManifest(file))
      expect(error.code, file).toBe('PATCH_INVALID')
    }
  })

  it('a file that does not exist is NOT_FOUND', async () => {
    expect((await failure(readPatchManifest(join(root, 'gone.apemerald')))).code).toBe('NOT_FOUND')
  })
})
