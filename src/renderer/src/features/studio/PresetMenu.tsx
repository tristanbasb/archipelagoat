// The game's presets (Archipelago's option presets, from the local templates or the site) and the
// way back to the defaults, as a row of chips. A preset starts over from the defaults.
import { IconRestore, IconWand } from '@tabler/icons-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import './PresetMenu.css'

export interface PresetMenuProps {
  presets: readonly string[]
  /** `null`: the defaults. */
  onApply: (preset: string | null) => void
  className?: string
}

export function PresetMenu({ presets, onApply, className }: PresetMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const labelId = useId()
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={className ? `preset-menu ${className}` : 'preset-menu'}
    >
      <span id={labelId} className="preset-menu__label">
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
  )
}
