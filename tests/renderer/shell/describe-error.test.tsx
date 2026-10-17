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

  describe('WORLD_CORRUPT_BLOCKING', () => {
    it('names the corrupt world file in French when the error carries it', () => {
      const described = describeError({ code: 'WORLD_CORRUPT_BLOCKING', params: { file: 'broken.apworld' } })
      expect(described.title).toBe('Le monde cassé broken.apworld bloque Archipelago')
      expect(described.body).toContain('broken.apworld')
      expect(described.action).toEqual({ labelKey: 'errors.actions.worlds', to: '/worlds' })
    })

    it('names the corrupt world file in English when the error carries it', async () => {
      await i18n.changeLanguage('en')
      const described = describeError({ code: 'WORLD_CORRUPT_BLOCKING', params: { file: 'broken.apworld' } })
      expect(described.title).toBe('The broken world broken.apworld is blocking Archipelago')
      expect(described.body).toContain('broken.apworld')
    })

    it.each(['fr', 'en'] as const)('keeps the generic text without a file (%s)', async (lang) => {
      await i18n.changeLanguage(lang)
      const generic = describeError({ code: 'WORLD_CORRUPT_BLOCKING' })
      expect(generic.title).toBe(i18n.t('errors.WORLD_CORRUPT_BLOCKING'))
      for (const params of [{}, { file: '' }]) {
        const described = describeError({ code: 'WORLD_CORRUPT_BLOCKING', params })
        expect(described.title).toBe(generic.title)
        expect(described.body).toBe(generic.body)
      }
      for (const text of [generic.title, generic.body]) {
        expect(text).not.toContain('…')
        expect(text).not.toContain('{{')
        expect(text).not.toContain('apworld')
      }
    })

    it('leaves an error whose file has no dedicated text as it is', () => {
      const described = describeError({ code: 'NOT_FOUND', params: { file: 'EmuHawk.exe' } })
      expect(described.title).toBe(i18n.t('errors.NOT_FOUND'))
      expect(described.body).toBe(i18n.t('errors.help.NOT_FOUND'))
    })
  })
})
