// Small helpers shared by the design components: class joining, tones and CSS custom properties.
import type { CSSProperties } from 'react'

/** The neon a component is drawn in (see the .tone-* classes of tokens.css). */
export type Tone = 'violet' | 'cyan' | 'yellow' | 'pink' | 'green' | 'magenta' | 'neutral'

/** The neons in palette order, for series (weights, players…). */
export const NEON_SERIES: readonly Tone[] = ['violet', 'cyan', 'yellow', 'pink', 'green', 'magenta']

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function toneClass(tone: Tone): string {
  return `tone-${tone}`
}

/** Inline CSS custom properties, e.g. `cssVars({ '--chars': 12 })`. */
export function cssVars(vars: Record<`--${string}`, string | number>, style?: CSSProperties): CSSProperties {
  return { ...style, ...vars }
}
