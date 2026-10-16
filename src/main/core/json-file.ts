// Small synchronous JSON files of the main process (config.json, secrets.bin): tolerant reads and
// atomic writes (temporary file, then rename), so a crash never leaves a half-written file.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Parsed content, or undefined when the file is missing or is not valid JSON. */
export function readJsonSync(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 20

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function writeJsonAtomicSync(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (error) {
      // On Windows an antivirus scan can hold the fresh file for a moment (EPERM / EBUSY).
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < RENAME_ATTEMPTS && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleepSync(RENAME_RETRY_MS)
        continue
      }
      rmSync(tmp, { force: true })
      throw error
    }
  }
}
