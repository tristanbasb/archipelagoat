// A game's cover, the image of its wiki page that the main process downloads and caches
// (covers:get), in a box of one ratio. The pixel sprite stands in while there is no image: no cover,
// still loading, or an image that does not load.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { cx } from '../../design/classes'
import { useIpcQuery } from '../../hooks/useIpc'
import { GameSprite } from './GameSprite'
import './GameCover.css'

export interface GameCoverProps {
  /** The game's name, as Archipelago names it. */
  game: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

/**
 * True once the element has been on screen. Asking for a cover downloads it, so a long list (the
 * Studio's) asks for the covers in view only. Without IntersectionObserver every element counts as seen.
 */
function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const element = ref.current
    if (seen || !element) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setSeen(true)
      observer.disconnect()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, seen])
  return seen
}

/** Decorative: the game's name is always written next to it. */
export function GameCover({ game, size = 'sm', className }: GameCoverProps): React.JSX.Element {
  const box = useRef<HTMLSpanElement>(null)
  const seen = useSeen(box)
  // A cover is fetched once: the main process keeps it, and asking again would change nothing.
  const cover = useIpcQuery('covers:get', { game }, { enabled: seen, staleTime: Infinity })
  // The cover that failed to load: it stays out until the game has another one.
  const [broken, setBroken] = useState<string | null>(null)
  const url = cover.data?.url ?? null
  const image = url !== null && url !== broken ? url : null

  return (
    <span
      ref={box}
      className={cx('game-cover', className)}
      data-size={size}
      data-state={image === null ? 'sprite' : 'image'}
    >
      {image === null ? (
        <GameSprite name={game} size={size === 'lg' ? 'lg' : 'sm'} />
      ) : (
        <img
          className="game-cover__image"
          src={image}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBroken(image)}
        />
      )}
    </span>
  )
}
