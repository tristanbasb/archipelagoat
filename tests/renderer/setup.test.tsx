import { render, screen } from '@testing-library/react'
import { setMediaQuery } from './setup'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

describe('renderer test environment', () => {
  it('renders React in jsdom with jest-dom matchers', () => {
    render(<p>ArchipelaGOAT</p>)
    expect(screen.getByText('ArchipelaGOAT')).toBeInTheDocument()
  })

  it('lets tests control matchMedia and notifies change listeners', () => {
    const list = window.matchMedia(REDUCED_MOTION)
    const onChange = vi.fn()
    const onChangeProp = vi.fn()
    list.addEventListener('change', onChange)
    list.onchange = onChangeProp
    expect(list.matches).toBe(false)

    setMediaQuery(REDUCED_MOTION, true)

    expect(list.matches).toBe(true)
    expect(window.matchMedia(REDUCED_MOTION).matches).toBe(true)
    expect(window.matchMedia('(min-width: 1px)').matches).toBe(false)
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ matches: true, media: REDUCED_MOTION }))
    expect(onChangeProp).toHaveBeenCalledOnce()
  })

  it('resets media queries after each test', () => {
    expect(window.matchMedia(REDUCED_MOTION).matches).toBe(false)
  })

  it('stubs ResizeObserver', () => {
    const observer = new ResizeObserver(() => undefined)
    expect(() => {
      observer.observe(document.body)
      observer.unobserve(document.body)
      observer.disconnect()
    }).not.toThrow()
  })

  it('stubs AudioContext enough to synthesize a sound', async () => {
    const audio = new AudioContext()
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    expect(() => {
      oscillator.type = 'square'
      oscillator.frequency.setValueAtTime(440, audio.currentTime)
      gain.gain.setValueAtTime(0.2, audio.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.1)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start()
      oscillator.stop(audio.currentTime + 0.1)
    }).not.toThrow()
    await expect(audio.resume()).resolves.toBeUndefined()
    await audio.close()
    expect(audio.state).toBe('closed')
  })

  it('stubs the canvas 2d context', () => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    expect(ctx).not.toBeNull()
    expect(ctx?.canvas).toBe(canvas)
    expect(() => {
      ctx?.clearRect(0, 0, 10, 10)
      ctx?.fillRect(0, 0, 10, 10)
      ctx?.createLinearGradient(0, 0, 10, 0).addColorStop(0, '#fff')
    }).not.toThrow()
    expect(ctx?.measureText('abc').width).toBeTypeOf('number')
    expect(canvas.getContext('webgl')).toBeNull()
  })
})
