import { GoatError } from '@shared/errors'
import { i18n } from '@renderer/i18n'
import { describeError } from '@renderer/lib/errors'
import { goatError } from '../goat-mock'

describe('describeError', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr')
  })

  it('reads the plain GoatError object the preload rejects with', () => {
    const bridged = goatError('AP_NOT_INSTALLED')
    expect(bridged instanceof Error).toBe(false)
    expect(bridged instanceof GoatError).toBe(true)
    const described = describeError(bridged)
    expect(described).toEqual({
      title: 'Archipelago n’est pas installé',
      body: described.body,
      action: { labelKey: 'errors.actions.install', to: '/install' },
    })
    expect(described.body).toMatch(/^Installe Archipelago 0\.6\.8/)
  })

  it('interpolates params and keeps the detail and log path', () => {
    const described = describeError({
      code: 'AP_WORLD_NOT_FOUND',
      params: { game: 'Pokemon Crystal', suggestion: 'Pokemon Red and Blue' },
      detail: 'No world found to handle game Pokemon Crystal.',
      logPath: 'C:\\logs\\Generate.txt',
    })
    expect(described.title).toBe('Aucun monde installé pour Pokemon Crystal')
    expect(described.action).toEqual({ labelKey: 'errors.actions.worlds', to: '/worlds' })
    expect(described.detail).toBe('No world found to handle game Pokemon Crystal.')
    expect(described.logPath).toBe('C:\\logs\\Generate.txt')
  })

  it('follows the language and falls back to AP_UNKNOWN for anything else', async () => {
    await i18n.changeLanguage('en')
    expect(describeError(new TypeError('x is undefined'))).toMatchObject({
      title: 'Unexpected error',
      detail: 'TypeError: x is undefined',
    })
    expect(describeError({ code: 'NOT_A_CODE' }).title).toBe('Unexpected error')
  })
})
