// Step 3: how the game is played. A preset fills every rule; changing one by hand makes the rules
// custom. Leaving the step saves them (session:update) and the passwords (session:setSecrets).
import {
  IconChevronDown,
  IconEye,
  IconEyeOff,
  IconHourglass,
  IconKey,
  IconMoodHappy,
  IconTrophy,
} from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RULE_PRESETS } from '@shared/rules'
import type { ReleaseMode, Rules, Session } from '@shared/types'
import {
  Badge,
  ErrorPanel,
  PixelPanel,
  Segmented,
  Select,
  Slider,
  Toggle,
  type SegmentedOption,
} from '../../design/components'
import { cx } from '../../design/classes'
import { useIpcQuery } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import { invoke } from '../../lib/goat'
import { StepNav } from './StepNav'
import './StepRules.css'

type PresetId = keyof typeof RULE_PRESETS

const PRESETS: readonly { id: PresetId; icon: ReactNode; tone: string }[] = [
  { id: 'casual', icon: <IconMoodHappy />, tone: 'tone-green' },
  { id: 'async', icon: <IconHourglass />, tone: 'tone-cyan' },
  { id: 'race', icon: <IconTrophy />, tone: 'tone-pink' },
]
const RELEASE_MODES: readonly ReleaseMode[] = ['auto', 'auto-enabled', 'enabled', 'goal', 'disabled']
const PLANDO_KINDS = ['bosses', 'items', 'texts', 'connections'] as const
const SECONDS_PER_MINUTE = 60

/** Same rules, whatever the key order or the order of the plando list. */
function sameRules(a: Rules, b: Rules): boolean {
  return (Object.keys(a) as (keyof Rules)[]).every((key) =>
    key === 'plando' ? [...a.plando].sort().join() === [...b.plando].sort().join() : a[key] === b[key],
  )
}

export interface StepRulesProps {
  session: Session
  onBack: () => void
  onNext: () => void
}

export function StepRules({ session, onBack, onNext }: StepRulesProps): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const advancedId = useId()
  const [rules, setRules] = useState<Rules>(() => structuredClone(session.rules))
  const [advancedOpen, setAdvancedOpen] = useState(session.rules.preset === 'custom')
  // null: untouched, so the saved password stays as it is.
  const [password, setPassword] = useState<string | null>(null)
  const [serverPassword, setServerPassword] = useState<string | null>(null)
  const secrets = useIpcQuery(
    'session:getSecrets',
    { id: session.id },
    { enabled: session.hasPassword || session.hasServerPassword, gcTime: 0, staleTime: 0 },
  )

  const save = useMutation<void, unknown, void>({
    mutationFn: async () => {
      if (!sameRules(rules, session.rules)) {
        const updated = await invoke('session:update', { id: session.id, rules })
        queryClient.setQueryData(['session:get', { id: session.id }], updated)
      }
      const patch: { password?: string | null; serverPassword?: string | null } = {}
      if (password !== null) patch.password = password === '' ? null : password
      if (serverPassword !== null) patch.serverPassword = serverPassword === '' ? null : serverPassword
      if (Object.keys(patch).length > 0) {
        await invoke('session:setSecrets', { id: session.id, ...patch })
        await queryClient.invalidateQueries({ queryKey: ['session:get'] })
      }
    },
  })
  const leave = (go: () => void): void => save.mutate(undefined, { onSuccess: go })

  const choosePreset = (preset: PresetId): void => setRules(structuredClone(RULE_PRESETS[preset]))
  const change = (patch: Partial<Rules>): void =>
    setRules((current) => ({ ...current, ...patch, preset: 'custom' }))
  const failure = save.error ? describeError(save.error, t) : null

  const modeOptions = RELEASE_MODES.map((mode) => ({
    value: mode,
    label: t(`screens.session.rules.modes.${mode}`),
  }))
  const spoilerOptions: SegmentedOption<string>[] = ['0', '1', '2', '3'].map((value) => ({
    value,
    label: t(`screens.session.rules.spoilers.${value}`),
  }))

  return (
    <>
      <div className="rules-step">
        <section className="rules-presets" aria-labelledby={`${advancedId}-presets`}>
          <div className="rules-presets__head">
            <h2 id={`${advancedId}-presets`} className="rules-step__title">
              {t('screens.session.rules.presetsLabel')}
            </h2>
            {rules.preset === 'custom' && <Badge tone="yellow">{t('screens.session.rules.custom')}</Badge>}
          </div>
          <div className="rules-presets__cards" role="radiogroup" aria-labelledby={`${advancedId}-presets`}>
            {PRESETS.map((preset) => (
              <PresetCard
                key={preset.id}
                name={`${advancedId}-preset`}
                preset={preset}
                checked={rules.preset === preset.id}
                onSelect={() => choosePreset(preset.id)}
              />
            ))}
          </div>
        </section>

        <PixelPanel
          tone="magenta"
          padding="md"
          title={t('screens.session.rules.passwordsTitle')}
          className="rules-passwords"
        >
          <div className="rules-passwords__fields">
            <SecretField
              label={t('screens.session.rules.password')}
              hint={t('screens.session.rules.passwordHint')}
              value={password ?? secrets.data?.password ?? ''}
              onChange={setPassword}
            />
            <SecretField
              label={t('screens.session.rules.serverPassword')}
              hint={t('screens.session.rules.serverPasswordHint')}
              value={serverPassword ?? secrets.data?.serverPassword ?? ''}
              onChange={setServerPassword}
            />
          </div>
          {secrets.isError && (
            <p className="rules-passwords__warn">{t('screens.session.rules.secretsUnavailable')}</p>
          )}
        </PixelPanel>

        <section className="rules-advanced">
          <button
            type="button"
            className="rules-advanced__toggle"
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <IconChevronDown className="rules-advanced__chevron" aria-hidden="true" />
            <span>{t('screens.session.rules.advanced')}</span>
          </button>
          <div id={advancedId} className="rules-advanced__body" hidden={!advancedOpen}>
            {advancedOpen && (
              <>
                <PixelPanel
                  tone="violet"
                  padding="md"
                  headingLevel={3}
                  title={t('screens.session.rules.groups.hints')}
                >
                  <div className="rules-fields">
                    <Slider
                      label={t('screens.session.rules.hintCost')}
                      hint={t('screens.session.rules.hintCostHint')}
                      min={0}
                      max={100}
                      withInput
                      value={rules.hintCost}
                      onChange={(hintCost) => change({ hintCost })}
                    />
                    <Slider
                      label={t('screens.session.rules.locationCheckPoints')}
                      hint={t('screens.session.rules.locationCheckPointsHint')}
                      min={0}
                      max={10}
                      withInput
                      value={rules.locationCheckPoints}
                      onChange={(locationCheckPoints) => change({ locationCheckPoints })}
                    />
                  </div>
                </PixelPanel>

                <PixelPanel
                  tone="cyan"
                  padding="md"
                  headingLevel={3}
                  title={t('screens.session.rules.groups.commands')}
                >
                  <div className="rules-fields">
                    <Select
                      label={t('screens.session.rules.releaseMode')}
                      hint={t('screens.session.rules.releaseModeHint')}
                      options={modeOptions}
                      value={rules.releaseMode}
                      onChange={(releaseMode) => change({ releaseMode })}
                    />
                    <Select
                      label={t('screens.session.rules.collectMode')}
                      hint={t('screens.session.rules.collectModeHint')}
                      options={modeOptions}
                      value={rules.collectMode}
                      onChange={(collectMode) => change({ collectMode })}
                    />
                    <ChoiceField
                      label={t('screens.session.rules.remainingMode')}
                      options={(['enabled', 'goal', 'disabled'] as const).map((value) => ({
                        value,
                        label: t(`screens.session.rules.remaining.${value}`),
                      }))}
                      value={rules.remainingMode}
                      onChange={(remainingMode) => change({ remainingMode })}
                    />
                    <ChoiceField
                      label={t('screens.session.rules.countdownMode')}
                      hint={t('screens.session.rules.countdownHint')}
                      options={(['auto', 'enabled', 'disabled'] as const).map((value) => ({
                        value,
                        label: t(`screens.session.rules.countdown.${value}`),
                      }))}
                      value={rules.countdownMode}
                      onChange={(countdownMode) => change({ countdownMode })}
                    />
                    <Toggle
                      className="rules-fields__wide"
                      tone="pink"
                      label={t('screens.session.rules.itemCheat')}
                      description={t('screens.session.rules.itemCheatHint')}
                      checked={rules.itemCheat}
                      onChange={(itemCheat) => change({ itemCheat })}
                    />
                  </div>
                </PixelPanel>

                <PixelPanel
                  tone="yellow"
                  padding="md"
                  headingLevel={3}
                  title={t('screens.session.rules.groups.game')}
                >
                  <div className="rules-fields">
                    <ChoiceField
                      label={t('screens.session.rules.spoiler')}
                      hint={t('screens.session.rules.spoilerHint')}
                      options={spoilerOptions}
                      value={String(rules.spoiler)}
                      onChange={(value) => change({ spoiler: Number(value) as Rules['spoiler'] })}
                    />
                    <ChoiceField
                      label={t('screens.session.rules.compatibility')}
                      hint={t('screens.session.rules.compatibilityHint')}
                      options={['2', '0'].map((value) => ({
                        value,
                        label: t(`screens.session.rules.compatibilities.${value}`),
                      }))}
                      value={String(rules.compatibility)}
                      onChange={(value) => change({ compatibility: Number(value) as Rules['compatibility'] })}
                    />
                    <Toggle
                      label={t('screens.session.rules.race')}
                      description={t('screens.session.rules.raceHint')}
                      checked={rules.race}
                      onChange={(race) => change({ race })}
                    />
                    <Slider
                      label={t('screens.session.rules.autoShutdown')}
                      hint={t('screens.session.rules.autoShutdownHint')}
                      min={0}
                      max={720}
                      step={5}
                      withInput
                      value={Math.round(rules.autoShutdown / SECONDS_PER_MINUTE)}
                      onChange={(minutes) => change({ autoShutdown: minutes * SECONDS_PER_MINUTE })}
                    />
                    <fieldset className="rules-plando rules-fields__wide">
                      <legend className="field__label">{t('screens.session.rules.plando')}</legend>
                      <p className="field__hint">{t('screens.session.rules.plandoHint')}</p>
                      <div className="rules-plando__grid">
                        {PLANDO_KINDS.map((kind) => (
                          <Toggle
                            key={kind}
                            label={t(`screens.session.rules.plandoKinds.${kind}`)}
                            checked={rules.plando.includes(kind)}
                            onChange={(on) =>
                              change({
                                plando: on
                                  ? PLANDO_KINDS.filter(
                                      (other) => other === kind || rules.plando.includes(other),
                                    )
                                  : rules.plando.filter((other) => other !== kind),
                              })
                            }
                          />
                        ))}
                      </div>
                    </fieldset>
                  </div>
                </PixelPanel>
              </>
            )}
          </div>
        </section>

        {failure && (
          <ErrorPanel
            title={failure.title}
            body={failure.body}
            detail={failure.detail}
            detailLabel={t('common.technicalDetails')}
          />
        )}
      </div>
      <StepNav onBack={() => leave(onBack)} onNext={() => leave(onNext)} busy={save.isPending} />
    </>
  )
}

interface PresetCardProps {
  name: string
  preset: (typeof PRESETS)[number]
  checked: boolean
  onSelect: () => void
}

function PresetCard({ name, preset, checked, onSelect }: PresetCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  return (
    <div className="preset">
      <input
        id={id}
        type="radio"
        name={name}
        className="preset__input sr-only"
        checked={checked}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        onChange={onSelect}
      />
      <label htmlFor={id} className={cx('preset__card pixel-border', preset.tone)}>
        <span className="preset__icon" aria-hidden="true">
          {preset.icon}
        </span>
        <span id={`${id}-title`} className="preset__title">
          {t(`screens.session.rules.presets.${preset.id}.title`)}
        </span>
        <span id={`${id}-body`} className="preset__body">
          {t(`screens.session.rules.presets.${preset.id}.body`)}
        </span>
      </label>
    </div>
  )
}

interface ChoiceFieldProps<T extends string> {
  label: string
  hint?: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
}

/** A Segmented control with a visible label and a hint. */
function ChoiceField<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: ChoiceFieldProps<T>): React.JSX.Element {
  return (
    <div className="field">
      <span className="field__label" aria-hidden="true">
        {label}
      </span>
      <Segmented label={label} size="sm" options={options} value={value} onChange={onChange} />
      {hint !== undefined && <span className="field__hint">{hint}</span>}
    </div>
  )
}

interface SecretFieldProps {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
}

function SecretField({ label, hint, value, onChange }: SecretFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const [shown, setShown] = useState(false)
  return (
    <div className="field">
      <label id={`${id}-label`} htmlFor={id} className="field__label">
        {label}
      </label>
      <div className="input-frame pixel-border tone-yellow">
        <IconKey className="secret-field__icon" aria-hidden="true" />
        <input
          id={id}
          className="input"
          type={shown ? 'text' : 'password'}
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label={shown ? t('screens.session.rules.hide') : t('screens.session.rules.show')}
          aria-describedby={`${id}-label`}
          aria-pressed={shown}
          onClick={() => setShown((visible) => !visible)}
        >
          {shown ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
        </button>
      </div>
      <span id={`${id}-hint`} className="field__hint">
        {hint}
      </span>
    </div>
  )
}
