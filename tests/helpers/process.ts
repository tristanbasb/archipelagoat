// Waiting for a program a test started and does not own (a client the product spawns detached).

const POLL_MS = 25

/**
 * Under 10 s, vitest's own timeout for a hook: a program that never exits is reported by the
 * message below, not by "Hook timed out".
 */
const DEFAULT_TIMEOUT_MS = 8_000

/** `process.kill(pid, 0)` sends nothing: it throws ESRCH once the process is gone (EPERM: it is not ours). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Resolves once the process `pid` has exited. A client the product starts is detached and nobody
 * waits for it, but under Windows a program whose working directory is inside a folder makes that
 * folder undeletable until it exits: a test that removes its temporary folder waits here first.
 * Rejects, naming the process, when it is still running after `timeoutMs`.
 *
 * Remove the folder afterwards with `fs.promises.rm` and its `maxRetries`, not `rmSync`: Windows
 * reports the exit status a moment (about a millisecond) before the program's handles, and its
 * working directory, are released, and only the asynchronous `rm` retries on EPERM (Node 24).
 */
export async function waitForExit(pid: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isRunning(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} is still running after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
