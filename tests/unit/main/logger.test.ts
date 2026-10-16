import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  consoleSink,
  createFileLogger,
  createFileSink,
  createLogger,
  FILE_LOG_MAX_BYTES,
  FILE_LOG_MAX_FILES,
  FILE_LOG_NAME,
  formatLogEntry,
  type LogEntry,
} from '@main/core/logger'

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

describe('logger redaction', () => {
  const ts = '2026-10-16T10:00:00.000Z'

  it('masks secrets in the message and in the data of a formatted line', () => {
    expect(
      formatLogEntry({ ts, level: 'info', message: 'Hosting game at 1.2.3.4:38281 (Password: hunter2)' }),
    ).toBe(`${ts} INFO Hosting game at 1.2.3.4:38281 (Password: •••)`)
    expect(
      formatLogEntry({ ts, level: 'warn', message: 'sent', data: { server_password: 'adm1n', port: 1 } }),
    ).toBe(`${ts} WARN sent {"server_password":"•••","port":1}`)
    const error = new Error('connect to archipelago://Bob:s3cr3t@host:1 failed')
    const line = formatLogEntry({ ts, level: 'error', message: 'fatal: uncaughtException', data: error })
    expect(line).toContain('archipelago://Bob:•••@host:1')
    expect(line).not.toContain('s3cr3t')
  })

  it('consoleSink, hence the logger of the crash handlers, prints masked lines only', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      createLogger([consoleSink]).error(
        'fatal: unhandledRejection',
        new Error('Option password is set to hunter2'),
      )
      expect(error).toHaveBeenCalledOnce()
      const printed = String(error.mock.calls[0]?.[0])
      expect(printed).toContain('Option password is set to •••')
      expect(printed).not.toContain('hunter2')
    } finally {
      error.mockRestore()
    }
  })

  it('hands sinks the entry as logged: masking happens when a line is written', () => {
    const entries: LogEntry[] = []
    createLogger([(entry) => void entries.push(entry)]).info('password: hunter2', { password: 'hunter2' })
    expect(entries[0]).toMatchObject({ message: 'password: hunter2', data: { password: 'hunter2' } })
  })
})

describe('file sink', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goat log é-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const entry = (message: string): LogEntry => ({ ts: 't', level: 'info', message })
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8')

  it('rotates over 5 files of 5 MiB by default', () => {
    expect([FILE_LOG_MAX_FILES, FILE_LOG_MAX_BYTES]).toEqual([5, 5 * 1024 * 1024])
  })

  it('creates the folder on the first line and writes one masked line per entry', () => {
    const logs = join(dir, 'nested', 'logs')
    const log = createFileLogger(logs)
    expect(existsSync(logs)).toBe(false)
    log.info('Hosting game at 1.2.3.4:38281 (Password: hunter2)')
    log.error('boom é', new Error('line one\nline two'))
    const text = readFileSync(join(logs, FILE_LOG_NAME), 'utf8')
    const lines = text.split('\n')
    expect(lines[0]).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO Hosting game at 1\.2\.3\.4:38281 \(Password: •••\)$/,
    )
    expect(text).not.toContain('hunter2')
    expect(text).toContain('ERROR boom é Error: line one\nline two')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('rotates by size, keeps the newest files and drops the oldest', () => {
    const sink = createFileSink(dir, { maxBytes: 300, maxFiles: 3 })
    const lines = Array.from(
      { length: 14 },
      (_, i) => `t INFO line ${String(i).padStart(2, '0')} ${'x'.repeat(60)}`,
    )
    for (const [i] of lines.entries()) sink(entry(`line ${String(i).padStart(2, '0')} ${'x'.repeat(60)}`))

    expect(readdirSync(dir).sort()).toEqual(['archipelagoat.1.log', 'archipelagoat.2.log', FILE_LOG_NAME])
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(300)
    const kept = [read('archipelagoat.2.log'), read('archipelagoat.1.log'), read(FILE_LOG_NAME)]
      .join('')
      .split('\n')
      .filter(Boolean)
    expect(kept.length).toBeGreaterThanOrEqual(6)
    expect(kept.length).toBeLessThan(lines.length)
    expect(kept).toEqual(lines.slice(lines.length - kept.length))
  })

  it('continues the file of a previous run, and rotates it when it is full', () => {
    const first = createFileSink(dir, { maxBytes: 300, maxFiles: 3 })
    first(entry('a'.repeat(200)))
    const second = createFileSink(dir, { maxBytes: 300, maxFiles: 3 })
    second(entry('b'.repeat(50)))
    expect(read(FILE_LOG_NAME)).toBe(`t INFO ${'a'.repeat(200)}\nt INFO ${'b'.repeat(50)}\n`)
    second(entry('c'.repeat(50)))
    expect(read('archipelagoat.1.log')).toBe(`t INFO ${'a'.repeat(200)}\nt INFO ${'b'.repeat(50)}\n`)
    expect(read(FILE_LOG_NAME)).toBe(`t INFO ${'c'.repeat(50)}\n`)
  })

  it('writes a line bigger than the limit on its own instead of dropping it', () => {
    const sink = createFileSink(dir, { maxBytes: 100, maxFiles: 2 })
    sink(entry('small'))
    sink(entry('y'.repeat(500)))
    expect(read(FILE_LOG_NAME)).toBe(`t INFO ${'y'.repeat(500)}\n`)
    expect(read('archipelagoat.1.log')).toBe('t INFO small\n')
  })

  it('counts bytes, not characters', () => {
    const sink = createFileSink(dir, { maxBytes: 100, maxFiles: 2 })
    sink(entry('é'.repeat(40))) // 80 bytes + prefix: close to the limit
    sink(entry('é'.repeat(40)))
    expect(existsSync(join(dir, 'archipelagoat.1.log'))).toBe(true)
  })

  it('never lets a broken folder take the app down', () => {
    const blocker = join(dir, 'file-not-folder')
    writeFileSync(blocker, '')
    expect(() => createFileLogger(blocker).info('still fine')).not.toThrow()
    expect(() => createFileSink(blocker)(entry('x'))).toThrow()
  })
})
