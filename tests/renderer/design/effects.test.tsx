import { act, render, screen } from '@testing-library/react'
import { CRTOverlay } from '@renderer/design/components'
import { createSfx, sfx, type SfxName } from '@renderer/design/sfx'
import {
  DEFAULT_EFFECTS,
  EffectsProvider,
  effectsClassName,
  useEffectsPrefs,
  type EffectsConfig,
} from '@renderer/design/useEffectsPrefs'
import { setMediaQuery } from '../setup'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const ALL_ON: EffectsConfig = { crt: true, glow: true, animations: true, sounds: true }

function Probe(): React.JSX.Element {
  return <output data-testid="prefs">{JSON.stringify(useEffectsPrefs())}</output>
}

function prefs(): unknown {
  return JSON.parse(screen.getByTestId('prefs').textContent ?? 'null')
}

function fxRoot(container: HTMLElement): Element {
  const root = container.querySelector('[data-fx-root]')
  if (!root) throw new Error('EffectsProvider rendered no fx root')
  return root
}

describe('useEffectsPrefs', () => {
  afterEach(() => sfx.setEnabled(false))

  it('falls back to the app defaults without a provider', () => {
    render(<Probe />)
    expect(prefs()).toEqual({ ...DEFAULT_EFFECTS, reduced: false })
    expect(DEFAULT_EFFECTS).toEqual({ crt: true, glow: true, animations: true, sounds: false })
  })

  it('reads the effects config given to EffectsProvider', () => {
    const effects = { crt: false, glow: true, animations: false, sounds: true }
    const { container } = render(
      <EffectsProvider effects={effects}>
        <Probe />
      </EffectsProvider>,
    )
    expect(prefs()).toEqual({ ...effects, reduced: false })
    expect(fxRoot(container).className).toContain('fx-no-crt')
    expect(fxRoot(container).className).toContain('fx-no-anim')
    expect(fxRoot(container).className).not.toContain('fx-no-glow')
    expect(fxRoot(container).className).not.toContain('fx-off')
  })

  it('effects off when reduced motion', () => {
    setMediaQuery(REDUCED_MOTION, true)
    const { container } = render(
      <EffectsProvider effects={ALL_ON}>
        <Probe />
        <CRTOverlay />
      </EffectsProvider>,
    )
    expect(prefs()).toEqual({ crt: false, glow: false, animations: false, sounds: true, reduced: true })
    expect(fxRoot(container).className).toContain('fx-off')
    expect(container.querySelector('.crt-overlay')).toBeNull()
  })

  it('follows the reduced-motion preference when it changes', () => {
    render(
      <EffectsProvider effects={ALL_ON}>
        <Probe />
      </EffectsProvider>,
    )
    expect(prefs()).toMatchObject({ animations: true, reduced: false })
    act(() => setMediaQuery(REDUCED_MOTION, true))
    expect(prefs()).toMatchObject({ animations: false, glow: false, crt: false, reduced: true })
    act(() => setMediaQuery(REDUCED_MOTION, false))
    expect(prefs()).toMatchObject({ animations: true, glow: true, crt: true, reduced: false })
  })

  it('maps each disabled effect to its class, and all of them to fx-off', () => {
    expect(effectsClassName({ crt: true, glow: true, animations: true })).toBe('')
    expect(effectsClassName({ crt: false, glow: true, animations: true })).toBe('fx-no-crt')
    expect(effectsClassName({ crt: true, glow: false, animations: true })).toBe('fx-no-glow')
    expect(effectsClassName({ crt: true, glow: true, animations: false })).toBe('fx-no-anim')
    expect(effectsClassName({ crt: false, glow: false, animations: false }).split(' ')).toEqual(
      expect.arrayContaining(['fx-off', 'fx-no-crt', 'fx-no-glow', 'fx-no-anim']),
    )
  })

  it('switches the sound effects with the sounds setting', () => {
    const { rerender } = render(<EffectsProvider effects={{ ...ALL_ON, sounds: true }}>x</EffectsProvider>)
    expect(sfx.enabled).toBe(true)
    rerender(<EffectsProvider effects={{ ...ALL_ON, sounds: false }}>x</EffectsProvider>)
    expect(sfx.enabled).toBe(false)
  })
})

describe('CRTOverlay', () => {
  it('is a decorative overlay that never takes the pointer', () => {
    const { container } = render(
      <EffectsProvider effects={ALL_ON}>
        <CRTOverlay />
      </EffectsProvider>,
    )
    const overlay = container.querySelector('.crt-overlay')
    expect(overlay).not.toBeNull()
    expect(overlay).toHaveAttribute('aria-hidden', 'true')
    expect(overlay).toHaveStyle({ pointerEvents: 'none' })
  })

  it('is not rendered when the CRT effect is off', () => {
    const { container } = render(
      <EffectsProvider effects={{ ...ALL_ON, crt: false }}>
        <CRTOverlay />
      </EffectsProvider>,
    )
    expect(container.querySelector('.crt-overlay')).toBeNull()
  })
})

describe('sfx', () => {
  const NAMES: SfxName[] = ['blip', 'confirm', 'error', 'coin', 'success']

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('is a no-op while sounds are off (the default)', () => {
    const createOscillator = vi.spyOn(AudioContext.prototype, 'createOscillator')
    const player = createSfx()
    expect(player.enabled).toBe(false)
    for (const name of NAMES) player.play(name)
    expect(createOscillator).not.toHaveBeenCalled()
  })

  it('synthesizes every sound with oscillators once enabled', () => {
    const createOscillator = vi.spyOn(AudioContext.prototype, 'createOscillator')
    const player = createSfx()
    player.setEnabled(true)
    for (const name of NAMES) {
      createOscillator.mockClear()
      player.play(name)
      expect(createOscillator, name).toHaveBeenCalled()
    }
  })

  it('opens one AudioContext lazily and resumes it when suspended', () => {
    const contexts: AudioContext[] = []
    const Real = AudioContext
    vi.stubGlobal(
      'AudioContext',
      class extends Real {
        constructor() {
          super()
          ;(this as { state: AudioContextState }).state = 'suspended'
          contexts.push(this)
        }
      },
    )
    const resume = vi.spyOn(Real.prototype, 'resume')
    const player = createSfx()
    player.setEnabled(true)
    expect(contexts).toHaveLength(0)
    player.play('blip')
    player.play('coin')
    expect(contexts).toHaveLength(1)
    expect(resume).toHaveBeenCalled()
  })

  it('stays silent when WebAudio is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined)
    const player = createSfx()
    player.setEnabled(true)
    expect(() => player.play('error')).not.toThrow()
  })
})
