// A little pixel "invader" drawn from a game's name: every game gets its own sprite and neon,
// the same in the installed list and in the catalog. No image is fetched.
import { cx, toneClass, type Tone } from '../../design/classes'
import './GameSprite.css'

/** The neons a sprite can take (pink stays for danger). */
const SPRITE_TONES: readonly Tone[] = ['violet', 'cyan', 'yellow', 'green', 'magenta']

const SIZE = 5
const HALF = Math.ceil(SIZE / 2)
/** The left half of the sprite holds 15 cells: between 6 and 11 lit reads as a creature. */
const HALF_MASK = (1 << (SIZE * HALF)) - 1
const MIN_LIT = 6
const MAX_LIT = 11

/** FNV-1a: a stable 32-bit hash of the text. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
}

export function spriteTone(name: string): Tone {
  return SPRITE_TONES[hash(name) % SPRITE_TONES.length] ?? 'violet'
}

/** The lit cells of a 5×5 sprite, mirrored around its middle column. */
export function spriteCells(name: string): [x: number, y: number][] {
  // Specks and solid blocks do not read as a creature: rehash until the density fits.
  let bits = hash(`${name}\u0000sprite`)
  for (let round = 0; round < 32; round += 1) {
    const lit = popCount(bits & HALF_MASK)
    if (lit >= MIN_LIT && lit <= MAX_LIT) break
    bits = (Math.imul(bits ^ (bits >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0
  }
  const cells: [number, number][] = []
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < HALF; x += 1) {
      if (((bits >>> (y * HALF + x)) & 1) === 0) continue
      cells.push([x, y])
      if (x !== SIZE - 1 - x) cells.push([SIZE - 1 - x, y])
    }
  }
  return cells
}

function popCount(value: number): number {
  let count = 0
  for (let rest = value; rest !== 0; rest &= rest - 1) count += 1
  return count
}

export interface GameSpriteProps {
  /** The game (or module) the sprite is drawn from. */
  name: string
  size?: 'sm' | 'lg'
  className?: string
}

/** Decorative: the game's name is always written next to it. */
export function GameSprite({ name, size = 'sm', className }: GameSpriteProps): React.JSX.Element {
  return (
    <span
      className={cx('game-sprite', toneClass(spriteTone(name)), className)}
      data-size={size}
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} shapeRendering="crispEdges" focusable="false">
        {spriteCells(name).map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
        ))}
      </svg>
    </span>
  )
}
