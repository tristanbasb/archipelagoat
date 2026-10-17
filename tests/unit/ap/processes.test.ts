import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childrenFile, listChildren, spawnAp, type ApProcess } from '@main/core/ap/process'
import {
  createProcesses,
  findOrphans,
  killOrphan,
  listApProcesses,
  parsePsOutput,
  parseTasklistCsv,
} from '@main/core/ap/processes'
import type { ExecFn } from '@main/core/exec'
import type { Logger } from '@main/core/logger'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
// The `processes` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/processes.service'
import { createTestContext, silentLogger } from '../../helpers/core'

const GENERATE = fileURLToPath(new URL('../../fake-ap/ArchipelagoGenerate.mjs', import.meta.url))

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"ArchipelagoServer.exe","4242","Console","1","45,120 K"',
  '"ArchipelaGOAT.exe","5000","Console","1","120 000 K"',
  '"ArchipelagoGenerate.exe","4343","Console","1","1 234 Ko"',
  '"node.exe","77","Console","1","9 K"',
].join('\r\n')

const PS = [
  '    1 systemd',
  ' 4242 ArchipelagoServ',
  ' 5000 archipelagoat',
  ' 4343 ArchipelagoGene',
  '   77 node',
  '',
].join('\n')

const NO_TASK = 'INFO: No tasks are running which match the specified criteria.\r\n'

interface Entry {
  pid: number
  exe: string
  sessionId: string | null
  startedAt: string
}

const entry = (pid: number, exe: string, sessionId: string | null = null): Entry => ({
  pid,
  exe,
  sessionId,
  startedAt: '2026-10-17T10:00:00.000Z',
})

const writeEntries = (file: string, entries: Entry[]): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(entries))
}

const pidsIn = (file: string): number[] =>
  (JSON.parse(readFileSync(file, 'utf8')) as Entry[]).map((e) => e.pid)

/**
 * `tasklist /FI "PID eq n" /FO CSV /NH` as Windows answers it: one row when the pid runs, the INFO
 * line otherwise. `names` maps a pid to its image name; a pid in `failing` makes tasklist fail.
 */
function tasklistExec(names: Map<number, string>, failing: number[] = []) {
  return vi.fn<ExecFn>((cmd, args) => {
    if (cmd !== 'tasklist') return Promise.reject(new Error(`unexpected ${cmd}`))
    const filter = args[args.indexOf('/FI') + 1] ?? ''
    const pid = Number(/^PID eq (\d+)$/.exec(filter)?.[1])
    if (failing.includes(pid)) return Promise.resolve({ code: 1, stdout: '', stderr: 'ERROR: RPC' })
    const name = names.get(pid)
    const stdout = name === undefined ? NO_TASK : `"${name}","${pid}","Console","1","12 345 K"\r\n`
    return Promise.resolve({ code: 0, stdout, stderr: '' })
  })
}

const writeCmdline = (procRoot: string, pid: number, argv: string[]): void => {
  mkdirSync(join(procRoot, String(pid)), { recursive: true })
  writeFileSync(join(procRoot, String(pid), 'cmdline'), `${argv.join('\0')}\0`)
}

/** A real process that stays alive (the fake Generate in fail mode waits on its open stdin). */
function blockingProcess(): ChildProcess & { pid: number } {
  const child = spawn(process.execPath, [GENERATE], {
    env: { ...process.env, FAKE_MODE: 'fail' },
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  if (child.pid === undefined) throw new Error('cannot start the blocking process')
  return child as ChildProcess & { pid: number }
}

async function exitWithin(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`pid ${child.pid} still running after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

let root: string
let children: ChildProcess[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat processes é-'))
  children = []
})

afterEach(async () => {
  for (const child of children) child.kill()
  await Promise.allSettled(children.map((child) => exitWithin(child, 5000)))
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const track = <T extends ChildProcess>(child: T): T => {
  children.push(child)
  return child
}

describe('system process lists', () => {
  it('parses tasklist CSV and ps output', () => {
    expect(parseTasklistCsv(`${TASKLIST}\r\n${NO_TASK}`)).toEqual([
      { pid: 0, name: 'System Idle Process' },
      { pid: 4242, name: 'ArchipelagoServer.exe' },
      { pid: 5000, name: 'ArchipelaGOAT.exe' },
      { pid: 4343, name: 'ArchipelagoGenerate.exe' },
      { pid: 77, name: 'node.exe' },
    ])
    expect(parseTasklistCsv('"Program ""quoted"", with comma.exe","12","Console","1","1 K"')).toEqual([
      { pid: 12, name: 'Program "quoted", with comma.exe' },
    ])
    expect(parseTasklistCsv(NO_TASK)).toEqual([])

    expect(parsePsOutput(PS)).toEqual([
      { pid: 1, name: 'systemd' },
      { pid: 4242, name: 'ArchipelagoServ' },
      { pid: 5000, name: 'archipelagoat' },
      { pid: 4343, name: 'ArchipelagoGene' },
      { pid: 77, name: 'node' },
    ])
  })

  it('listApProcesses keeps the Archipelago programs (not ArchipelaGOAT) from tasklist or ps', async () => {
    const exec = vi.fn<ExecFn>((cmd) =>
      Promise.resolve({ code: 0, stdout: cmd === 'tasklist' ? TASKLIST : PS, stderr: '' }),
    )
    expect(await listApProcesses(exec, 'win32')).toEqual([
      { pid: 4242, name: 'ArchipelagoServer.exe' },
      { pid: 4343, name: 'ArchipelagoGenerate.exe' },
    ])
    expect(exec).toHaveBeenLastCalledWith('tasklist', ['/FO', 'CSV', '/NH'], expect.any(Object))
    expect(await listApProcesses(exec, 'linux')).toEqual([
      { pid: 4242, name: 'ArchipelagoServ' },
      { pid: 4343, name: 'ArchipelagoGene' },
    ])
    expect(exec).toHaveBeenLastCalledWith('ps', ['-eo', 'pid=,comm='], expect.any(Object))

    const failing = vi.fn<ExecFn>(() =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'ERROR: access denied' }),
    )
    await expect(listApProcesses(failing, 'win32')).rejects.toThrow(/tasklist exited with code 1/)
  })
})

describe('orphans of a previous run', () => {
  it('findOrphans keeps live Archipelago pids and purges dead or reused ones', async () => {
    // Windows: tasklist per pid.
    const win = createTestContext(join(root, 'win'), { os: 'win32' })
    const winFile = childrenFile(win.platform.paths.dataRoot)
    writeEntries(winFile, [
      entry(101, 'ArchipelagoServer', 'session-a'), // still the server
      entry(102, 'ArchipelagoGenerate'), // dead
      entry(103, 'ArchipelagoGenerate', 'session-b'), // pid reused by another program
      entry(104, 'ArchipelagoGenerate'), // pid reused by another Archipelago program
      entry(105, 'ArchipelagoServer'), // cannot be checked: kept, not reported
      entry(106, 'EmuHawk'), // not an Archipelago program
    ])
    win.ctx.exec = tasklistExec(
      new Map([
        [101, 'ArchipelagoServer.exe'],
        [103, 'notepad.exe'],
        [104, 'ArchipelagoLauncher.exe'],
        [106, 'EmuHawk.exe'],
      ]),
      [105],
    )
    // A child of this run is neither probed nor reported, and stays in the file.
    const own: ApProcess = spawnAp(win.ctx, {
      exe: { command: process.execPath, argsPrefix: [GENERATE] },
      args: [],
      cwd: root,
      stdin: 'pipe',
      env: { FAKE_MODE: 'fail' },
    })
    try {
      expect(await findOrphans(win.ctx)).toEqual([
        { pid: 101, exe: 'ArchipelagoServer', sessionId: 'session-a' },
      ])
      expect(pidsIn(winFile).sort((a, b) => a - b)).toEqual([101, 105, own.pid].sort((a, b) => a - b))
      expect(win.ctx.exec).not.toHaveBeenCalledWith(
        'tasklist',
        ['/FI', `PID eq ${own.pid}`, '/FO', 'CSV', '/NH'],
        expect.anything(),
      )
    } finally {
      own.kill()
      await own.exited
    }

    // Linux: /proc/<pid>/cmdline.
    const linux = createTestContext(join(root, 'linux'), { os: 'linux' })
    const linuxFile = childrenFile(linux.platform.paths.dataRoot)
    const procRoot = join(root, 'proc')
    writeCmdline(procRoot, 201, [
      '/opt/Archipelago/ArchipelagoServer',
      '/ws/output/AP_1.zip',
      '--port',
      '38281',
    ])
    writeCmdline(procRoot, 202, [
      '/usr/bin/node',
      '/repo/tests/fake-ap/ArchipelagoGenerate.mjs',
      '--outputpath',
      'o',
    ])
    writeCmdline(procRoot, 203, ['/usr/bin/bash'])
    writeCmdline(procRoot, 205, [
      '/home/me/Archipelago_0.6.8.AppImage',
      '--executable=ArchipelagoServer',
      'x.zip',
    ])
    writeCmdline(procRoot, 206, ['/usr/bin/less', '/ws/ArchipelagoGenerate'])
    writeEntries(linuxFile, [
      entry(201, 'ArchipelagoServer', 's1'),
      entry(202, 'ArchipelagoGenerate'),
      entry(203, 'ArchipelagoGenerate'),
      entry(204, 'ArchipelagoGenerate'),
      entry(205, 'ArchipelagoServer'),
      entry(206, 'ArchipelagoGenerate'),
    ])
    expect(await findOrphans(linux.ctx, { procRoot })).toEqual([
      { pid: 201, exe: 'ArchipelagoServer', sessionId: 's1' },
      { pid: 202, exe: 'ArchipelagoGenerate', sessionId: null },
      { pid: 205, exe: 'ArchipelagoServer', sessionId: null },
    ])
    expect(pidsIn(linuxFile)).toEqual([201, 202, 205])
  })

  it('findOrphans answers nothing without a registry, or with a broken one', async () => {
    const core = createTestContext(root, { os: 'win32' })
    core.ctx.exec = tasklistExec(new Map())
    expect(await findOrphans(core.ctx)).toEqual([])
    const file = childrenFile(core.platform.paths.dataRoot)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ broken')
    expect(await findOrphans(core.ctx)).toEqual([])
    writeFileSync(file, JSON.stringify([{ pid: 'x' }, entry(7, 'ArchipelagoServer')]))
    expect(await findOrphans(core.ctx)).toEqual([])
    expect(pidsIn(file)).toEqual([])
  })

  it('killOrphan kills only a verified orphan, after checking it again', async () => {
    const core = createTestContext(root, { os: 'win32' })
    const file = childrenFile(core.platform.paths.dataRoot)
    const orphan = track(blockingProcess())
    const names = new Map([[orphan.pid, 'ArchipelagoGenerate.exe']])
    core.ctx.exec = tasklistExec(names)
    writeEntries(file, [entry(orphan.pid, 'ArchipelagoGenerate')])

    // Unknown to findOrphans: never killed.
    expect(await killOrphan(orphan.pid)).toBe(false)
    expect(orphan.exitCode).toBeNull()

    // Verified, then the pid is reused before the kill: left alone, and forgotten.
    expect(await findOrphans(core.ctx)).toEqual([
      { pid: orphan.pid, exe: 'ArchipelagoGenerate', sessionId: null },
    ])
    names.set(orphan.pid, 'notepad.exe')
    expect(await killOrphan(orphan.pid)).toBe(true)
    expect(orphan.exitCode).toBeNull()
    expect(pidsIn(file)).toEqual([])
    expect(await killOrphan(orphan.pid)).toBe(false)

    // Verified and still the same program: killed and removed from the registry.
    names.set(orphan.pid, 'ArchipelagoGenerate.exe')
    writeEntries(file, [entry(orphan.pid, 'ArchipelagoGenerate'), entry(9, 'ArchipelagoServer')])
    expect(await findOrphans(core.ctx)).toHaveLength(1)
    expect(await killOrphan(orphan.pid)).toBe(true)
    await exitWithin(orphan, 5000)
    expect(pidsIn(file)).toEqual([])
  })

  it('kills the non-server orphans at startup and leaves the servers to their owner', async () => {
    const core = createTestContext(root, { os: 'win32' })
    const warn = vi.fn<Logger['warn']>()
    core.ctx.log = { ...silentLogger, warn }
    const generate = track(blockingProcess())
    const server = track(blockingProcess())
    core.ctx.exec = tasklistExec(
      new Map([
        [generate.pid, 'ArchipelagoGenerate.exe'],
        [server.pid, 'ArchipelagoServer.exe'],
      ]),
    )
    const file = childrenFile(core.platform.paths.dataRoot)
    writeEntries(file, [
      entry(generate.pid, 'ArchipelagoGenerate', 's1'),
      entry(server.pid, 'ArchipelagoServer', 's2'),
    ])

    const processes = createProcesses(core.ctx)
    await processes.ready
    await exitWithin(generate, 5000)
    expect(server.exitCode).toBeNull()
    expect(warn).toHaveBeenCalledWith('killing an orphan ap process', {
      pid: generate.pid,
      exe: 'ArchipelagoGenerate',
      sessionId: 's1',
    })
    expect(pidsIn(file)).toEqual([server.pid])
    expect(await findOrphans(core.ctx)).toEqual([
      { pid: server.pid, exe: 'ArchipelagoServer', sessionId: 's2' },
    ])
  })

  it('registers a late before-quit hook that kills what is left of the children', async () => {
    const core = createTestContext(root)
    const processes = createProcesses(core.ctx)
    await processes.ready
    const proc = spawnAp(core.ctx, {
      exe: { command: process.execPath, argsPrefix: [GENERATE] },
      args: [],
      cwd: root,
      stdin: 'pipe',
      env: { FAKE_MODE: 'fail' },
    })
    let aliveDuringEarly = false
    core.ctx.lifecycle.onBeforeQuit(
      () => {
        aliveDuringEarly = listChildren().some((child) => child.pid === proc.pid)
        return Promise.resolve()
      },
      { phase: 'early' },
    )
    await core.lifecycle.runBeforeQuit()
    expect(aliveDuringEarly).toBe(true)
    expect(listChildren()).toEqual([])
    const exit = await proc.exited
    expect(exit.code === 0).toBe(false)
  })
})

describe('processes service', () => {
  it('ap:processes answers the Archipelago programs running on the machine', async () => {
    const core = createTestContext(root, { os: 'win32' })
    core.ctx.exec = vi.fn<ExecFn>((cmd, args) =>
      Promise.resolve({ code: 0, stdout: args.includes('/FI') ? NO_TASK : TASKLIST, stderr: cmd }),
    )
    const services = createServices(core.ctx)
    const ipc = createIpcRegistry()
    registerHandlers(services, ipc.registerHandler)
    expect(await ipc.dispatch('ap:processes', undefined, { senderId: 1 })).toEqual({
      ok: true,
      value: [
        { pid: 4242, name: 'ArchipelagoServer.exe' },
        { pid: 4343, name: 'ArchipelagoGenerate.exe' },
      ],
    })
    await services.get('processes').ready
  })
})
