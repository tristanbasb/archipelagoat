import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLicenses } from '@renderer/features/settings/licenses'

const script = fileURLToPath(new URL('../../../scripts/licenses.mjs', import.meta.url))

/** A package-lock.json v3 with the flags npm writes: dev, devOptional, link. */
const LOCK = {
  name: 'archipelagoat',
  lockfileVersion: 3,
  packages: {
    '': { name: 'archipelagoat', version: '0.1.0' },
    'node_modules/zod': { version: '4.6.7', license: 'MIT' },
    'node_modules/@tabler/icons-react': { version: '3.49.0', license: 'MIT' },
    'node_modules/tar': { version: '7.5.22', license: 'BlueOak-1.0.0' },
    // A nested copy of another version is listed too; the same version twice only once.
    'node_modules/tar/node_modules/yallist': { version: '5.0.0', license: 'BlueOak-1.0.0' },
    'node_modules/yallist': { version: '4.0.0', license: 'ISC' },
    'node_modules/a/node_modules/yallist': { version: '4.0.0', license: 'ISC' },
    'node_modules/a': { version: '1.0.0' },
    // Never in the app: build and test tools, optional peers of the build.
    'node_modules/vitest': { version: '5.0.5', license: 'MIT', dev: true },
    'node_modules/typescript': { version: '6.0.3', license: 'Apache-2.0', devOptional: true },
    'node_modules/local': { resolved: 'packages/local', link: true },
    // Electron is a devDependency, yet it is the runtime every build ships.
    'node_modules/electron': { version: '44.8.0', license: 'MIT', dev: true },
  },
}

describe('scripts/licenses.mjs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goat-licenses-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function run(lock: unknown): { status: number | null; stderr: string; out: string } {
    const lockFile = join(dir, 'package-lock.json')
    const out = join(dir, 'resources', 'licenses.json')
    writeFileSync(lockFile, JSON.stringify(lock))
    const result = spawnSync(process.execPath, [script, lockFile, out], { encoding: 'utf8' })
    return { status: result.status, stderr: result.stderr, out }
  }

  it('lists the shipped packages, Electron included, sorted by name then version', () => {
    const result = run(LOCK)
    expect(result.status).toBe(0)
    const written: unknown = JSON.parse(readFileSync(result.out, 'utf8'))
    expect(written).toEqual([
      { name: '@tabler/icons-react', version: '3.49.0', license: 'MIT' },
      { name: 'a', version: '1.0.0', license: null },
      { name: 'electron', version: '44.8.0', license: 'MIT' },
      { name: 'tar', version: '7.5.22', license: 'BlueOak-1.0.0' },
      { name: 'yallist', version: '4.0.0', license: 'ISC' },
      { name: 'yallist', version: '5.0.0', license: 'BlueOak-1.0.0' },
      { name: 'zod', version: '4.6.7', license: 'MIT' },
    ])
  })

  it('writes what the About panel reads', () => {
    const result = run(LOCK)
    const entries = parseLicenses(JSON.parse(readFileSync(result.out, 'utf8')))
    expect(entries).toHaveLength(7)
    expect(entries?.find((entry) => entry.name === 'electron')).toEqual({
      name: 'electron',
      version: '44.8.0',
      license: 'MIT',
    })
  })

  it('lists the real lockfile: the runtime dependencies and Electron, never a build tool', () => {
    const out = join(dir, 'licenses.json')
    const lockFile = fileURLToPath(new URL('../../../package-lock.json', import.meta.url))
    const result = spawnSync(process.execPath, [script, lockFile, out], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    const names = (JSON.parse(readFileSync(out, 'utf8')) as { name: string }[]).map((entry) => entry.name)
    expect(names).toEqual(expect.arrayContaining(['react', 'zod', 'electron-updater', 'electron']))
    expect(names).not.toContain('vitest')
    expect(names).not.toContain('electron-builder')
    expect(names).not.toContain('typescript')
  })

  it('fails on a file that is not a package-lock.json v2 or v3', () => {
    const result = run({ lockfileVersion: 1, dependencies: {} })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('package-lock.json')
  })
})
