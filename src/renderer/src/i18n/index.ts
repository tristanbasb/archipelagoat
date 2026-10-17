/// <reference types="vite/client" />
// i18next with every text bundled: the common files (fr.json / en.json) plus each screen's own
// files (features/<screen>/i18n.<lang>.json), merged under `screens.<screen>`. One namespace, so
// keys read `errors.<CODE>`, `nav.home`, `screens.worlds.title`…
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Lang } from '@shared/types'
import en from './en.json'
import fr from './fr.json'

type Texts = Record<string, unknown>

const screenFiles = import.meta.glob<{ default: Texts }>('../features/*/i18n.{fr,en}.json', { eager: true })

function screens(lang: Lang): Record<string, Texts> {
  const out: Record<string, Texts> = {}
  for (const [path, file] of Object.entries(screenFiles)) {
    const match = /features\/([^/]+)\/i18n\.(fr|en)\.json$/.exec(path)
    if (match?.[2] === lang && match[1]) out[match[1]] = file.default
  }
  return out
}

export const resources = {
  fr: { ...fr, screens: screens('fr') },
  en: { ...en, screens: screens('en') },
} satisfies Record<Lang, Texts>

/** `fr*` locales speak French, every other one English; an explicit setting wins. */
export function resolveLanguage(setting: Lang | 'auto', locale: string): Lang {
  if (setting !== 'auto') return setting
  return locale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

export const i18n = i18next.createInstance()

void i18n.use(initReactI18next).init({
  resources: { fr: { translation: resources.fr }, en: { translation: resources.en } },
  lng: 'fr',
  fallbackLng: 'en',
  initAsync: false,
  returnNull: false,
  // React escapes.
  interpolation: { escapeValue: false },
  // A missing parameter shows an ellipsis rather than a raw {{placeholder}}.
  missingInterpolationHandler: () => '…',
})
