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

  describe('texts chosen by the params', () => {
    it('quotes the message archipelago.gg gave for a refused upload', async () => {
      const message = 'Could not load multidata. File may be corrupted or incompatible.'
      const described = describeError({ code: 'WEBHOST_UPLOAD_FAILED', params: { message } })
      expect(described.title).toBe('L’envoi vers archipelago.gg a échoué')
      expect(described.body).toContain(`«\u00a0${message}\u00a0»`)
      await i18n.changeLanguage('en')
      expect(describeError({ code: 'WEBHOST_UPLOAD_FAILED', params: { message } }).body).toContain(
        `“${message}”`,
      )
    })

    it.each(['fr', 'en'] as const)(
      'says a seed too big for archipelago.gg is hosted locally (%s)',
      async (lang) => {
        await i18n.changeLanguage(lang)
        const generic = describeError({ code: 'WEBHOST_UPLOAD_FAILED' })
        const described = describeError({ code: 'WEBHOST_UPLOAD_FAILED', params: { reason: 'too-large' } })
        expect(described.title).not.toBe(generic.title)
        expect(described.body).not.toBe(generic.body)
        expect(described.title).toBe(
          lang === 'fr' ? 'Partie trop lourde pour archipelago.gg' : 'The game is too big for archipelago.gg',
        )
        expect(described.body).toMatch(lang === 'fr' ? /héberge-la en local/ : /host it locally/)
      },
    )

    it('asks to stop the local server before generating again, not to go back to the check', async () => {
      const described = describeError({ code: 'GENERATION_PREFLIGHT', params: { reason: 'hosting' } })
      expect(described.title).toBe('Le serveur local de la partie tourne')
      expect(described.body).toMatch(/Arrête le serveur local/)
      expect(described.body).not.toMatch(/Vérification/)
      // The check failures keep their own text.
      const checks = describeError({ code: 'GENERATION_PREFLIGHT', params: { errors: 2 } })
      expect(checks.body).toMatch(/étape Vérification/)
      await i18n.changeLanguage('en')
      expect(describeError({ code: 'GENERATION_PREFLIGHT', params: { reason: 'hosting' } })).toMatchObject({
        title: 'The game’s local server is running',
        body: expect.stringMatching(/^Stop the local server/) as string,
      })
    })

    it('asks to stop the local server before hosting on archipelago.gg', async () => {
      const described = describeError({ code: 'AP_RUNNING', params: { reason: 'local-server' } })
      expect(described.title).toBe('Le serveur local de la partie tourne')
      expect(described.body).toMatch(/^Arrête d’abord le serveur local/)
      await i18n.changeLanguage('en')
      expect(describeError({ code: 'AP_RUNNING', params: { reason: 'local-server' } }).body).toMatch(
        /^Stop the local server first/,
      )
      // Any other AP_RUNNING keeps its text about the open programs.
      expect(describeError({ code: 'AP_RUNNING' }).body).toMatch(/^Close the open Archipelago programs/)
    })

    it('tells a server that crashed while running from one that never started', async () => {
      expect(describeError({ code: 'SERVER_START_FAILED', params: { phase: 'running' } }).title).toBe(
        'Le serveur s’est arrêté de façon inattendue',
      )
      expect(describeError({ code: 'SERVER_START_FAILED' }).title).toBe('Le serveur n’a pas pu démarrer')
      await i18n.changeLanguage('en')
      expect(describeError({ code: 'SERVER_START_FAILED', params: { phase: 'running' } }).title).toBe(
        'The server stopped unexpectedly',
      )
    })

    it.each(['fr', 'en'] as const)('names the programs that lock the settings (%s)', async (lang) => {
      await i18n.changeLanguage(lang)
      const processes = 'ArchipelagoLauncher.exe, ArchipelagoBizHawkClient.exe'
      const described = describeError({ code: 'SETTINGS_LOCKED', params: { processes } })
      expect(described.title).toBe(i18n.t('errors.SETTINGS_LOCKED'))
      expect(described.body).toContain(processes)
      // Without the list, the generic text stays (never a raw placeholder).
      const generic = describeError({ code: 'SETTINGS_LOCKED' })
      expect(generic.body).toBe(i18n.t('errors.help.SETTINGS_LOCKED'))
      expect(generic.body).not.toContain('{{')
    })

    it.each(['fr', 'en'] as const)(
      'says why a world only the wiki lists cannot be installed, with the page to get it from (%s)',
      async (lang) => {
        await i18n.changeLanguage(lang)
        const url = 'https://github.com/owner/repo/releases?q=Game&expanded=true'
        const texts = new Set<string>()
        for (const reason of ['no-release', 'no-apworld', 'ambiguous']) {
          const described = describeError({ code: 'WORLD_RELEASE_UNAVAILABLE', params: { reason, url } })
          expect(described.title).toBe(i18n.t(`errors.WORLD_RELEASE_UNAVAILABLE_${reason}`))
          // The link keeps its & as it is: the texts are not HTML.
          expect(described.body).toContain(url)
          expect(described.action).toEqual({ labelKey: 'errors.actions.worlds', to: '/worlds' })
          texts.add(described.title).add(described.body)
        }
        expect(texts.size).toBe(6)
        expect(describeError({ code: 'WORLD_RELEASE_UNAVAILABLE', params: { url } }).body).toContain(url)
      },
    )

    it('keeps the plain text for a reason or a phase with no text of its own', () => {
      for (const params of [{ reason: 'traversal' }, { phase: 'late' }, { reason: 'a.b:c' }]) {
        const described = describeError({ code: 'PATH_FORBIDDEN', params })
        expect(described.title).toBe(i18n.t('errors.PATH_FORBIDDEN'))
        expect(described.body).toBe(i18n.t('errors.help.PATH_FORBIDDEN'))
      }
    })
  })
})
