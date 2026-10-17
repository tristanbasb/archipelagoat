import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrastRatio } from '@renderer/design/contrast'

// Read from disk (Vitest runs from the project root): it empties imported CSS, `?raw` included.
const tokensCss = readFileSync(join(process.cwd(), 'src/renderer/src/design/tokens.css'), 'utf8')

/** The custom properties declared in the first `:root { … }` block, whitespace normalized. */
function rootTokens(css: string): Map<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css)
  if (!root?.[1]) throw new Error(':root block not found in tokens.css')
  const tokens = new Map<string, string>()
  for (const match of root[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1] ?? '', (match[2] ?? '').trim().replace(/\s+/g, ' '))
  }
  return tokens
}

function token(name: string): string {
  const value = rootTokens(tokensCss).get(name)
  if (value === undefined) throw new Error(`--${name} is missing from tokens.css`)
  return value
}

// Spec §4.3, verbatim.
const SPEC_TOKENS: Record<string, string> = {
  'bg-0': '#07070C',
  'bg-1': '#0B0B12',
  'bg-2': '#111118',
  'bg-3': '#1A1A24',
  line: '#26262F',
  'line-strong': '#3A3A48',
  text: '#F5F3FF',
  'text-dim': '#9D9DB0',
  'text-mute': '#5B5B6B',
  'neon-violet': '#A855F7',
  'neon-cyan': '#22D3EE',
  'neon-yellow': '#FACC15',
  'neon-pink': '#F43F5E',
  'neon-green': '#4ADE80',
  'neon-magenta': '#EE00EE',
  'glow-violet': '0 0 6px #A855F7aa, 0 0 18px #A855F755',
}

describe('design tokens', () => {
  it('declares the spec tokens with their exact values', () => {
    for (const [name, value] of Object.entries(SPEC_TOKENS)) {
      expect(token(name).toLowerCase(), `--${name}`).toBe(value.toLowerCase())
    }
  })

  it('declares a glow for every neon color', () => {
    for (const color of ['violet', 'cyan', 'yellow', 'pink', 'green', 'magenta']) {
      const neon = token(`neon-${color}`).toLowerCase()
      expect(token(`glow-${color}`).toLowerCase()).toBe(`0 0 6px ${neon}aa, 0 0 18px ${neon}55`)
    }
  })

  it('text tokens reach 4.5:1 on bg-0 and bg-2', () => {
    for (const fg of ['text', 'text-dim']) {
      for (const bg of ['bg-0', 'bg-1', 'bg-2', 'bg-3']) {
        expect(contrastRatio(token(fg), token(bg)), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps --text-mute (under 4.5:1) off readable text: icons, separators and disabled items only', () => {
    // Spec §4.3: text reaches 4.5:1. --text-mute does not on any background, so it colors no text.
    expect(contrastRatio(token('text-mute'), token('bg-1'))).toBeLessThan(4.5)
    const src = join(process.cwd(), 'src/renderer/src')
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.css'))
    const muted: string[] = []
    for (const file of files) {
      const css = readFileSync(join(src, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      // The innermost rules: a selector, then declarations without a nested block.
      for (const [, selector = '', body = ''] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        if (/(?:^|[;\s])color\s*:\s*var\(--text-mute\)/.test(body)) muted.push(selector.trim())
      }
    }
    expect(muted.sort()).toEqual(
      [
        // Icons and icon buttons.
        '.stat-tile__chevron',
        '.join-history__go',
        '.join-history__forget',
        '.slot-card__go',
        '.roster-file__icon',
        '.issue-list__go',
        '.rom-row__dir svg',
        '.rom-row__remove',
        // A decorative separator.
        '.join-history__slot + .join-history__game::before',
        // A disabled choice.
        '.select option:disabled',
      ].sort(),
    )
  })

  it('neon colors used as text reach 4.5:1 on bg-0 and bg-2', () => {
    for (const color of ['violet', 'cyan', 'yellow', 'pink', 'green', 'magenta']) {
      for (const bg of ['bg-0', 'bg-2']) {
        expect(contrastRatio(token(`neon-${color}`), token(bg)), `${color} on ${bg}`).toBeGreaterThanOrEqual(
          4.5,
        )
      }
    }
  })
})

describe('contrastRatio', () => {
  it('follows WCAG 2 relative luminance', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBe(1)
    // Reference value from the WCAG contrast checker.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2)
  })

  it('accepts the 3-digit shorthand and any case', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#a855f7', '#A855F7')).toBe(1)
  })

  it('rejects colors it cannot read', () => {
    expect(() => contrastRatio('violet', '#000')).toThrow(RangeError)
    expect(() => contrastRatio('#12345', '#000')).toThrow(RangeError)
  })
})
