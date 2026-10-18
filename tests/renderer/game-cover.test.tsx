import { act, fireEvent, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { GameCover } from '@renderer/features/worlds/GameCover'
import { installGoatMock } from './goat-mock'
import { renderWithProviders } from './render-app'

const COVER_URL = `goat-cover://${'ab'.repeat(32)}.png`
const OTHER_URL = `goat-cover://${'cd'.repeat(32)}.jpg`

/** Waits for covers:get to have answered, so that an absent image means "none", not "not yet". */
async function answered(queryClient: QueryClient, game: string): Promise<void> {
  await waitFor(() => expect(queryClient.getQueryState(['covers:get', { game }])?.status).toBe('success'))
}

const cover = (container: HTMLElement): HTMLElement => {
  const root = container.querySelector<HTMLElement>('.game-cover')
  if (!root) throw new Error('no GameCover rendered')
  return root
}

describe('GameCover', () => {
  it('shows the cover returned by covers:get, as a decorative lazy image', async () => {
    const goat = installGoatMock({ 'covers:get': () => ({ url: COVER_URL }) })
    const { container } = await renderWithProviders(<GameCover game="Celeste" />)

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    const image = container.querySelector('img') as HTMLImageElement
    expect(image).toHaveAttribute('src', COVER_URL)
    // Decorative: the game's name is always written next to it.
    expect(image).toHaveAttribute('alt', '')
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(container.querySelector('.game-sprite')).toBeNull()
    expect(goat.inputsOf('covers:get')).toEqual([{ game: 'Celeste' }])
  })

  it('falls back to the sprite when covers:get answers null', async () => {
    installGoatMock({ 'covers:get': () => ({ url: null }) })
    const { container, queryClient } = await renderWithProviders(<GameCover game="Celeste" />)

    await answered(queryClient, 'Celeste')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.game-sprite')).not.toBeNull()
    expect(cover(container)).toHaveAttribute('data-state', 'sprite')
  })

  it('falls back to the sprite when covers:get fails', async () => {
    installGoatMock({
      'covers:get': () => {
        throw new Error('the main process is gone')
      },
    })
    const { container, queryClient } = await renderWithProviders(<GameCover game="Celeste" />)

    await waitFor(() =>
      expect(queryClient.getQueryState(['covers:get', { game: 'Celeste' }])?.status).toBe('error'),
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.game-sprite')).not.toBeNull()
  })

  it('falls back to the sprite when the image fails to load', async () => {
    installGoatMock({ 'covers:get': () => ({ url: COVER_URL }) })
    const { container } = await renderWithProviders(<GameCover game="Celeste" />)

    const image = await waitFor(() => {
      const found = container.querySelector('img')
      expect(found).not.toBeNull()
      return found as HTMLImageElement
    })
    fireEvent.error(image)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.game-sprite')).not.toBeNull()
    expect(cover(container)).toHaveAttribute('data-state', 'sprite')
  })

  it('tries the image again when the cover changes after a failure', async () => {
    let url = COVER_URL
    installGoatMock({ 'covers:get': () => ({ url }) })
    const { container, queryClient } = await renderWithProviders(<GameCover game="Celeste" />)
    fireEvent.error(
      await waitFor(() => {
        const found = container.querySelector('img')
        expect(found).not.toBeNull()
        return found as HTMLImageElement
      }),
    )
    expect(container.querySelector('img')).toBeNull()

    url = OTHER_URL
    await act(() => queryClient.invalidateQueries({ queryKey: ['covers:get'] }))
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', OTHER_URL))
  })

  it('takes the size and the class it is given', async () => {
    installGoatMock({ 'covers:get': () => ({ url: null }) })
    const { container } = await renderWithProviders(
      <>
        <GameCover game="A" />
        <GameCover game="B" size="md" />
        <GameCover game="C" size="lg" className="mine" />
      </>,
    )

    const boxes = [...container.querySelectorAll<HTMLElement>('.game-cover')]
    expect(boxes.map((box) => box.dataset.size)).toEqual(['sm', 'md', 'lg'])
    expect(boxes[2]).toHaveClass('mine')
  })

  describe('lazy asking', () => {
    class FakeIntersectionObserver {
      static all: FakeIntersectionObserver[] = []
      readonly targets = new Set<Element>()
      constructor(private readonly callback: IntersectionObserverCallback) {
        FakeIntersectionObserver.all.push(this)
      }
      observe(target: Element): void {
        this.targets.add(target)
      }
      unobserve(target: Element): void {
        this.targets.delete(target)
      }
      disconnect(): void {
        this.targets.clear()
      }
      /** The observed elements scroll into view. */
      show(): void {
        const entries = [...this.targets].map((target) => ({ target, isIntersecting: true }))
        this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
      }
    }

    beforeEach(() => {
      FakeIntersectionObserver.all = []
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('asks for the cover once it is on screen, not before', async () => {
      const goat = installGoatMock({ 'covers:get': () => ({ url: COVER_URL }) })
      const { container } = await renderWithProviders(<GameCover game="Celeste" />)

      // Off screen (an option far down a long list): no download is triggered for it.
      expect(goat.inputsOf('covers:get')).toEqual([])
      expect(container.querySelector('.game-sprite')).not.toBeNull()

      act(() => FakeIntersectionObserver.all.forEach((observer) => observer.show()))
      await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', COVER_URL))
      expect(goat.inputsOf('covers:get')).toEqual([{ game: 'Celeste' }])
    })

    it('stops watching once it asked', async () => {
      installGoatMock({ 'covers:get': () => ({ url: COVER_URL }) })
      const { container } = await renderWithProviders(<GameCover game="Celeste" />)
      act(() => FakeIntersectionObserver.all.forEach((observer) => observer.show()))
      await waitFor(() => expect(container.querySelector('img')).not.toBeNull())

      expect(FakeIntersectionObserver.all.every((observer) => observer.targets.size === 0)).toBe(true)
    })
  })
})
