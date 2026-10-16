import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Read from disk (Vitest runs from the project root): it empties imported CSS, `?raw` included.
const RENDERER_SRC = join(process.cwd(), 'src/renderer/src')
const EFFECTS_CSS = join(RENDERER_SRC, 'design/effects.css')
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)'

interface Rule {
  /** The selector list, whitespace normalized. */
  selector: string
  /** The enclosing `@media` prelude, or null at the top level. */
  media: string | null
  /** Declarations in source order, values whitespace normalized. */
  declarations: [property: string, value: string][]
}

/** The style rules of a stylesheet in source order, `@media` blocks flattened, `@keyframes` skipped. */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = []
  const walk = (text: string, media: string | null): void => {
    let at = 0
    for (let open = text.indexOf('{', at); open >= 0; open = text.indexOf('{', at)) {
      let close = open + 1
      for (let depth = 1; depth > 0 && close < text.length; close++) {
        if (text[close] === '{') depth++
        else if (text[close] === '}') depth--
      }
      const prelude = text.slice(at, open).split(';').pop()?.trim().replace(/\s+/g, ' ') ?? ''
      const body = text.slice(open + 1, close - 1)
      if (prelude.startsWith('@media')) walk(body, prelude)
      else if (!prelude.startsWith('@')) {
        const declarations = body
          .split(';')
          .map((declaration) => /^\s*([\w-]+)\s*:([\s\S]*)$/.exec(declaration))
          .filter((match) => match !== null)
          .map(([, property = '', value = '']): [string, string] => [
            property,
            value.trim().replace(/\s+/g, ' '),
          ])
        rules.push({ selector: prelude, media, declarations })
      }
      at = close
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), null)
  return rules
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

const effectsRules = parseRules(readFileSync(EFFECTS_CSS, 'utf8'))

/** The index of the last rule with this selector and media, so the cascade order can be checked. */
function ruleIndex(selector: string, media: string | null = null): number {
  const index = effectsRules.findLastIndex((rule) => rule.selector === selector && rule.media === media)
  if (index < 0) throw new Error(`effects.css has no rule "${selector}"${media ? ` in ${media}` : ''}`)
  return index
}

function valueOf(index: number, property: string): string | undefined {
  return effectsRules[index]?.declarations.findLast(([name]) => name === property)?.[1]
}

const PIXEL_BORDER = '.pixel-border::before, .pixel-border::after'
const PIXEL_BORDER_OFF =
  '.pixel-border:where(.fx-off, .fx-off *)::before, .pixel-border:where(.fx-off, .fx-off *)::after'
const CORNER_TOKENS = ['--clip-corner-sm', '--clip-corner']

/**
 * Pictograms drawn with a clip-path (arrows, carets, a disclosure triangle). They are shapes, not
 * stepped corners, so they keep their outline when the effects are off.
 */
const GLYPHS = new Set([
  '.combobox__cursor',
  '.error-panel__detail summary::before',
  '.player-card__arrow',
  '.terminal__caret',
])

describe('pixel corners (effects.css)', () => {
  it('declares the shared stepped-corner shapes on :root', () => {
    const root = ruleIndex(':root')
    for (const token of CORNER_TOKENS) expect(valueOf(root, token), token).toMatch(/^polygon\(/)
    expect(valueOf(ruleIndex(PIXEL_BORDER), 'clip-path')).toMatch(/^polygon\(/)
  })

  it('squares the pixel corners off under .fx-off', () => {
    const off = ruleIndex('.fx-off')
    for (const token of CORNER_TOKENS) expect(valueOf(off, token), token).toBe('none')
    expect(off).toBeGreaterThan(ruleIndex(':root'))

    const pixelBorderOff = ruleIndex(PIXEL_BORDER_OFF)
    expect(valueOf(pixelBorderOff, 'clip-path')).toBe('none')
    // Same specificity as the stepped rule: it wins by coming later.
    expect(pixelBorderOff).toBeGreaterThan(ruleIndex(PIXEL_BORDER))
  })

  it('squares the pixel corners off under prefers-reduced-motion', () => {
    const root = ruleIndex(':root', REDUCED_MOTION)
    for (const token of CORNER_TOKENS) expect(valueOf(root, token), token).toBe('none')
    expect(root).toBeGreaterThan(ruleIndex(':root'))

    const pixelBorder = ruleIndex(PIXEL_BORDER, REDUCED_MOTION)
    expect(valueOf(pixelBorder, 'clip-path')).toBe('none')
    expect(pixelBorder).toBeGreaterThan(ruleIndex(PIXEL_BORDER))
  })

  it('clips stepped corners only through the shared shapes, which the neutralizers reach', () => {
    const offenders: string[] = []
    for (const file of cssFiles(RENDERER_SRC)) {
      for (const rule of parseRules(readFileSync(file, 'utf8'))) {
        for (const [property, value] of rule.declarations) {
          if (property !== 'clip-path' || !value.startsWith('polygon(')) continue
          if (file === EFFECTS_CSS && rule.selector === PIXEL_BORDER) continue
          if (GLYPHS.has(rule.selector)) continue
          offenders.push(`${relative(RENDERER_SRC, file).replaceAll('\\', '/')}: ${rule.selector}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
