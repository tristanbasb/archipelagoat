import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonSync, writeJsonAtomicSync } from '@main/core/json-file'

// renameSync fails with these codes, in order, before behaving normally again.
const renameFailures = vi.hoisted(() => [] as string[])

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      const code = renameFailures.shift()
      if (code) throw Object.assign(new Error(`${code}: rename`), { code })
      fs.renameSync(from, to)
    },
  }
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat-json-file-'))
  renameFailures.length = 0
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('json files', () => {
  it('readJsonSync returns undefined for a missing or invalid file', () => {
    expect(readJsonSync(join(dir, 'missing.json'))).toBeUndefined()
    writeFileSync(join(dir, 'bad.json'), '{oops')
    expect(readJsonSync(join(dir, 'bad.json'))).toBeUndefined()
  })

  it('writes atomically into a new folder and reads it back', () => {
    const file = join(dir, 'a', 'b', 'config.json')
    writeJsonAtomicSync(file, { language: 'fr' })
    expect(readJsonSync(file)).toEqual({ language: 'fr' })
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['config.json'])
  })

  it('retries a rename blocked for a moment (antivirus scan)', () => {
    const file = join(dir, 'config.json')
    renameFailures.push('EPERM', 'EBUSY')
    writeJsonAtomicSync(file, { ok: true })
    expect(readJsonSync(file)).toEqual({ ok: true })
    expect(readdirSync(dir)).toEqual(['config.json'])
  })

  it('gives up after repeated failures, or at once on other errors, and removes its temporary file', () => {
    const file = join(dir, 'config.json')
    renameFailures.push('EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM')
    expect(() => writeJsonAtomicSync(file, {})).toThrow(/EPERM/)
    renameFailures.length = 0
    renameFailures.push('EXDEV', 'EPERM')
    expect(() => writeJsonAtomicSync(file, {})).toThrow(/EXDEV/)
    expect(renameFailures).toEqual(['EPERM'])
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
