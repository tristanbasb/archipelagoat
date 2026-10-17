// Pixel confetti over the whole window, for a successful generation. Nothing is drawn when the
// animations are off (settings or the OS "reduce motion"); `onDone` still fires.
import { useEffect, useEffectEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { cssVars } from '../../design/classes'
import { useEffectsPrefs, usePortalContainer } from '../../design/useEffectsPrefs'
import './PixelConfetti.css'

const PIECES = 96
const DURATION_MS = 3600
const NEONS = ['violet', 'cyan', 'yellow', 'pink', 'green', 'magenta'] as const

interface Piece {
  x: number
  drift: number
  delay: number
  duration: number
  size: number
  wide: boolean
  neon: (typeof NEONS)[number]
}

/** mulberry32: a small seeded generator, so the burst is the same every time (and render stays pure). */
function generator(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let x = Math.imul(state ^ (state >>> 15), 1 | state)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function makePieces(): Piece[] {
  const random = generator(0x60a7)
  return Array.from({ length: PIECES }, (_, index) => ({
    x: random() * 100,
    drift: (random() - 0.5) * 24,
    delay: random() * 900,
    duration: 1900 + random() * 1300,
    size: 6 + Math.floor(random() * 3) * 2,
    wide: random() < 0.35,
    neon: NEONS[index % NEONS.length] ?? 'violet',
  }))
}

export function PixelConfetti({ onDone }: { onDone?: () => void }): React.JSX.Element | null {
  const { animations } = useEffectsPrefs()
  const container = usePortalContainer()
  const [pieces] = useState(makePieces)
  const done = useEffectEvent(() => onDone?.())

  useEffect(() => {
    const timer = window.setTimeout(() => done(), animations ? DURATION_MS + 900 : 0)
    return () => window.clearTimeout(timer)
  }, [animations])

  if (!animations) return null
  return createPortal(
    <div className="pixel-confetti" aria-hidden="true">
      {pieces.map((piece, index) => (
        <span
          key={index}
          className="pixel-confetti__piece"
          data-wide={piece.wide || undefined}
          style={cssVars({
            '--x': `${piece.x}%`,
            '--drift': `${piece.drift}vw`,
            '--delay': `${piece.delay}ms`,
            '--dur': `${piece.duration}ms`,
            '--size': `${piece.size}px`,
            '--color': `var(--neon-${piece.neon})`,
          })}
        />
      ))}
    </div>,
    container,
  )
}
