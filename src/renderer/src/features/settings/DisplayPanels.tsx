// Preferences saved in the app config: language, 18+ worlds and the player name, then the effects.
import {
  IconDeviceTvOld,
  IconInfoCircle,
  IconRating18Plus,
  IconSparkles,
  IconVolume,
  IconWaveSine,
} from '@tabler/icons-react'
import { useId, useState, type ReactNode } from 'react'
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

/** Archipelago's slot name limit (the main process refuses longer names). */
const MAX_PLAYER_NAME = 16

const EFFECTS: readonly { key: Effect; icon: ReactNode; tone: Tone }[] = [
  { key: 'crt', icon: <IconDeviceTvOld />, tone: 'cyan' },
  { key: 'glow', icon: <IconSparkles />, tone: 'violet' },
  { key: 'animations', icon: <IconWaveSine />, tone: 'yellow' },
  { key: 'sounds', icon: <IconVolume />, tone: 'green' },
]

/**
 * The name given to the YAML files the app creates. It is saved when the field is left or on Enter,
 * not at each keystroke: the saved name is trimmed, and a name typed with a space in it must not be
 * rewritten under the cursor.
 */
function PlayerNameField(): React.JSX.Element {
  const { t } = useTranslation()
  const config = useConfig()
  const patch = useConfigPatch()
  const fieldId = useId()
  // What is being typed; null while the field shows the saved name (a refused change shows it again).
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    if (draft === null) return
    const playerName = draft.trim()
    setDraft(null)
    if (playerName !== config.playerName) patch({ playerName })
  }

  return (
    <div className="settings-field">
      <label htmlFor={fieldId} className="field__label">
        {t('screens.settings.display.playerName')}
      </label>
      <div className="input-frame pixel-border tone-violet">
        <input
          id={fieldId}
          className="input"
          value={draft ?? config.playerName}
          maxLength={MAX_PLAYER_NAME}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${fieldId}-hint`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
        />
      </div>
      <span id={`${fieldId}-hint`} className="field__hint">
        {t('screens.settings.display.playerNameHint')}
      </span>
    </div>
  )
}

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
        <PlayerNameField />
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
