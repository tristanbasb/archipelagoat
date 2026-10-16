import { consoleSink, createLogger, formatLogEntry, type LogEntry } from '@main/core/logger'

describe('logger', () => {
  it('sends each entry to every sink with its level and a timestamp', () => {
    const entries: LogEntry[] = []
    const log = createLogger([(entry) => void entries.push(entry)])
    log.debug('d')
    log.info('i', { a: 1 })
    log.warn('w')
    log.error('e', new Error('x'))
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ['debug', 'd'],
      ['info', 'i'],
      ['warn', 'w'],
      ['error', 'e'],
    ])
    expect(entries[1]?.data).toEqual({ a: 1 })
    expect(Date.parse(entries[0]?.ts ?? '')).not.toBeNaN()
  })

  it('a failing sink does not break logging nor the other sinks', () => {
    const seen = vi.fn()
    const log = createLogger([
      () => {
        throw new Error('disk full')
      },
      seen,
    ])
    expect(() => log.info('still logged')).not.toThrow()
    expect(seen).toHaveBeenCalledOnce()
  })

  it('formats one line per entry with the data as JSON or the error stack', () => {
    const ts = '2026-10-16T10:00:00.000Z'
    expect(formatLogEntry({ ts, level: 'info', message: 'hello' })).toBe(`${ts} INFO hello`)
    expect(formatLogEntry({ ts, level: 'warn', message: 'm', data: { port: 38281 } })).toBe(
      `${ts} WARN m {"port":38281}`,
    )
    const error = new Error('boom')
    expect(formatLogEntry({ ts, level: 'error', message: 'm', data: error })).toContain('Error: boom')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatLogEntry({ ts, level: 'debug', message: 'm', data: circular })).toBe(
      `${ts} DEBUG m [unserializable]`,
    )
  })

  it('consoleSink writes errors to console.error and the rest to console.log', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      consoleSink({ ts: 't', level: 'error', message: 'bad' })
      consoleSink({ ts: 't', level: 'info', message: 'fine' })
      expect(error).toHaveBeenCalledExactlyOnceWith('t ERROR bad')
      expect(info).toHaveBeenCalledExactlyOnceWith('t INFO fine')
    } finally {
      error.mockRestore()
      info.mockRestore()
    }
  })
})
