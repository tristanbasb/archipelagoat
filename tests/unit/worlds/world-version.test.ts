import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadedWorldVersion } from '@main/core/worlds/world-version'
import type { ValidationContext } from '@main/core/yaml/validate'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat world version é-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Writes `text` to `file` with a modification time of `seconds`, which a stat reads back unchanged. */
function write(file: string, text: string, seconds: number): void {
  writeFileSync(file, text)
  utimesSync(file, seconds, seconds)
}

describe('loadedWorldVersion', () => {
  it('is the world_version of the world, else Archipelago’s for a core world, null when not loaded', async () => {
    const installed: ValidationContext['installedGames'] = new Map([
      ['TUNIC', { worldVersion: '3.1.0', file: join(root, 'tunic.apworld') }],
      ['A Link to the Past', { worldVersion: null }],
    ])
    expect(await loadedWorldVersion(installed, 'TUNIC', '0.6.8')).toBe('3.1.0')
    expect(await loadedWorldVersion(installed, 'A Link to the Past', '0.6.8')).toBe('0.6.8')
    expect(await loadedWorldVersion(installed, 'A Link to the Past', null)).toBeNull()
    expect(await loadedWorldVersion(installed, 'Zork', '0.6.8')).toBeNull()
  })

  it('tells a custom world without world_version by its file: the same until it is updated', async () => {
    const file = join(root, 'frogmonster.apworld')
    write(file, 'v1', 1_700_000_000)
    const installed: ValidationContext['installedGames'] = new Map([
      ['Frogmonster', { worldVersion: null, file }],
    ])

    const first = await loadedWorldVersion(installed, 'Frogmonster', '0.6.8')
    expect(first).not.toBeNull()
    expect(first).not.toBe('0.6.8')
    expect(await loadedWorldVersion(installed, 'Frogmonster', '0.6.8')).toBe(first)

    // Updated: the same size at another time, then another size at the same time, is another version.
    write(file, 'v2', 1_700_000_100)
    const second = await loadedWorldVersion(installed, 'Frogmonster', '0.6.8')
    expect(second).not.toBe(first)
    write(file, 'version 3', 1_700_000_100)
    expect(await loadedWorldVersion(installed, 'Frogmonster', '0.6.8')).not.toBe(second)

    // Gone meanwhile: Archipelago no longer loads it.
    rmSync(file)
    expect(await loadedWorldVersion(installed, 'Frogmonster', '0.6.8')).toBeNull()
  })
})
