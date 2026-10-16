// Verified downloads. A file is streamed to `<dest>.part`, checked (size, then SHA-256), and only
// then renamed to `dest`: what is at `dest` is either the previous file or a complete, verified one.
// Downloaded files are untrusted data; running them (the installer, BizHawk) is the callers' business.
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ReadableStreamReadResult } from 'node:stream/web'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '@shared/errors'
import type { Http } from '../context'
import { sha256File } from './archive'
import { httpStatusError, toNetworkError } from './http'

export interface DownloadProgress {
  received: number
  /** Content-Length, else `expectedSize`, else null. */
  total: number | null
  /** Averaged over the last few seconds. */
  bytesPerSec: number
}

export interface DownloadOptions {
  url: string
  dest: string
  /**
   * The SHA-256 the file must have (hex). null says that no digest is known and that the caller
   * accepts an unverified file: the hash that was computed is returned either way.
   */
  sha256: string | null
  /** Rejects a file of another size (the only check there is when `sha256` is null). */
  expectedSize?: number
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
}

const SHA256_HEX = /^[0-9a-f]{64}$/i
const PROGRESS_INTERVAL_MS = 100
const SPEED_WINDOW_MS = 3000

// On Windows an antivirus scan can hold a fresh executable for a moment (EPERM / EBUSY / EACCES).
const RENAME_ATTEMPTS = 10
const RENAME_RETRY_MS = 50

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < RENAME_ATTEMPTS && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await sleep(RENAME_RETRY_MS * attempt)
        continue
      }
      throw error
    }
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AppError('TASK_CANCELLED')
}

/** Calls `onProgress` at most every 100 ms, and once more at the end; the speed is a rolling average. */
function createMeter(total: number | null, onProgress: ((p: DownloadProgress) => void) | undefined) {
  const samples = [{ at: performance.now(), received: 0 }]
  let lastReport = -Infinity
  const report = (received: number): void => {
    const now = performance.now()
    lastReport = now
    samples.push({ at: now, received })
    while (samples.length > 2 && now - (samples[1]?.at ?? now) >= SPEED_WINDOW_MS) samples.shift()
    const first = samples[0]
    const seconds = first ? (now - first.at) / 1000 : 0
    const bytesPerSec = first && seconds > 0 ? (received - first.received) / seconds : 0
    onProgress?.({ received, total, bytesPerSec })
  }
  return {
    chunk(received: number): void {
      if (performance.now() - lastReport >= PROGRESS_INTERVAL_MS) report(received)
    },
    done: report,
  }
}

/** Streams the response to `part` and returns the number of bytes written. */
async function writePart(http: Http, opts: DownloadOptions, part: string): Promise<number> {
  const { signal } = opts
  throwIfCancelled(signal)
  const res = await http.fetchRaw(opts.url, { signal })
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw httpStatusError(res, opts.url)
  }

  // With a Content-Encoding the length is the encoded one, which says nothing about the bytes we get.
  const length = res.headers.get('content-length')
  const announced = length !== null && !res.headers.has('content-encoding') ? Number(length) : NaN
  const meter = createMeter(
    Number.isFinite(announced) ? announced : (opts.expectedSize ?? null),
    opts.onProgress,
  )

  const reader = res.body?.getReader()
  let file: FileHandle | undefined
  let received = 0
  try {
    file = await open(part, 'w')
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array> | undefined
      try {
        chunk = await reader?.read()
      } catch (error) {
        throw toNetworkError(error, { signal })
      }
      if (!chunk || chunk.done) break
      throwIfCancelled(signal)
      await file.writeFile(chunk.value)
      received += chunk.value.byteLength
      meter.chunk(received)
    }
    meter.done(received)
    await file.sync()
  } catch (error) {
    await reader?.cancel().catch(() => undefined)
    throw error
  } finally {
    await file?.close()
  }
  return received
}

/**
 * Downloads `opts.url` to `opts.dest`. Throws `DOWNLOAD_HASH_MISMATCH` (`{ expected, actual }`, or
 * `{ expectedSize, actualSize }` for the size), `HTTP_ERROR`, `GITHUB_RATE_LIMITED`, `NETWORK_OFFLINE`
 * (also for a connection that drops half way) or `TASK_CANCELLED`; whatever happens, no `.part` file
 * is left behind and an existing `dest` is not touched.
 */
export async function download(http: Http, opts: DownloadOptions): Promise<{ path: string; sha256: string }> {
  if (opts.sha256 !== null && !SHA256_HEX.test(opts.sha256)) {
    throw new AppError('INVALID_INPUT', undefined, { detail: 'sha256 is not 64 hexadecimal characters' })
  }
  const expected = opts.sha256?.toLowerCase() ?? null
  const part = `${opts.dest}.part`
  try {
    await mkdir(dirname(opts.dest), { recursive: true })
    const size = await writePart(http, opts, part)
    if (opts.expectedSize !== undefined && size !== opts.expectedSize) {
      throw new AppError(
        'DOWNLOAD_HASH_MISMATCH',
        { expectedSize: opts.expectedSize, actualSize: size },
        { detail: 'size' },
      )
    }
    const actual = await sha256File(part)
    if (expected !== null && actual !== expected) {
      throw new AppError('DOWNLOAD_HASH_MISMATCH', { expected, actual }, { detail: 'sha256' })
    }
    throwIfCancelled(opts.signal)
    await renameOver(part, opts.dest)
    return { path: opts.dest, sha256: actual }
  } catch (error) {
    await rm(part, { force: true }).catch(() => undefined)
    throw error
  }
}
