import { readCapped } from '@main/core/system/http'

const KB = 1024
const CAP = 4 * KB

/** A body that never ends: 1 KB per pull. */
function endless(): { body: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0
  let cancelled = false
  const chunk = new Uint8Array(KB).fill(7)
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { body, pulled: () => pulled, cancelled: () => cancelled }
}

describe('readCapped', () => {
  it('returns the whole body when it fits, whatever the chunks', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    expect(await readCapped(new Response(body), CAP)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))
    expect(await readCapped(new Response(''), CAP)).toEqual(Buffer.alloc(0))
  })

  it('takes a body of exactly the cap and refuses one byte more', async () => {
    expect(await readCapped(new Response(Buffer.alloc(CAP)), CAP)).toHaveLength(CAP)
    await expect(readCapped(new Response(Buffer.alloc(CAP + 1)), CAP)).rejects.toThrow('over the size limit')
  })

  it('stops reading an endless body at the cap and cancels it', async () => {
    const stream = endless()
    await expect(readCapped(new Response(stream.body), CAP)).rejects.toThrow('over the size limit')
    // The fifth kilobyte is the one that crosses the cap.
    expect(stream.pulled()).toBe(5)
    expect(stream.cancelled()).toBe(true)
  })

  it('refuses a declared size over the cap before reading a byte', async () => {
    const stream = endless()
    const res = new Response(stream.body, { headers: { 'content-length': String(CAP + 1) } })
    await expect(readCapped(res, CAP)).rejects.toThrow(`${CAP + 1} bytes declared`)
    expect(stream.pulled()).toBe(0)
    expect(stream.cancelled()).toBe(true)
  })

  it('trusts no declared size: a small content-length does not lift the cap', async () => {
    const stream = endless()
    const res = new Response(stream.body, { headers: { 'content-length': '100' } })
    await expect(readCapped(res, CAP)).rejects.toThrow('over the size limit')
    expect(stream.pulled()).toBe(5)
    expect(stream.cancelled()).toBe(true)
  })

  it('fails on an answer with no body', async () => {
    await expect(readCapped(new Response(null), CAP)).rejects.toThrow('no body')
  })
})
