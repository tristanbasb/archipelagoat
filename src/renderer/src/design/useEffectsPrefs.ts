// Visual and sound effect preferences: the `effects` part of the app config, cut by the OS
// "reduce motion" setting. EffectsProvider scopes them: it renders the fx root (the element that
// carries the fx-* classes of effects.css) and a portal host inside it, so modals, toasts and
// tooltips follow the same classes.
import { MotionConfig } from 'motion/react'
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { AppConfig } from '@shared/types'
import { sfx } from './sfx'

export type EffectsConfig = AppConfig['effects']

export interface EffectsPrefs extends EffectsConfig {
  /** The OS asks for reduced motion: glow, CRT and animations are then off whatever the config. */
  reduced: boolean
}

/** Same as the app's default config (sounds are off by default). */
export const DEFAULT_EFFECTS: EffectsConfig = Object.freeze({
  crt: true,
  glow: true,
  animations: true,
  sounds: false,
})

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

const EffectsContext = createContext<EffectsConfig>(DEFAULT_EFFECTS)
const PortalContext = createContext<HTMLElement | null>(null)

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false)
}

function resolvePrefs(effects: EffectsConfig, reduced: boolean): EffectsPrefs {
  return {
    crt: effects.crt && !reduced,
    glow: effects.glow && !reduced,
    animations: effects.animations && !reduced,
    sounds: effects.sounds,
    reduced,
  }
}

export function useEffectsPrefs(): EffectsPrefs {
  const effects = useContext(EffectsContext)
  const reduced = usePrefersReducedMotion()
  return useMemo(() => resolvePrefs(effects, reduced), [effects, reduced])
}

/** The fx-* classes of effects.css for these preferences; `fx-off` when every visual effect is off. */
export function effectsClassName(prefs: Pick<EffectsPrefs, 'crt' | 'glow' | 'animations'>): string {
  const classes = [
    !prefs.crt && 'fx-no-crt',
    !prefs.glow && 'fx-no-glow',
    !prefs.animations && 'fx-no-anim',
  ].filter((name): name is string => typeof name === 'string')
  if (classes.length === 3) classes.unshift('fx-off')
  return classes.join(' ')
}

/** Where overlays (Modal, Toast, Tooltip) render: inside the nearest fx root, else in the body. */
export function usePortalContainer(): HTMLElement {
  return useContext(PortalContext) ?? document.body
}

export interface EffectsProviderProps {
  effects: EffectsConfig
  children?: ReactNode
}

export function EffectsProvider({ effects, children }: EffectsProviderProps): React.JSX.Element {
  const reduced = usePrefersReducedMotion()
  const prefs = resolvePrefs(effects, reduced)
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    sfx.setEnabled(effects.sounds)
  }, [effects.sounds])

  return createElement(
    EffectsContext,
    { value: effects },
    createElement(
      MotionConfig,
      { reducedMotion: prefs.animations ? 'user' : 'always' },
      createElement(
        'div',
        { 'data-fx-root': '', className: ['fx-root', effectsClassName(prefs)].filter(Boolean).join(' ') },
        createElement(PortalContext, { value: portalHost }, children),
        createElement('div', { ref: setPortalHost, className: 'fx-portal-host' }),
      ),
    ),
  )
}
