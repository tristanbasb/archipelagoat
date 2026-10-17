// The ArchipelaGOAT identity drawn in pixels: the goat head (yellow horns, violet head), the little
// floating islands of the archipelago, and the wordmark.
import { cx } from '../design/classes'
import './Logo.css'

type Palette = Record<string, string>

interface Run {
  x: number
  y: number
  width: number
  cls: string
}

/** Runs of same-colored pixels, one rect each; '.' is empty. */
function pixelRuns(rows: readonly string[], palette: Palette): Run[] {
  return rows.flatMap((row, y) => {
    const runs: Run[] = []
    let x = 0
    while (x < row.length) {
      const cell = row[x] ?? '.'
      let end = x + 1
      while (end < row.length && row[end] === cell) end++
      const cls = palette[cell]
      if (cls) runs.push({ x, y, width: end - x, cls })
      x = end
    }
    return runs
  })
}

interface PixelArtProps {
  runs: Run[]
  columns: number
  rows: number
  /** Width in px; the height follows. */
  size: number
  className?: string
}

function PixelArt({ runs, columns, rows, size, className }: PixelArtProps): React.JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={(size * rows) / columns}
      viewBox={`0 0 ${columns} ${rows}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {runs.map(({ x, y, width, cls }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={width} height={1} className={cls} />
      ))}
    </svg>
  )
}

// 16×16. Y horn and beard, V head, v muzzle, W eye light, E eye, N nostril.
const GOAT = [
  '..Y..........Y..',
  '..YY........YY..',
  '...YY......YY...',
  '....YY....YY....',
  '.....YVVVVY.....',
  '.VVVVVVVVVVVVVV.',
  'VV..VVVVVVVV..VV',
  '....VWEVVWEV....',
  '....VEEVVEEV....',
  '....VVVVVVVV....',
  '.....VVVVVV.....',
  '.....vvvvvv.....',
  '.....vNvvNv.....',
  '......vvvv......',
  '.......YY.......',
  '.......Y........',
]

const GOAT_RUNS = pixelRuns(GOAT, {
  Y: 'pixel-horn',
  V: 'pixel-head',
  v: 'pixel-muzzle',
  W: 'pixel-light',
  E: 'pixel-eye',
  N: 'pixel-eye',
})

export function GoatMark({ size = 24, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <PixelArt runs={GOAT_RUNS} columns={16} rows={16} size={size} className={cx('goat-mark', className)} />
  )
}

// 14×9. P palm leaves, T trunk, g grass, e earth.
const PALM_ISLAND = [
  '.....PPP......',
  '....PP.PP.....',
  '......T.......',
  '......T.......',
  '..ggggggggg...',
  '.eeeeeeeeeee..',
  '..eeeeeeeee...',
  '....eeeee.....',
  '......ee......',
]

// 10×4.
const ROCK_ISLAND = ['...gggg...', '.eeeeeeee.', '..eeeeee..', '....ee....']

const ISLANDS = {
  palm: {
    runs: pixelRuns(PALM_ISLAND, { P: 'pixel-leaf', T: 'pixel-trunk', g: 'pixel-grass', e: 'pixel-earth' }),
    columns: 14,
    rows: 9,
  },
  rock: { runs: pixelRuns(ROCK_ISLAND, { g: 'pixel-grass', e: 'pixel-earth' }), columns: 10, rows: 4 },
}

/** One floating island of the archipelago. */
export function IslandMark({
  kind = 'palm',
  size = 56,
  className,
}: {
  kind?: keyof typeof ISLANDS
  size?: number
  className?: string
}): React.JSX.Element {
  const { runs, columns, rows } = ISLANDS[kind]
  return (
    <PixelArt
      runs={runs}
      columns={columns}
      rows={rows}
      size={size}
      className={cx('island-mark', className)}
    />
  )
}

/** "ArchipelaGOAT", with GOAT lit in yellow. */
export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={cx('wordmark', className)}>
      Archipela<span className="wordmark__goat tone-yellow">GOAT</span>
    </span>
  )
}
