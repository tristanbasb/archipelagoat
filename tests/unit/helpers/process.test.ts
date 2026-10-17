import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForExit } from '../../helpers/process'

let root: string
const children: number[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat wait é-'))
})

afterEach(async () => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
    await waitForExit(pid)
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** A detached Node program, as a client is started: it runs in `cwd` and the test does not wait for it. */
function start(source: string, cwd: string): number {
  const child = spawn(process.execPath, ['-e', source], { cwd, stdio: 'ignore', detached: true })
  child.unref()
  if (child.pid === undefined) throw new Error('the program did not start')
  children.push(child.pid)
  return child.pid
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('waitForExit', () => {
  it('waits for a running program to exit, and its folder can then be removed', async () => {
    const dir = join(root, 'client folder é')
    mkdirSync(dir)
    const startedAt = Date.now()
    const pid = start('setTimeout(() => {}, 800)', dir)
    expect(alive(pid)).toBe(true)

    await waitForExit(pid)

    expect(alive(pid)).toBe(false)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(700)
    // Under Windows a program running in a folder makes it undeletable (EPERM) until it exits. The
    // retries here (20 + 40 + 60 ms) only cover the moment its handles take to close, far less than
    // the 800 ms the program ran: without the wait above this fails.
    await expect(rm(dir, { recursive: true, maxRetries: 3, retryDelay: 20 })).resolves.toBeUndefined()
  })

  it('returns at once for a program that is already gone', async () => {
    const pid = start('', root)
    await waitForExit(pid)

    const startedAt = Date.now()
    await waitForExit(pid)
    expect(Date.now() - startedAt).toBeLessThan(100)
  })

  it('gives up after the timeout and names the program that is still running', async () => {
    const pid = start('setInterval(() => {}, 1000)', root)

    await expect(waitForExit(pid, 200)).rejects.toThrow(`process ${pid} is still running after 200 ms`)
    expect(alive(pid)).toBe(true)
  })
})
