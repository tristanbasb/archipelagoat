// WCAG 2 contrast ratio between two hex colors (#rgb or #rrggbb).

function channels(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1]
  if (hex === undefined) throw new RangeError(`not a #rgb or #rrggbb color: ${color}`)
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number]
}

function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: string): number {
  const [r, g, b] = channels(color).map(linear) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contrast ratio from 1 to 21; the order of the two colors does not matter. */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg)
  const b = relativeLuminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
