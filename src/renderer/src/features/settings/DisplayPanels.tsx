// Appearance preferences, saved in the app config: language and 18+ worlds, then the effects.
import {
  IconDeviceTvOld,
  IconInfoCircle,
  IconRating18Plus,
  IconSparkles,
  IconVolume,
  IconWaveSine,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfig } from '@shared/types'
import type { Tone } from '../../design/classes'
import { PixelPanel, Segmented, Toggle, type SegmentedOption } from '../../design/components'
import { useEffectsPrefs } from '../../design/useEffectsPrefs'
import { resolveLanguage } from '../../i18n'
import { useConfig } from '../../stores/config'
import { useConfigPatch } from './feedback'
import { SettingRow } from './parts'

type Effect = keyof AppConfig['effects']

const EFFECTS: readonly { key: Effect; icon: ReactNode; tone: Tone }[] = [
  { key: 'crt', icon: <IconDeviceTvOld />, tone: 'cyan' },
  { key: 'glow', icon: <IconSparkles />, tone: 'violet' },
  { key: 'animations', icon: <IconWaveSine />, tone: 'yellow' },
  { key: 'sounds', icon: <IconVolume />, tone: 'green' },
]

export function DisplayPanel({ locale }: { locale: string }): React.JSX.Element {
  const { t } = useTranslation()
  const config = useConfig()
  const patch = useConfigPatch()
  const k = (key: string): string => t(`screens.settings.display.${key}`)
  const languages: SegmentedOption<AppConfig['language']>[] = [
    { value: 'auto', label: k('auto') },
    { value: 'fr', label: k('names.fr') },
    { value: 'en', label: k('names.en') },
  ]
  const systemLanguage = t(`languages.${resolveLanguage('auto', locale)}`)

  return (
    <PixelPanel eyebrow={k('eyebrow')} title={k('title')} tone="violet">
      <div className="settings-stack">
        <div className="settings-field">
          {/* The radio group is named by aria-label: this visible copy is not read twice. */}
          <span className="field__label" aria-hidden="true">
            {k('language')}
          </span>
          <Segmented
            options={languages}
            value={config.language}
            onChange={(language) => patch({ language })}
            label={k('language')}
          />
          <span className="field__hint">
            {t('screens.settings.display.languageHint', { language: systemLanguage })}
          </span>
        </div>
        <SettingRow icon={<IconRating18Plus />} tone="pink">
          <Toggle
            label={k('afterDark')}
            description={k('afterDarkHint')}
            checked={config.showAfterDark}
            tone="pink"
            onChange={(showAfterDark) => patch({ showAfterDark })}
          />
        </SettingRow>
      </div>
    </PixelPanel>
  )
}

export function EffectsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const config = useConfig()
  const patch = useConfigPatch()
  const { reduced } = useEffectsPrefs()
  const k = (key: string): string => t(`screens.settings.effects.${key}`)

  return (
    <PixelPanel eyebrow={k('eyebrow')} title={k('title')} tone="cyan">
      <div className="settings-stack">
        {EFFECTS.map(({ key, icon, tone }) => (
          <SettingRow key={key} icon={icon} tone={tone}>
            <Toggle
              label={k(key)}
              description={k(`${key}Hint`)}
              checked={config.effects[key]}
              tone={tone}
              onChange={(on) => patch({ effects: { [key]: on } })}
            />
          </SettingRow>
        ))}
        {reduced && (
          <p className="settings-note tone-yellow">
            <IconInfoCircle aria-hidden="true" />
            <span>{k('reduced')}</span>
          </p>
        )}
      </div>
    </PixelPanel>
  )
}
