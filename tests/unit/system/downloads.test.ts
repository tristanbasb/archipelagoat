import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { download } from '@main/core/system/downloads'
import { createHttp } from '@main/core/system/http'
import { AppError } from '@shared/errors'
import { dropConnection, reply, startTestServer, type TestServer } from '../../helpers/http-server'
import { silentLogger } from '../../helpers/core'

// The final rename can be made to fail, as an antivirus scan holding a fresh file does on Windows.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

/** Not compressible and not periodic: a wrong byte or a missing chunk changes the hash. */
const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31 + (i >> 8) * 7 + 5) % 251))
const sha256 = createHash('sha256').update(payload).digest('hex')

let root: string
let dir: string
let server: TestServer

const http = (): ReturnType<typeof createHttp> =>
  createHttp({
    userAgent: 'Test/1.0 (unit)',
    cacheDir: join(root, 'cache'),
    log: silentLogger,
    githubToken: () => null,
  })

/** Serves `payload` at /file, a redirect to it at /redirect, and a 404 everywhere else. */
function serveFile(): void {
  server.handle((req, res) => {
    if (req.url === '/file') return reply(res, 200, payload)
    if (req.url === '/redirect') return reply(res, 302, '', { location: '/file' })
    reply(res, 404, 'nope')
  })
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat dl é-'))
  dir = join(root, 'downloads')
  mkdirSync(dir)
  server = await startTestServer((_req, res) => reply(res, 404))
})

afterEach(async () => {
  vi.mocked(rename).mockReset() // back to the real rename, and no call history
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('download', () => {
  it('verifies the sha256 and renames the .part file to the destination', async () => {
    serveFile()
    const dest = join(dir, 'Setup é.exe')
    const result = await download(http(), {
      url: `${server.url}/file`,
      dest,
      sha256,
      expectedSize: payload.length,
    })

    expect(result).toEqual({ path: dest, sha256 })
    expect(readFileSync(dest).equals(payload)).toBe(true)
    expect(readdirSync(dir)).toEqual(['Setup é.exe'])
  })

  it('writes to dest.part while it downloads', async () => {
    server.handle((_req, res) => {
      res.writeHead(200, { 'content-length': payload.length })
      res.write(payload.subarray(0, 1000))
      setTimeout(() => res.end(payload.subarray(1000)), 300)
    })
    const dest = join(dir, 'file.bin')
    const pending = download(http(), { url: `${server.url}/file`, dest, sha256 })
    await vi.waitFor(() => expect(existsSync(`${dest}.part`)).toBe(true))
    expect(existsSync(dest)).toBe(false)
    await pending
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(existsSync(dest)).toBe(true)
  })

  it('accepts an upper-case expected hash and creates the missing folders', async () => {
    serveFile()
    const dest = join(dir, 'a', 'b', 'file.bin')
    const result = await download(http(), { url: `${server.url}/file`, dest, sha256: sha256.toUpperCase() })
    expect(result).toEqual({ path: dest, sha256 })
  })

  it('follows redirects, like a GitHub release asset does', async () => {
    serveFile()
    const dest = join(dir, 'file.bin')
    await download(http(), { url: `${server.url}/redirect`, dest, sha256 })
    expect(readFileSync(dest).equals(payload)).toBe(true)
  })

  it('returns the computed hash when no digest is known (sha256: null)', async () => {
    serveFile()
    const dest = join(dir, 'file.bin')
    const result = await download(http(), { url: `${server.url}/file`, dest, sha256: null })
    expect(result).toEqual({ path: dest, sha256 })
    expect(existsSync(dest)).toBe(true)
  })

  it('replaces an existing destination only once the new file is verified', async () => {
    serveFile()
    const dest = join(dir, 'file.bin')
    writeFileSync(dest, 'old content')

    const error = await failure(download(http(), { url: `${server.url}/file`, dest, sha256: 'a'.repeat(64) }))
    expect(error.code).toBe('DOWNLOAD_HASH_MISMATCH')
    expect(readFileSync(dest, 'utf8')).toBe('old content')

    await download(http(), { url: `${server.url}/file`, dest, sha256 })
    expect(readFileSync(dest).equals(payload)).toBe(true)
  })

  it('retries the final rename while something holds the file', async () => {
    serveFile()
    const held = Object.assign(new Error('held by the antivirus'), { code: 'EPERM' })
    vi.mocked(rename).mockRejectedValueOnce(held).mockRejectedValueOnce(held)
    const dest = join(dir, 'Setup.exe')

    await download(http(), { url: `${server.url}/file`, dest, sha256 })
    expect(rename).toHaveBeenCalledTimes(3)
    expect(readdirSync(dir)).toEqual(['Setup.exe'])
  })

  it('throws any other rename error at once and removes the .part file', async () => {
    serveFile()
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('no space'), { code: 'ENOSPC' }))

    await expect(
      download(http(), { url: `${server.url}/file`, dest: join(dir, 'f.bin'), sha256 }),
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(rename).toHaveBeenCalledTimes(1)
    expect(readdirSync(dir)).toEqual([])
  })

  it('deletes the file and throws DOWNLOAD_HASH_MISMATCH on a bad hash', async () => {
    serveFile()
    const dest = join(dir, 'file.bin')
    const expected = 'b'.repeat(64)
    const error = await failure(download(http(), { url: `${server.url}/file`, dest, sha256: expected }))

    expect(error.code).toBe('DOWNLOAD_HASH_MISMATCH')
    expect(error.params).toEqual({ expected, actual: sha256 })
    expect(readdirSync(dir)).toEqual([])
  })

  it('treats a size that is not the expected one as a mismatch, before the hash', async () => {
    serveFile()
    const dest = join(dir, 'file.bin')
    const error = await failure(
      download(http(), { url: `${server.url}/file`, dest, sha256: null, expectedSize: payload.length + 1 }),
    )
    expect(error.code).toBe('DOWNLOAD_HASH_MISMATCH')
    expect(error.params).toEqual({ expectedSize: payload.length + 1, actualSize: payload.length })
    expect(readdirSync(dir)).toEqual([])
  })

  it('rejects a malformed expected hash without sending a request', async () => {
    const dest = join(dir, 'file.bin')
    for (const bad of ['', 'abc', 'z'.repeat(64), `sha256:${sha256}`]) {
      const error = await failure(download(http(), { url: `${server.url}/file`, dest, sha256: bad }))
      expect(error.code).toBe('INVALID_INPUT')
    }
    expect(server.requests).toHaveLength(0)
  })

  it('reports progress: bytes received, the total and a speed', async () => {
    const parts = [
      payload.subarray(0, 100_000),
      payload.subarray(100_000, 200_000),
      payload.subarray(200_000),
    ]
    server.handle(async (_req, res) => {
      res.writeHead(200, { 'content-length': payload.length })
      for (const part of parts) {
        res.write(part)
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      res.end()
    })
    const progress: { received: number; total: number | null; bytesPerSec: number }[] = []
    await download(http(), {
      url: `${server.url}/file`,
      dest: join(dir, 'file.bin'),
      sha256,
      onProgress: (p) => progress.push(p),
    })

    expect(progress.length).toBeGreaterThan(1)
    const received = progress.map((p) => p.received)
    expect(received).toEqual([...received].sort((a, b) => a - b))
    expect(received.at(-1)).toBe(payload.length)
    expect(progress.every((p) => p.total === payload.length)).toBe(true)
    expect(progress.every((p) => Number.isFinite(p.bytesPerSec) && p.bytesPerSec >= 0)).toBe(true)
    expect(progress.at(-1)?.bytesPerSec).toBeGreaterThan(0)
  })

  it('reports an unknown total as null, or as the expected size when it is given', async () => {
    server.handle((_req, res) => {
      res.writeHead(200) // no Content-Length: chunked
      res.end(payload)
    })
    const totals: (number | null)[] = []
    await download(http(), {
      url: `${server.url}/file`,
      dest: join(dir, 'a.bin'),
      sha256,
      onProgress: (p) => totals.push(p.total),
    })
    expect(totals.length).toBeGreaterThan(0)
    expect(new Set(totals)).toEqual(new Set([null]))

    const sized: (number | null)[] = []
    await download(http(), {
      url: `${server.url}/file`,
      dest: join(dir, 'b.bin'),
      sha256,
      expectedSize: payload.length,
      onProgress: (p) => sized.push(p.total),
    })
    expect(new Set(sized)).toEqual(new Set([payload.length]))
  })

  it('aborts on the signal and removes the .part file', async () => {
    server.handle((_req, res) => {
      res.writeHead(200, { 'content-length': payload.length })
      res.write(payload.subarray(0, 50_000)) // then the server stalls
    })
    const controller = new AbortController()
    const dest = join(dir, 'file.bin')
    const pending = failure(
      download(http(), {
        url: `${server.url}/file`,
        dest,
        sha256,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.received > 0) controller.abort()
        },
      }),
    )

    expect((await pending).code).toBe('TASK_CANCELLED')
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not send a request when the signal is already aborted', async () => {
    const error = await failure(
      download(http(), {
        url: `${server.url}/file`,
        dest: join(dir, 'file.bin'),
        sha256: null,
        signal: AbortSignal.abort(),
      }),
    )
    expect(error.code).toBe('TASK_CANCELLED')
    expect(server.requests).toHaveLength(0)
    expect(readdirSync(dir)).toEqual([])
  })

  it('aborts while the response is still awaited', async () => {
    server.handle(() => undefined) // never answers
    const controller = new AbortController()
    const pending = failure(
      download(http(), {
        url: `${server.url}/file`,
        dest: join(dir, 'f.bin'),
        sha256: null,
        signal: controller.signal,
      }),
    )
    setTimeout(() => controller.abort(), 50)
    expect((await pending).code).toBe('TASK_CANCELLED')
    expect(readdirSync(dir)).toEqual([])
  })

  it('maps an HTTP error to HTTP_ERROR and leaves nothing behind', async () => {
    serveFile()
    const dest = join(dir, 'file.bin')
    const error = await failure(download(http(), { url: `${server.url}/missing`, dest, sha256 }))
    expect(error.code).toBe('HTTP_ERROR')
    expect(error.params).toEqual({ status: 404, url: `${server.url}/missing` })
    expect(readdirSync(dir)).toEqual([])
  })

  it('maps a connection that drops mid-download to NETWORK_OFFLINE and removes the .part file', async () => {
    server.handle((req, res) => {
      res.writeHead(200, { 'content-length': payload.length })
      res.write(payload.subarray(0, 10_000), () => setTimeout(() => req.socket.destroy(), 30))
    })
    const error = await failure(
      download(http(), { url: `${server.url}/file`, dest: join(dir, 'f.bin'), sha256 }),
    )
    expect(error.code).toBe('NETWORK_OFFLINE')
    expect(readdirSync(dir)).toEqual([])
  })

  it('maps a server that is not reachable to NETWORK_OFFLINE', async () => {
    server.handle(dropConnection)
    const error = await failure(
      download(http(), { url: `${server.url}/file`, dest: join(dir, 'f.bin'), sha256 }),
    )
    expect(error.code).toBe('NETWORK_OFFLINE')
    expect(readdirSync(dir)).toEqual([])
  })

  it('downloads an empty file', async () => {
    server.handle((_req, res) => reply(res, 200, ''))
    const emptyHash = createHash('sha256').digest('hex')
    const dest = join(dir, 'empty.bin')
    expect(await download(http(), { url: `${server.url}/e`, dest, sha256: emptyHash })).toEqual({
      path: dest,
      sha256: emptyHash,
    })
    expect(readFileSync(dest)).toHaveLength(0)
  })
})
