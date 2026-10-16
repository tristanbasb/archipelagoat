import { AppError, GoatError, isAppErrorData, isGoatError, toAppErrorData } from '@shared/errors'

describe('AppError', () => {
  it('message is the code, followed by the detail when present', () => {
    expect(new AppError('PATH_FORBIDDEN').message).toBe('PATH_FORBIDDEN')
    expect(new AppError('NOT_FOUND', undefined, { detail: 'C:\\x' }).message).toBe('NOT_FOUND: C:\\x')
    expect(() => {
      throw new AppError('PATH_FORBIDDEN', { reason: 'unc' })
    }).toThrow(/PATH_FORBIDDEN/)
  })

  it('toData keeps only the fields that are set', () => {
    expect(new AppError('TASK_CANCELLED').toData()).toEqual({ code: 'TASK_CANCELLED' })
    const full = new AppError('GENERATION_FAILED', { exitCode: 1 }, { detail: 'boom', logPath: '/l.txt' })
    expect(full.toData()).toStrictEqual({
      code: 'GENERATION_FAILED',
      params: { exitCode: 1 },
      detail: 'boom',
      logPath: '/l.txt',
    })
  })

  it('keeps the cause', () => {
    const cause = new Error('root')
    expect(new AppError('INSTALL_FAILED', undefined, { cause }).cause).toBe(cause)
  })
})

describe('isAppErrorData', () => {
  it('accepts known codes with well-typed fields only', () => {
    expect(isAppErrorData({ code: 'NOT_FOUND' })).toBe(true)
    expect(isAppErrorData({ code: 'NOT_FOUND', params: { a: 1, b: 'x' }, detail: 'd', logPath: 'p' })).toBe(
      true,
    )
    expect(isAppErrorData({ code: 'NOPE' })).toBe(false)
    expect(isAppErrorData({ code: 'NOT_FOUND', params: { a: {} } })).toBe(false)
    expect(isAppErrorData({ code: 'NOT_FOUND', detail: 3 })).toBe(false)
    expect(isAppErrorData(null)).toBe(false)
    expect(isAppErrorData('NOT_FOUND')).toBe(false)
  })
})

describe('toAppErrorData', () => {
  it('serializes an AppError', () => {
    expect(toAppErrorData(new AppError('PORT_IN_USE', { port: 38281 }))).toStrictEqual({
      code: 'PORT_IN_USE',
      params: { port: 38281 },
    })
  })

  it('keeps error data and drops unknown fields', () => {
    expect(toAppErrorData({ code: 'NOT_FOUND', detail: 'd', extra: true })).toStrictEqual({
      code: 'NOT_FOUND',
      detail: 'd',
    })
  })

  it('turns anything else into AP_UNKNOWN with the text as detail', () => {
    expect(toAppErrorData(new Error('boom'))).toEqual({ code: 'AP_UNKNOWN', detail: 'Error: boom' })
    expect(toAppErrorData('plain')).toEqual({ code: 'AP_UNKNOWN', detail: 'plain' })
    expect(toAppErrorData({ code: 'NOPE' })).toEqual({ code: 'AP_UNKNOWN', detail: '[object Object]' })
  })
})

describe('GoatError', () => {
  it('carries the error data', () => {
    const error = new GoatError({ code: 'ROM_MISSING', params: { game: 'A Link to the Past' }, detail: 'd' })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('GoatError')
    expect(error.message).toBe('ROM_MISSING: d')
    expect(error.code).toBe('ROM_MISSING')
    expect(error.params).toEqual({ game: 'A Link to the Past' })
    expect(toAppErrorData(error)).toStrictEqual({
      code: 'ROM_MISSING',
      params: { game: 'A Link to the Past' },
      detail: 'd',
    })
  })

  it('recognizes the plain object the preload sends across the context bridge', () => {
    const bridged: unknown = {
      name: 'GoatError',
      message: 'NOT_FOUND',
      code: 'NOT_FOUND',
      params: { id: 's' },
    }
    expect(bridged instanceof GoatError).toBe(true)
    expect(isGoatError(bridged)).toBe(true)
    expect(new GoatError({ code: 'NOT_FOUND' }) instanceof GoatError).toBe(true)
    expect(new AppError('NOT_FOUND') instanceof GoatError).toBe(false)
    expect(new Error('NOT_FOUND') instanceof GoatError).toBe(false)
    expect({ name: 'GoatError', code: 'NOPE' } instanceof GoatError).toBe(false)
  })
})
