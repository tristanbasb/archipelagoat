import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  apSpawnOptions,
  buildApEnv,
  childrenFile,
  defaultWindowFor,
  disposeChildren,
  exeNameOf,
  LineSplitter,
  listChildren,
  sessionChildPids,
  spawnAp,
  type ApProcess,
  type ApStream,
  type ChildEntry,
  type SpawnApOptions,
} from '@main/core/ap/process'
import type { Logger } from '@main/core/logger'
import { MASK } from '@main/core/system/redact'
import { listZip, readZipBytes, readZipText } from '@main/core/system/archive'
import type { ExeRef } from '@shared/types'
import { apOutputLines } from '../../helpers/ap-output'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'
import { makePatchZip, makeSeedZip, patchManifest } from '../../helpers/make-patch.mjs'
import { makeShims } from '../../fake-ap/make-shims.mjs'

const FAKE_AP = fileURLToPath(new URL('../../fake-ap/', import.meta.url))
const SEED = '47305681920473519826'

/** The fake program `name` of tests/fake-ap, run by this Node. */
const fake = (name: string, env?: Record<string, string>): ExeRef => ({
  command: process.execPath,
  argsPrefix: [join(FAKE_AP, `${name}.mjs`)],
  ...(env ? { env } : {}),
})

interface FakeRecord {
  program: string
  argv: string[]
  cwd: string
  env: { [key: string]: string }
  runtime: string
}

const readRecord = (file: string): FakeRecord => JSON.parse(readFileSync(file, 'utf8')) as FakeRecord

/** Rejects when `promise` has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Electron's binary when it is installed: it runs a script as Node only with ELECTRON_RUN_AS_NODE. */
function electronBinary(): string | null {
  try {
    const path = createRequire(import.meta.url)('electron') as string
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Collects the lines of a process and waits for the first one matching a pattern. */
function collector() {
  const lines: { stream: ApStream; line: string }[] = []
  const waiters: { re: RegExp; resolve: (line: string) => void }[] = []
  const onLine = (stream: ApStream, line: string): void => {
    lines.push({ stream, line })
    for (const waiter of [...waiters]) {
      if (!waiter.re.test(line)) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(line)
    }
  }
  const next = (re: RegExp, ms = 5000): Promise<string> => {
    const found = lines.find((l) => re.test(l.line))
    if (found) return Promise.resolve(found.line)
    return within(new Promise<string>((resolve) => waiters.push({ re, resolve })), ms)
  }
  const of = (stream: ApStream): string[] => lines.filter((l) => l.stream === stream).map((l) => l.line)
  return { lines, onLine, next, of }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

let root: string
let core: TestCore
let spawned: ApProcess[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat process é-'))
  core = createTestContext(root)
  spawned = []
})

afterEach(async () => {
  for (const proc of spawned) proc.kill()
  await Promise.allSettled(spawned.map((proc) => proc.exited))
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

/** spawnAp with the defaults of these tests (cwd = root, stdin ignored), killed after the test. */
function run(opts: Partial<SpawnApOptions> & Pick<SpawnApOptions, 'exe'>): ApProcess {
  const proc = spawnAp(core.ctx, { args: [], cwd: root, stdin: 'ignore', ...opts })
  spawned.push(proc)
  return proc
}

describe('LineSplitter', () => {
  it('LineSplitter joins partial lines and handles CRLF and split UTF-8', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('Creating Multi')).toEqual([])
    expect(splitter.push('World.\r\nCreating Items.\r')).toEqual(['Creating MultiWorld.'])
    expect(splitter.push('\n\nFound 82')).toEqual(['Creating Items.', ''])
    expect(splitter.push(' World Types:\n')).toEqual(['Found 82 World Types:'])

    // `é` and `ô` are two bytes each: cut both in half between chunks.
    const bytes = Buffer.from('Jérôme Dupont\r\nPress enter to close.', 'utf8')
    expect(splitter.push(bytes.subarray(0, 2))).toEqual([])
    expect(splitter.push(bytes.subarray(2, 5))).toEqual([])
    expect(splitter.push(bytes.subarray(5))).toEqual(['Jérôme Dupont'])

    // A prompt has no line end: it comes out on flush, once.
    expect(splitter.flush()).toEqual(['Press enter to close.'])
    expect(splitter.flush()).toEqual([])
  })
})

describe('environment and spawn options', () => {
  it('buildApEnv strips PYTHONHOME/PYTHONPATH and sets PYTHONUNBUFFERED', () => {
    const base = {
      PATH: '/usr/bin',
      PYTHONHOME: 'C:\\Python312',
      PythonPath: 'C:\\lib',
      LD_LIBRARY_PATH: '/opt/lib',
      PYTHONUNBUFFERED: '0',
      pythonioencoding: 'latin-1',
      UNSET: undefined,
    }
    const before = { ...base }

    expect(buildApEnv(base, false)).toEqual({
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/opt/lib',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    })
    expect(buildApEnv(base, true)).toEqual({
      PATH: '/usr/bin',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    })
    expect(base).toEqual(before)
  })

  it('defaultWindowFor hides Generate/Server/LauncherDebug and shows clients', () => {
    for (const name of ['ArchipelagoGenerate', 'ArchipelagoServer', 'ArchipelagoLauncherDebug']) {
      expect(defaultWindowFor(name)).toBe('hidden')
      expect(defaultWindowFor(`${name}.exe`)).toBe('hidden')
    }
    for (const name of [
      'ArchipelagoBizHawkClient',
      'ArchipelagoSNIClient',
      'ArchipelagoTextClient',
      'ArchipelagoLauncher',
      'EmuHawk',
    ]) {
      expect(defaultWindowFor(name)).toBe('visible')
    }

    const base: Omit<SpawnApOptions, 'exe'> = { args: [], cwd: root, stdin: 'ignore' }
    expect(apSpawnOptions({ ...base, exe: fake('ArchipelagoServer') })).toMatchObject({
      windowsHide: true,
      shell: false,
      cwd: root,
      detached: false,
    })
    expect(apSpawnOptions({ ...base, exe: fake('ArchipelagoTextClient') }).windowsHide).toBe(false)
    expect(apSpawnOptions({ ...base, exe: fake('ArchipelagoGenerate'), window: 'visible' }).windowsHide).toBe(
      false,
    )
    expect(apSpawnOptions({ ...base, exe: fake('ArchipelagoLauncher'), window: 'hidden' }).windowsHide).toBe(
      true,
    )
  })

  it('names the program of an ExeRef: installed exe, AppImage --executable or fake script', () => {
    expect(
      exeNameOf({ command: 'C:\\ProgramData\\Archipelago\\ArchipelagoServer.exe', argsPrefix: [] }),
    ).toBe('ArchipelagoServer')
    expect(exeNameOf({ command: '/opt/Archipelago/ArchipelagoGenerate', argsPrefix: [] })).toBe(
      'ArchipelagoGenerate',
    )
    expect(
      exeNameOf({
        command: '/home/me/Archipelago_0.6.8.AppImage',
        argsPrefix: ['--executable=ArchipelagoServer'],
      }),
    ).toBe('ArchipelagoServer')
    expect(exeNameOf(fake('ArchipelagoTextClient'))).toBe('ArchipelagoTextClient')
  })

  it('pipes the output of attached programs and ignores it for fire-and-forget ones', () => {
    const base: Omit<SpawnApOptions, 'exe'> = { args: [], cwd: root, stdin: 'pipe' }
    expect(apSpawnOptions({ ...base, exe: fake('ArchipelagoServer') }).stdio).toEqual([
      'pipe',
      'pipe',
      'pipe',
    ])
    expect(
      apSpawnOptions({ ...base, exe: fake('ArchipelagoServer'), detached: true, selfManaged: true }).stdio,
    ).toEqual(['pipe', 'pipe', 'pipe'])
    expect(
      apSpawnOptions({ ...base, stdin: 'ignore', exe: fake('ArchipelagoBizHawkClient'), detached: true }),
    ).toMatchObject({ stdio: ['ignore', 'ignore', 'ignore'], detached: true })
  })
})

describe('spawnAp with the fake Archipelago programs', () => {
  it('generate success prints the captured lines and writes a real seed zip with a valid patch', async () => {
    const out = join(root, 'output')
    const lines = collector()
    const proc = run({ exe: fake('ArchipelagoGenerate'), args: ['--outputpath', out], onLine: lines.onLine })

    expect(await within(proc.exited, 10_000)).toEqual({ code: 0, signal: null })
    const zipPath = join(out, `AP_${SEED}.zip`)
    expect(lines.of('stdout')).toEqual(
      apOutputLines('generate-success.txt').map((line) =>
        line.startsWith('Creating final archive at ') ? `Creating final archive at ${zipPath}` : line,
      ),
    )
    expect(proc.lastLines(1)).toEqual([lines.of('stdout').at(-1)])

    const names = (await listZip(zipPath)).map((entry) => entry.name).sort()
    expect(names).toEqual([
      `AP_${SEED}.archipelago`,
      `AP_${SEED}_P1_Alice.apemerald`,
      `AP_${SEED}_Spoiler.txt`,
    ])

    const spoiler = (await readZipText(zipPath, `AP_${SEED}_Spoiler.txt`)) ?? ''
    expect(spoiler).toMatch(/^Archipelago Version 0\.6\.8 {2}- {2}Seed: /)
    expect(spoiler).toMatch(/^Player 1: Alice\r?\nGame: +Pokemon Emerald\r?$/m)
    expect(spoiler).toMatch(/^Player 2: Bob\r?\nGame: +A Hat in Time\r?$/m)

    const patch = join(root, 'patch.apemerald')
    writeFileSync(patch, (await readZipBytes(zipPath, `AP_${SEED}_P1_Alice.apemerald`)) ?? Buffer.alloc(0))
    expect(JSON.parse((await readZipText(patch, 'archipelago.json')) ?? '{}')).toEqual({
      compatible_version: 6,
      version: 7,
      server: '',
      player: 1,
      player_name: 'Alice',
      game: 'Pokemon Emerald',
      patch_file_ending: '.apemerald',
      procedure: [
        ['apply_bsdiff4', ['base_patch.bsdiff4']],
        ['apply_tokens', ['token_data.bin']],
      ],
      base_checksum: '605b89b67018abcea91e693a4dd25be3',
      result_file_ending: '.gba',
    })
  })

  it('generate fail mode exits (does not hang) with stdin ignore', async () => {
    const lines = collector()
    const started = Date.now()
    const proc = run({ exe: fake('ArchipelagoGenerate'), env: { FAKE_MODE: 'fail' }, onLine: lines.onLine })

    expect(await within(proc.exited, 5000)).toEqual({ code: 1, signal: null })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(lines.of('stderr')).toContain(
      'ValueError: Encountered 1 error(s) in player files. See logs for full tracebacks.',
    )
    // The atexit prompt has no line end: it is flushed when the output closes.
    expect(lines.of('stdout').at(-1)).toBe('Press enter to close.')
    expect(proc.lastLines(1)).toEqual(['Press enter to close.'])
  })

  it('generate fail mode blocks on an open stdin until a line is written, like AP', async () => {
    const lines = collector()
    const proc = run({
      exe: fake('ArchipelagoGenerate'),
      env: { FAKE_MODE: 'fail' },
      stdin: 'pipe',
      onLine: lines.onLine,
    })
    await lines.next(/^ValueError: /)
    await expect(within(proc.exited, 700)).rejects.toThrow(/not settled/)

    proc.write('')
    expect(await within(proc.exited, 5000)).toEqual({ code: 1, signal: null })
  })

  it('kills a slow generate mid-run: no archive, fewer lines', async () => {
    const out = join(root, 'output')
    const lines = collector()
    const proc = run({
      exe: fake('ArchipelagoGenerate'),
      args: ['--outputpath', out],
      env: { FAKE_MODE: 'slow' },
      onLine: lines.onLine,
    })
    await lines.next(/^P1 Weights: /)
    proc.kill()

    const exit = await within(proc.exited, 5000)
    expect(exit.code === 0).toBe(false)
    expect(lines.lines.length).toBeLessThan(apOutputLines('generate-success.txt').length)
    expect(existsSync(join(out, `AP_${SEED}.zip`))).toBe(false)
  })

  it('buffered mode holds the output back: a killed run prints nothing', async () => {
    const lines = collector()
    const proc = run({
      exe: fake('ArchipelagoGenerate'),
      args: ['--outputpath', join(root, 'output')],
      env: { FAKE_MODE: 'slow,buffered' },
      onLine: lines.onLine,
    })
    await delay(800)
    proc.kill()
    await within(proc.exited, 5000)
    expect(lines.lines).toEqual([])
  })

  it('spawns with cwd and args containing spaces and accents', async () => {
    const ws = join(root, 'Jérôme Dupont', 'ws')
    mkdirSync(ws, { recursive: true })
    const recordFile = join(root, 'record.json')
    const args = [
      '--player_files_path',
      join(ws, 'players'),
      '--outputpath',
      join(ws, 'sortie é à'),
      '--spoiler',
      '2',
    ]
    const lines = collector()
    const proc = run({
      exe: fake('ArchipelagoGenerate'),
      args,
      cwd: ws,
      env: { FAKE_RECORD: recordFile },
      onLine: lines.onLine,
    })

    expect(await within(proc.exited, 10_000)).toEqual({ code: 0, signal: null })
    const record = readRecord(recordFile)
    expect(record.argv).toEqual(args)
    expect(record.cwd).toBe(ws)
    expect(record.program).toBe('ArchipelagoGenerate')
    const zip = join(ws, 'sortie é à', `AP_${SEED}.zip`)
    expect(await lines.next(/^Creating final archive at /)).toBe(`Creating final archive at ${zip}`)
    expect(existsSync(zip)).toBe(true)
  })

  it('a shim copied outside the repo runs the real fake script', async () => {
    const shims = join(root, 'Fake AP é')
    const written = makeShims(shims)
    expect(written.map((file) => file.slice(shims.length + 1)).sort()).toEqual([
      'ArchipelagoBizHawkClient.mjs',
      'ArchipelagoGenerate.mjs',
      'ArchipelagoLauncher.mjs',
      'ArchipelagoLauncherDebug.mjs',
      'ArchipelagoSNIClient.mjs',
      'ArchipelagoServer.mjs',
      'ArchipelagoTextClient.mjs',
    ])
    const shim = readFileSync(join(shims, 'ArchipelagoBizHawkClient.mjs'), 'utf8')
    expect(shim.trimEnd().split('\n')).toHaveLength(1)
    expect(shim).toMatch(/^import "file:\/\/\/.+\/tests\/fake-ap\/ArchipelagoClient\.mjs"$/m)

    const recordFile = join(root, 'client.json')
    const client = run({
      exe: { command: process.execPath, argsPrefix: [join(shims, 'ArchipelagoBizHawkClient.mjs')] },
      args: [join(root, 'AP_1_P1_Alice.apemerald')],
      env: { FAKE_RECORD: recordFile },
    })
    expect(await within(client.exited, 5000)).toEqual({ code: 0, signal: null })
    expect(readRecord(recordFile)).toMatchObject({
      program: 'ArchipelagoBizHawkClient',
      argv: [join(root, 'AP_1_P1_Alice.apemerald')],
    })

    // yazl and the captured output resolve from the repository, not from the shim's folder.
    const out = join(root, 'out')
    const generate = run({
      exe: { command: process.execPath, argsPrefix: [join(shims, 'ArchipelagoGenerate.mjs')] },
      args: ['--outputpath', out],
    })
    expect(await within(generate.exited, 10_000)).toEqual({ code: 0, signal: null })
    expect(existsSync(join(out, `AP_${SEED}.zip`))).toBe(true)
  })

  it('merges ExeRef.env (ELECTRON_RUN_AS_NODE) into the child env', async () => {
    const command = electronBinary() ?? process.execPath
    const recordFile = join(root, 'env.json')
    const saved = { PYTHONHOME: process.env.PYTHONHOME, PYTHONPATH: process.env.PYTHONPATH }
    process.env.PYTHONHOME = 'C:\\Python312'
    process.env.PYTHONPATH = 'C:\\Python312\\lib'
    try {
      const proc = run({
        exe: {
          command,
          argsPrefix: [join(FAKE_AP, 'ArchipelagoClient.mjs')],
          env: { ELECTRON_RUN_AS_NODE: '1', FAKE_FROM: 'exe', FAKE_EXE_ONLY: 'yes' },
        },
        env: { FAKE_FROM: 'call', FAKE_RECORD: recordFile },
      })
      expect(await within(proc.exited, 15_000)).toEqual({ code: 0, signal: null })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const record = readRecord(recordFile)
    expect(record.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      FAKE_FROM: 'call',
      FAKE_EXE_ONLY: 'yes',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    })
    expect(record.env).not.toHaveProperty('PYTHONHOME')
    expect(record.env).not.toHaveProperty('PYTHONPATH')
    if (command !== process.execPath) expect(record.runtime).toBe('electron')
    // Starting the Electron binary itself: longer than one test's default, as the wait above says.
  }, 20_000)

  it('exited rejects with the spawn error when the program cannot start', async () => {
    const proc = run({ exe: { command: 'goat-definitely-not-a-program', argsPrefix: [] } })
    await expect(proc.exited).rejects.toMatchObject({ code: 'ENOENT' })
    expect(listChildren()).toEqual([])
  })

  it('write needs a piped stdin', async () => {
    const proc = run({ exe: fake('ArchipelagoClient') })
    expect(() => proc.write('/exit')).toThrow(/stdin/)
    await within(proc.exited, 5000)
    // After the exit a write is dropped.
    const piped = run({ exe: fake('ArchipelagoClient'), stdin: 'pipe' })
    await within(piped.exited, 5000)
    expect(() => piped.write('/exit')).not.toThrow()
  })

  it('a throwing onLine handler is logged and does not stop the runner', async () => {
    const error = vi.fn<Logger['error']>()
    core.ctx.log = { ...silentLogger, error }
    const seen: string[] = []
    const proc = run({
      exe: fake('ArchipelagoGenerate'),
      args: ['--outputpath', join(root, 'output')],
      onLine: (_stream, line) => {
        seen.push(line)
        throw new Error('handler bug')
      },
    })
    expect(await within(proc.exited, 10_000)).toEqual({ code: 0, signal: null })
    expect(seen).toHaveLength(apOutputLines('generate-success.txt').length)
    expect(error).toHaveBeenCalledWith('ap process line handler failed', expect.any(Error))
  })

  it('logs the start without the password arguments', async () => {
    const info = vi.fn<Logger['info']>()
    core.ctx.log = { ...silentLogger, info }
    const proc = run({
      exe: fake('ArchipelagoTextClient'),
      args: ['--connect', 'localhost:38281', '--password', 'hunter2', '--server_password=s3cret'],
    })
    await within(proc.exited, 5000)
    const logged = JSON.stringify(info.mock.calls)
    expect(logged).not.toContain('hunter2')
    expect(logged).not.toContain('s3cret')
    expect(info).toHaveBeenCalledWith(
      'ap process started',
      expect.objectContaining({
        exe: 'ArchipelagoTextClient',
        args: ['--connect', 'localhost:38281', '--password', MASK, `--server_password=${MASK}`],
      }),
    )
  })

  it('exited resolves soon after the exit even when a grandchild holds the output pipes', async () => {
    // Under Linux the grandchild keeps the pipes open for 4 s; Windows closes them with the parent.
    const script = [
      "const { spawn } = require('child_process')",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit' }).unref()",
      "console.log('parent done')",
    ].join('\n')
    const lines = collector()
    const proc = run({ exe: { command: process.execPath, argsPrefix: ['-e', script] }, onLine: lines.onLine })
    expect(await within(proc.exited, 3500)).toEqual({ code: 0, signal: null })
    expect(lines.of('stdout')).toEqual(['parent done'])
  })
})

describe('children registry', () => {
  it('records attached children in dataRoot/run/children.json and removes them on exit', async () => {
    const file = childrenFile(core.platform.paths.dataRoot)
    expect(file).toBe(join(core.platform.paths.dataRoot, 'run', 'children.json'))
    const generate = run({
      exe: fake('ArchipelagoGenerate'),
      env: { FAKE_MODE: 'fail' },
      stdin: 'pipe',
      sessionId: 'session-1',
    })
    const client = run({ exe: fake('ArchipelagoBizHawkClient'), detached: true })

    const entries = JSON.parse(readFileSync(file, 'utf8')) as ChildEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      pid: generate.pid,
      exe: 'ArchipelagoGenerate',
      sessionId: 'session-1',
    })
    expect(Date.parse(entries[0]?.startedAt ?? '')).not.toBeNaN()
    expect(listChildren()).toEqual([{ pid: generate.pid, command: 'ArchipelagoGenerate' }])
    // A child that belongs to a session runs in its folder: the settings lock leaves it out.
    expect(sessionChildPids()).toEqual([generate.pid])
    expect(client.pid).toBeGreaterThan(0)

    generate.write('')
    await within(generate.exited, 5000)
    await within(client.exited, 5000)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
    expect(listChildren()).toEqual([])
    expect(sessionChildPids()).toEqual([])
  })

  it('disposeChildren kills remaining children but not selfManaged ones', async () => {
    const port = await freePort()
    const lines = collector()
    const server = run({
      exe: fake('ArchipelagoServer'),
      args: [join(root, `AP_${SEED}.zip`), '--port', String(port)],
      stdin: 'pipe',
      selfManaged: true,
      onLine: lines.onLine,
    })
    const generate = run({ exe: fake('ArchipelagoGenerate'), env: { FAKE_MODE: 'fail' }, stdin: 'pipe' })
    await lines.next(/^server listening on /)
    expect(
      listChildren()
        .map((c) => c.pid)
        .sort(),
    ).toEqual([server.pid, generate.pid].sort())

    await within(disposeChildren(5000), 6000)
    const exit = await within(generate.exited, 1000)
    expect(exit.code === 0).toBe(false)
    expect(listChildren()).toEqual([{ pid: server.pid, command: 'ArchipelagoServer' }])
    expect(await canConnect(port)).toBe(true)

    server.write('/exit')
    expect(await within(server.exited, 5000)).toEqual({ code: 0, signal: null })
  })

  it.runIf(process.platform === 'linux')(
    'kills the whole process group of a detached selfManaged process',
    async () => {
      const script = [
        "const { spawn } = require('child_process')",
        "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        // A string: with FORCE_COLOR set, console.log colours a number even on a pipe (never a string).
        'console.log(String(c.pid))',
        'setInterval(() => {}, 1000)',
      ].join('\n')
      const lines = collector()
      const proc = run({
        exe: { command: process.execPath, argsPrefix: ['-e', script] },
        detached: true,
        selfManaged: true,
        onLine: lines.onLine,
      })
      const grandchild = Number(await lines.next(/^\d+$/))
      proc.kill()
      await within(proc.exited, 5000)
      await delay(200)
      expect(() => process.kill(grandchild, 0)).toThrow()
    },
    // Longer than the inner waits (5000 + 5000 + 200 ms), so that a failing step reports itself.
    15_000,
  )
})

describe('fake ArchipelagoServer', () => {
  it('prints Hosting game at, then server listening on, and listens on 127.0.0.1', async () => {
    const port = await freePort()
    const recordFile = join(root, 'server.json')
    const lines = collector()
    const proc = run({
      exe: fake('ArchipelagoServer'),
      args: [join(root, `AP_${SEED}.zip`), '--port', String(port), '--disable_item_cheat'],
      stdin: 'pipe',
      env: { FAKE_RECORD: recordFile },
      onLine: lines.onLine,
    })
    const hosting = await lines.next(/^Hosting game at /)
    expect(hosting).toBe(`Hosting game at 203.0.113.7:${port} (No password)`)
    const listening = await lines.next(/^server listening on /)
    expect(listening).toBe(`server listening on 127.0.0.1:${port}`)
    // The order is what the spec asks for (§7.2): the Hosting line comes before the bind. The delay
    // between them is not measured: the parent's receive times jitter under load.
    const stdout = lines.of('stdout')
    expect(stdout.indexOf(listening)).toBeGreaterThan(stdout.indexOf(hosting))
    expect(lines.of('stdout').slice(0, 5)).toEqual(
      apOutputLines('server-startup.txt').slice(0, 4).concat(hosting),
    )

    expect(await canConnect(port)).toBe(true)
    expect(readRecord(recordFile).cwd).toBe(root)

    proc.write('/players')
    expect(await lines.next(/players of \d+ connected/)).toBe(
      '0 players of 2 connected :: Team #1: (Alice) (Bob)',
    )
    proc.write('/exit')
    expect(await within(proc.exited, 5000)).toEqual({ code: 0, signal: null })
    // No --savefile: the default is the multidata path with .apsave.
    expect(existsSync(join(root, `AP_${SEED}.apsave`))).toBe(true)
  })

  it('ignores EOF on stdin and saves next to the multidata on /exit, whatever --savefile says', async () => {
    const port = await freePort()
    const lines = collector()
    const ignoring = run({
      exe: fake('ArchipelagoServer'),
      args: [join(root, `AP_${SEED}.zip`), '--port', String(port)],
      stdin: 'ignore',
      onLine: lines.onLine,
    })
    await lines.next(/^server listening on /)
    await expect(within(ignoring.exited, 500)).rejects.toThrow(/not settled/)
    expect(await canConnect(port)).toBe(true)
    ignoring.kill()
    await within(ignoring.exited, 5000)

    const savefile = join(root, 'saves é', 'game.apsave')
    mkdirSync(join(root, 'saves é'))
    const other = collector()
    const proc = run({
      exe: fake('ArchipelagoServer'),
      args: [join(root, `AP_${SEED}.zip`), '--port', String(await freePort()), '--savefile', savefile],
      stdin: 'pipe',
      onLine: other.onLine,
    })
    await other.next(/^server listening on /)
    proc.write('/exit')
    expect(await within(proc.exited, 5000)).toEqual({ code: 0, signal: null })
    // MultiServer 0.6.8 parses --savefile but never reads it (docs/verification/2026-10-16-real-run.md).
    expect(existsSync(join(root, `AP_${SEED}.apsave`))).toBe(true)
    expect(existsSync(savefile)).toBe(false)
  })

  it('fails with OSError and exit 1 in port-busy mode and on a port in use', async () => {
    const lines = collector()
    const forced = run({
      exe: fake('ArchipelagoServer'),
      args: [join(root, `AP_${SEED}.zip`), '--port', String(await freePort())],
      env: { FAKE_MODE: 'port-busy' },
      onLine: lines.onLine,
    })
    expect(await within(forced.exited, 5000)).toEqual({ code: 1, signal: null })
    expect(lines.of('stdout').at(-1)).toMatch(/^Hosting game at /)
    expect(lines.of('stderr').at(-1)).toMatch(
      /^OSError: \[Errno (10048|98)\] error while attempting to bind on address/,
    )

    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = blocker.address() as AddressInfo
      const busy = collector()
      const proc = run({
        exe: fake('ArchipelagoServer'),
        args: [join(root, `AP_${SEED}.zip`), '--port', String(port)],
        onLine: busy.onLine,
      })
      expect(await within(proc.exited, 5000)).toEqual({ code: 1, signal: null })
      expect(busy.of('stderr').at(-1)).toContain(`('0.0.0.0', ${port})`)
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  })

  it('ignore-exit mode ignores /exit until killed', async () => {
    const lines = collector()
    const proc = run({
      exe: fake('ArchipelagoServer'),
      args: [join(root, `AP_${SEED}.zip`), '--port', String(await freePort())],
      stdin: 'pipe',
      env: { FAKE_MODE: 'ignore-exit' },
      onLine: lines.onLine,
    })
    await lines.next(/^server listening on /)
    proc.write('/exit')
    await expect(within(proc.exited, 700)).rejects.toThrow(/not settled/)
    proc.kill()
    const exit = await within(proc.exited, 5000)
    expect(exit.code === 0).toBe(false)
  })

  it('buffered mode holds the output until /save, while already listening', async () => {
    const port = await freePort()
    const lines = collector()
    const proc = run({
      exe: fake('ArchipelagoServer'),
      args: [join(root, `AP_${SEED}.zip`), '--port', String(port)],
      stdin: 'pipe',
      env: { FAKE_MODE: 'buffered' },
      onLine: lines.onLine,
    })
    for (let i = 0; i < 50 && !(await canConnect(port)); i++) await delay(100)
    expect(await canConnect(port)).toBe(true)
    proc.write('/players')
    await delay(300)
    expect(lines.lines).toEqual([])

    proc.write('/save')
    expect(await lines.next(/^Game saved$/)).toBe('Game saved')
    expect(lines.of('stdout')).toContain(`server listening on 127.0.0.1:${port}`)
    expect(lines.of('stdout')).toContain('0 players of 2 connected :: Team #1: (Alice) (Bob)')
    expect(existsSync(join(root, `AP_${SEED}.apsave`))).toBe(true)
    proc.write('/exit')
    expect(await within(proc.exited, 5000)).toEqual({ code: 0, signal: null })
  })
})

describe('make-patch', () => {
  it('makePatchZip writes the manifest as given (object, raw text or none) with extra entries', async () => {
    const valid = await makePatchZip(
      join(root, 'a', 'valid.apemerald'),
      patchManifest({ player_name: 'Zoé' }),
      {
        'token_data.bin': new Uint8Array([0, 0, 0, 0]),
      },
    )
    expect((await listZip(valid)).map((e) => e.name)).toEqual(['archipelago.json', 'token_data.bin'])
    expect(JSON.parse((await readZipText(valid, 'archipelago.json')) ?? '{}')).toMatchObject({
      player: 1,
      player_name: 'Zoé',
      base_checksum: '605b89b67018abcea91e693a4dd25be3',
    })

    const corrupt = await makePatchZip(join(root, 'corrupt.apemerald'), '{ not json')
    expect(await readZipText(corrupt, 'archipelago.json')).toBe('{ not json')

    const none = await makePatchZip(join(root, 'none.apemerald'), null, { 'delta.bsdiff4': 'x' })
    expect((await listZip(none)).map((e) => e.name)).toEqual(['delta.bsdiff4'])
  })

  it('makeSeedZip writes a single-player spoiler without the Player line, like AP', async () => {
    const zip = await makeSeedZip(join(root, 'AP_1.zip'), {
      seed: '1',
      slots: [{ name: 'Solo Player', game: 'Pokemon Emerald', patch: '.apemerald' }],
    })
    expect((await listZip(zip)).map((e) => e.name).sort()).toEqual([
      'AP_1.archipelago',
      'AP_1_P1_Solo_Player.apemerald',
      'AP_1_Spoiler.txt',
    ])
    // Written as Python's utf-8-sig does: with a BOM.
    expect((await readZipBytes(zip, 'AP_1_Spoiler.txt'))?.subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    )
    const spoiler = (await readZipText(zip, 'AP_1_Spoiler.txt')) ?? ''
    expect(spoiler).not.toMatch(/^Player 1:/m)
    expect(spoiler).toMatch(/^Game: +Pokemon Emerald\r?$/m)
  })
})
