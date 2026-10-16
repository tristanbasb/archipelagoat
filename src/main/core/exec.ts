// Runs a short-lived program and collects its output: no shell, hidden window, UTF-8.
// Long-running Archipelago programs go through spawnAp (Task 7) instead.
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { AppError } from '@shared/errors'

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface ExecResult {
  /** Exit code; null when the process was killed by a signal. */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Resolves with the exit code, even a non-zero one. Rejects with `PROCESS_TIMEOUT` when `timeoutMs`
 * elapses, and with the spawn error itself (e.g. `code: 'ENOENT'`) when the program cannot start.
 */
export type ExecFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>

const MAX_BUFFER = 64 * 1024 * 1024

/** What execFile passes to its callback (its own ExecFileException type is not an Error subtype). */
type ExecError = Error & { code?: string | number | null; killed?: boolean }

export const exec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs ?? 0,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
      },
      (error: ExecError | null, stdout: string, stderr: string) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        // A string code is a failure to run at all (ENOENT, EACCES, output over maxBuffer…).
        if (typeof error.code === 'string') return reject(error)
        if (error.killed && opts.timeoutMs) {
          const detail = `${opts.timeoutMs} ms`
          return reject(new AppError('PROCESS_TIMEOUT', { command: basename(cmd) }, { detail, cause: error }))
        }
        // A numeric code is the exit code; none means the process died from a signal.
        resolve({ code: typeof error.code === 'number' ? error.code : null, stdout, stderr })
      },
    )
  })
