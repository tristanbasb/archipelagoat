// What to start a player from: the ArchipelaGOAT profiles of the game (Découverte, Standard,
// Complet), then its own presets (Archipelago's option presets, from the local templates or the
// site) and the way back to the defaults, as rows of chips. Each one starts over from the defaults.
import { IconRestore, IconSparkles, IconWand } from '@tabler/icons-react'
import { useId } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { GameProfile } from '@shared/types'
import { Tooltip } from '../../design/components'
import './PresetMenu.css'

export interface PresetMenuProps {
  presets: readonly string[]
  /** The game's profiles, in order; none while they are not known (or the game has no schema). */
  profiles: readonly GameProfile[]
  /** `null`: the defaults. */
  onApply: (preset: string | null) => void
  onApplyProfile: (profile: GameProfile) => void
  className?: string
}

/** An option value as a change list reads it: text as it is, anything else as JSON. */
const valueText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

/** A profile's checks: "≈ 203 checks", a range "180–230 checks" for a YAML that rolls dice, or not measured. */
function checksText(profile: GameProfile, t: TFunction): string {
  if (profile.checks === null) return t('profiles.notMeasured')
  if (profile.range !== null) return t('profiles.range', { min: profile.range[0], max: profile.range[1] })
  return t('profiles.checks', { count: profile.checks })
}

function ProfileChip({
  profile,
  onApply,
}: {
  profile: GameProfile
  onApply: (profile: GameProfile) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Tooltip
      side="bottom"
      content={
        profile.changes.length === 0 ? (
          t('profiles.noChanges')
        ) : (
          <ul className="preset-changes">
            {profile.changes.map(({ key, from, to }) => (
              <li key={key}>{t('profiles.change', { key, from: valueText(from), to: valueText(to) })}</li>
            ))}
          </ul>
        )
      }
    >
      <button
        type="button"
        className="preset-chip"
        data-profile={profile.id}
        onClick={() => onApply(profile)}
      >
        {t(`profiles.names.${profile.id}`)}{' '}
        <span className="preset-chip__checks" data-measured={profile.checks !== null || undefined}>
          {checksText(profile, t)}
        </span>
      </button>
    </Tooltip>
  )
}

export function PresetMenu({
  presets,
  profiles,
  onApply,
  onApplyProfile,
  className,
}: PresetMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const profilesLabelId = useId()
  const presetsLabelId = useId()
  return (
    <div className={className ? `preset-menu ${className}` : 'preset-menu'}>
      {profiles.length > 0 && (
        <div role="group" aria-labelledby={profilesLabelId} className="preset-menu__row" data-kind="profiles">
          <span id={profilesLabelId} className="preset-menu__label">
            <IconSparkles aria-hidden="true" />
            {t('screens.studio.presets.profiles')}
          </span>
          <div className="preset-menu__chips">
            {profiles.map((profile) => (
              <ProfileChip key={profile.id} profile={profile} onApply={onApplyProfile} />
            ))}
          </div>
        </div>
      )}
      <div role="group" aria-labelledby={presetsLabelId} className="preset-menu__row">
        <span id={presetsLabelId} className="preset-menu__label">
          <IconWand aria-hidden="true" />
          {t('screens.studio.presets.label')}
        </span>
        <div className="preset-menu__chips">
          {presets.map((name) => (
            <button key={name} type="button" className="preset-chip" onClick={() => onApply(name)}>
              {name}
            </button>
          ))}
          <button
            type="button"
            className="preset-chip"
            data-defaults=""
            title={t('screens.studio.presets.hint')}
            onClick={() => onApply(null)}
          >
            <IconRestore aria-hidden="true" />
            {t('screens.studio.presets.defaults')}
          </button>
        </div>
      </div>
    </div>
  )
}
