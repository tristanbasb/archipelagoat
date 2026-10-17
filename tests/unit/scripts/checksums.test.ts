import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../../scripts/checksums.mjs', import.meta.url))

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('scripts/checksums.mjs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goat-checksums-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

  it('writes SHA256SUMS.txt for the five artifacts only, in the format of sha256sum', () => {
    const artifacts = {
      'ArchipelaGOAT-Setup-0.1.0.exe': 'setup',
      'ArchipelaGOAT-0.1.0-portable.exe': 'portable',
      'ArchipelaGOAT-0.1.0.AppImage': 'appimage',
      'archipelagoat_0.1.0_amd64.deb': 'deb',
      'ArchipelaGOAT-0.1.0.tar.gz': 'tarball',
    }
    for (const [name, text] of Object.entries(artifacts)) writeFileSync(join(dir, name), text)
    // What electron-builder leaves next to them: update metadata, block maps, the unpacked apps.
    writeFileSync(join(dir, 'latest.yml'), 'version: 0.1.0')
    writeFileSync(join(dir, 'ArchipelaGOAT-Setup-0.1.0.exe.blockmap'), 'map')
    writeFileSync(join(dir, 'builder-debug.yml'), 'x: 1')
    writeFileSync(join(dir, '__uninstaller-nsis-archipelagoat.exe'), 'uninstaller')
    mkdirSync(join(dir, 'win-unpacked'))
    writeFileSync(join(dir, 'win-unpacked', 'ArchipelaGOAT.exe'), 'app')

    const result = run(dir)
    expect(result.status).toBe(0)
    // Sorted by name, code point order (the same on every machine).
    const expected = Object.keys(artifacts)
      .sort()
      .map((name) => `${sha256(artifacts[name as keyof typeof artifacts])}  ${name}`)
    expect(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8')).toBe(`${expected.join('\n')}\n`)
    expect(result.stdout).toContain('5 artifacts')
  })

  it('replaces an older SHA256SUMS.txt and never lists itself', () => {
    writeFileSync(join(dir, 'ArchipelaGOAT-0.1.0.tar.gz'), 'tarball')
    writeFileSync(join(dir, 'SHA256SUMS.txt'), 'stale')
    expect(run(dir).status).toBe(0)
    expect(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8')).toBe(
      `${sha256('tarball')}  ArchipelaGOAT-0.1.0.tar.gz\n`,
    )
  })

  it('fails when the folder holds no artifact', () => {
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no artifact')
  })

  it('fails when the folder does not exist', () => {
    const result = run(join(dir, 'absent'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('absent')
  })
})
