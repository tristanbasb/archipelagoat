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
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApSettings } from '@main/core/ap/settings'
import { writeFileAtomic } from '@main/core/system/fsx'
import {
  createWorkspace,
  importPlayerSources,
  moveWorkspaceToBackups,
  storedNameFor,
  workspacePaths,
  writeSessionHostYaml,
} from '@main/core/sessions/workspace'
import { makeZip } from './helpers'

const BOM = String.fromCharCode(0xfeff)
const YAMLS = fileURLToPath(new URL('../../fixtures/yamls/', import.meta.url))

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat workspace é-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

function file(name: string, data: string | Buffer): string {
  const target = join(root, 'in', name)
  mkdirSync(join(root, 'in'), { recursive: true })
  writeFileSync(target, data)
  return target
}

describe('storedNameFor', () => {
  it('keeps [A-Za-z0-9 _.-], always ends with .yaml and dedupes with -2, -3', () => {
    expect(storedNameFor('Alice.yaml', [])).toBe('Alice.yaml')
    expect(storedNameFor('Alice.YML', [])).toBe('Alice.yaml')
    expect(storedNameFor('notes.txt', [])).toBe('notes.yaml')
    expect(storedNameFor('Goat', [])).toBe('Goat.yaml')
    expect(storedNameFor('alice.yaml', ['Alice.yaml'])).toBe('alice-2.yaml')
    expect(storedNameFor('Alice.yaml', ['Alice.yaml', 'alice-2.yaml'])).toBe('Alice-3.yaml')
    expect(storedNameFor('Alice.v2.yaml', [])).toBe('Alice.v2.yaml')
  })

  it('makes any name safe for Windows, Linux and Archipelago', () => {
    // Accents lose their marks; anything else becomes `_`.
    expect(storedNameFor('Héloïse.yaml', [])).toBe('Heloise.yaml')
    expect(storedNameFor('Bob (1).yaml', [])).toBe('Bob _1.yaml')
    expect(storedNameFor('名前.yaml', [])).toBe('player.yaml')
    expect(storedNameFor('', [])).toBe('player.yaml')
    // A path keeps its last part only.
    expect(storedNameFor('..\\..\\Windows\\evil.yaml', [])).toBe('evil.yaml')
    expect(storedNameFor('../etc/passwd', [])).toBe('passwd.yaml')
    // Archipelago skips dotfiles; Windows drops trailing dots and spaces.
    expect(storedNameFor('.hidden.yaml', [])).toBe('hidden.yaml')
    expect(storedNameFor('trailing. .yaml', [])).toBe('trailing.yaml')
    // Device names of Windows.
    expect(storedNameFor('CON.yaml', [])).toBe('_CON.yaml')
    expect(storedNameFor('nul.backup.yaml', [])).toBe('_nul.backup.yaml')
    expect(storedNameFor('com1.yaml', [])).toBe('_com1.yaml')
    expect(storedNameFor('Console.yaml', [])).toBe('Console.yaml')
    // meta.yaml and weights.yaml are not player files for Archipelago.
    expect(storedNameFor('meta.yaml', [])).toBe('meta-2.yaml')
    expect(storedNameFor('Weights.yml', [])).toBe('Weights-2.yaml')
    // Long names are cut.
    expect(storedNameFor(`${'a'.repeat(200)}.yaml`, [])).toBe(`${'a'.repeat(64)}.yaml`)
  })
})

describe('importPlayerSources', () => {
  it('imports .yaml, .yml and YAML .txt files; everything else is ignored', async () => {
    const yaml = file('Alice.yaml', 'name: Alice\ngame: TUNIC\nTUNIC: {}\n')
    const yml = file('Bob.yml', `${BOM}name: Bob\r\ngame: TUNIC\r\nTUNIC: {}\r\n`)
    const txt = file('Carol.txt', 'name: Carol\ngame: TUNIC\nTUNIC: {}\n')
    const prose = file('notes.txt', 'Remember to bring snacks.\n')
    const broken = file('broken.yaml', 'name: [\n')
    const png = file('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const missing = join(root, 'in', 'gone.yaml')
    const { files, ignored } = await importPlayerSources([yaml, yml, txt, prose, broken, png, missing])
    expect(files).toEqual([
      { originalName: 'Alice.yaml', text: 'name: Alice\ngame: TUNIC\nTUNIC: {}\n', issues: [] },
      { originalName: 'Bob.yml', text: 'name: Bob\r\ngame: TUNIC\r\nTUNIC: {}\r\n', issues: [] },
      { originalName: 'Carol.txt', text: 'name: Carol\ngame: TUNIC\nTUNIC: {}\n', issues: [] },
      // A .yaml file is a player file even when it does not parse: its errors are shown.
      { originalName: 'broken.yaml', text: 'name: [\n', issues: [] },
    ])
    expect(ignored).toEqual([prose, png, missing])
  })

  it('decodes UTF-16 and Windows-1252, the latter with an encoding-fallback warning', async () => {
    const utf16 = file('Zoe.yaml', readFileSync(join(YAMLS, 'utf16le-bom.yaml')))
    const latin = file('Heloise.yaml', readFileSync(join(YAMLS, 'windows-1252.yaml')))
    const { files } = await importPlayerSources([utf16, latin])
    expect(files[0]).toMatchObject({ originalName: 'Zoe.yaml', issues: [] })
    expect(files[0]?.text).toContain('name: Zoé')
    expect(files[1]).toMatchObject({
      originalName: 'Heloise.yaml',
      issues: [{ severity: 'warning', code: 'encoding-fallback' }],
    })
    expect(files[1]?.text).toContain('name: Héloïse')
  })

  it('reads the YAML entries of a zip in memory and lists the other entries as ignored', async () => {
    const zip = await makeZip(join(root, 'in', 'players.zip'), {
      'players/Alice.yaml': 'name: Alice\ngame: TUNIC\nTUNIC: {}\n',
      'players/Bob.txt': 'name: Bob\ngame: TUNIC\nTUNIC: {}\n',
      'players/Heloise.yaml': readFileSync(join(YAMLS, 'windows-1252.yaml')),
      'README.md': '# Hello\n',
      'players/notes.txt': 'not a player\n',
      // macOS leftovers and dotfiles are skipped without a word.
      '__MACOSX/players/._Alice.yaml': Buffer.from([0, 5, 22, 7]),
      'players/.DS_Store': Buffer.from([0, 0, 0, 1]),
      'empty/': '',
    })
    const { files, ignored } = await importPlayerSources([zip])
    expect(files.map((f) => [f.originalName, f.issues.map((i) => i.code)])).toEqual([
      ['Alice.yaml', []],
      ['Bob.txt', []],
      ['Heloise.yaml', ['encoding-fallback']],
    ])
    expect(ignored).toEqual([join(zip, 'README.md'), join(zip, 'players', 'notes.txt')])
  })

  it('ignores a zip without any player file, one that cannot be read, and oversized entries', async () => {
    const noYaml = await makeZip(join(root, 'in', 'docs.zip'), { 'README.md': '# Hello\n' })
    const notZip = file('fake.zip', 'this is not a zip')
    const big = await makeZip(join(root, 'in', 'big.zip'), {
      'Alice.yaml': 'name: Alice\ngame: TUNIC\nTUNIC: {}\n',
      // Hex text barely compresses, so the archive itself stays within its limits.
      'Huge.yaml': `name: Huge\n# ${randomBytes(4.5 * 1024 * 1024).toString('hex')}\n`,
    })
    const { files, ignored } = await importPlayerSources([noYaml, notZip, big])
    expect(files.map((f) => f.originalName)).toEqual(['Alice.yaml'])
    expect(ignored).toEqual([noYaml, notZip, join(big, 'Huge.yaml')])
  })

  it('ignores a player file over 8 MiB', async () => {
    const huge = file('Huge.yaml', `name: Huge\n# ${'x'.repeat(9 * 1024 * 1024)}\n`)
    expect(await importPlayerSources([huge])).toEqual({ files: [], ignored: [huge] })
  })
})

describe('workspace folders', () => {
  it('creates players, output and logs; private on Linux', async () => {
    const ws = workspacePaths(join(root, 'dataRoot'), 's_abc123')
    expect(ws).toEqual({
      dir: join(root, 'dataRoot', 'sessions', 's_abc123'),
      sessionFile: join(root, 'dataRoot', 'sessions', 's_abc123', 'session.json'),
      players: join(root, 'dataRoot', 'sessions', 's_abc123', 'players'),
      output: join(root, 'dataRoot', 'sessions', 's_abc123', 'output'),
      logs: join(root, 'dataRoot', 'sessions', 's_abc123', 'logs'),
    })
    await createWorkspace(ws)
    for (const dir of [ws.dir, ws.players, ws.output, ws.logs]) expect(statSync(dir).isDirectory()).toBe(true)
    if (process.platform === 'linux') expect(statSync(ws.dir).mode & 0o777).toBe(0o700)
  })

  it('refuses an id that is not a session id', () => {
    for (const bad of ['..', 's_../x', 'S_ABC', 's_', 'abc', 's_a/b', 's_a\\b']) {
      expect(() => workspacePaths(root, bad)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    }
  })

  it('moves a workspace to backups, never over an earlier backup', async () => {
    const backups = join(root, 'dataRoot', 'backups')
    const first = workspacePaths(join(root, 'dataRoot'), 's_one')
    await createWorkspace(first)
    writeFileSync(join(first.players, 'Alice.yaml'), 'name: Alice\n')
    const moved = await moveWorkspaceToBackups(first.dir, backups)
    expect(existsSync(first.dir)).toBe(false)
    expect(moved.startsWith(backups)).toBe(true)
    expect(readFileSync(join(moved, 'players', 'Alice.yaml'), 'utf8')).toBe('name: Alice\n')
    // The same session id again within the same second: a second folder.
    await createWorkspace(first)
    const again = await moveWorkspaceToBackups(first.dir, backups)
    expect(again).not.toBe(moved)
    expect(existsSync(moved)).toBe(true)
    expect(readdirSync(backups)).toHaveLength(2)
  })

  it('a failed move leaves no empty folder in backups', async () => {
    const backups = join(root, 'dataRoot', 'backups')
    await expect(
      moveWorkspaceToBackups(join(root, 'dataRoot', 'sessions', 's_gone'), backups),
    ).rejects.toThrow()
    expect(readdirSync(backups)).toEqual([])
  })
})

describe('writeSessionHostYaml', () => {
  it('writes the session host.yaml through makeSessionSettings; owner-only on Linux', async () => {
    const ws = join(root, 'ws')
    mkdirSync(ws)
    const calls: unknown[] = []
    const settings: Pick<ApSettings, 'makeSessionSettings'> = {
      async makeSessionSettings(dir, entries) {
        calls.push([dir, entries])
        const target = join(dir, 'host.yaml')
        await writeFileAtomic(target, 'server_options:\n  password: secret\n')
        return target
      },
    }
    const entries = [{ path: ['server_options', 'password'], value: 'secret' }]
    expect(await writeSessionHostYaml(settings, ws, entries, 'win32')).toBe(join(ws, 'host.yaml'))
    const target = await writeSessionHostYaml(settings, ws, entries, 'linux')
    expect(target).toBe(join(ws, 'host.yaml'))
    expect(calls).toEqual([
      [ws, entries],
      [ws, entries],
    ])
    // Windows has no such mode bits: there the file only stays writable.
    if (process.platform === 'linux') expect(statSync(target).mode & 0o777).toBe(0o600)
    else expect(() => writeFileSync(target, 'x')).not.toThrow()
  })
})
