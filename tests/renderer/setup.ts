import '@testing-library/jest-dom/vitest'

// jsdom lacks several browser APIs the renderer relies on. They are stubbed here, once, for every
// renderer test. Tests drive media queries through `setMediaQuery`.

// --- matchMedia (controllable) ---------------------------------------------------------------

const mediaMatches = new Map<string, boolean>()
const mediaLists = new Set<FakeMediaQueryList>()

class FakeMediaQueryList extends EventTarget {
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null

  constructor(readonly media: string) {
    super()
  }

  get matches(): boolean {
    return mediaMatches.get(this.media) ?? false
  }

  /** @deprecated kept because older libraries still call it */
  addListener(listener: (event: MediaQueryListEvent) => void): void {
    this.addEventListener('change', listener as EventListener)
  }

  /** @deprecated kept because older libraries still call it */
  removeListener(listener: (event: MediaQueryListEvent) => void): void {
    this.removeEventListener('change', listener as EventListener)
  }

  notify(): void {
    const event = Object.assign(new Event('change'), { matches: this.matches, media: this.media })
    this.dispatchEvent(event)
    this.onchange?.call(this, event)
  }
}

/** Sets whether `query` matches, then notifies every `MediaQueryList` created for it. */
export function setMediaQuery(query: string, matches: boolean): void {
  mediaMatches.set(query, matches)
  for (const list of mediaLists) if (list.media === query) list.notify()
}

window.matchMedia = (query: string): MediaQueryList => {
  const list = new FakeMediaQueryList(query)
  mediaLists.add(list)
  return list
}

afterEach(() => {
  mediaMatches.clear()
  mediaLists.clear()
})

// --- ResizeObserver ----------------------------------------------------------------------------

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = FakeResizeObserver

// --- AudioContext ------------------------------------------------------------------------------

class FakeAudioParam {
  constructor(public value: number) {}
  setValueAtTime(): this {
    return this
  }
  linearRampToValueAtTime(): this {
    return this
  }
  exponentialRampToValueAtTime(): this {
    return this
  }
  setTargetAtTime(): this {
    return this
  }
  cancelScheduledValues(): this {
    return this
  }
}

class FakeAudioNode {
  connect<T>(destination: T): T {
    return destination
  }
  disconnect(): void {}
}

class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = 'sine'
  readonly frequency = new FakeAudioParam(440)
  readonly detune = new FakeAudioParam(0)
  onended: (() => void) | null = null
  start(): void {}
  stop(): void {}
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam(1)
}

class FakeAudioContext {
  state: AudioContextState = 'running'
  readonly currentTime = 0
  readonly sampleRate = 44_100
  readonly destination = new FakeAudioNode()
  createOscillator(): FakeOscillatorNode {
    return new FakeOscillatorNode()
  }
  createGain(): FakeGainNode {
    return new FakeGainNode()
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  suspend(): Promise<void> {
    this.state = 'suspended'
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext

// --- Canvas 2d context -------------------------------------------------------------------------

function fakeContext2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const gradient = { addColorStop: (): void => undefined }
  const known: Record<PropertyKey, unknown> = {
    canvas,
    measureText: (text: string) => ({ width: text.length * 8 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => null,
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    isPointInPath: () => false,
  }
  // Every other drawing call (fillRect, arc, drawImage…) is a no-op; style properties are stored.
  return new Proxy(known, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>()

HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, contextId: string) {
  if (contextId !== '2d') return null
  let ctx = contexts.get(this)
  if (!ctx) {
    ctx = fakeContext2d(this)
    contexts.set(this, ctx)
  }
  return ctx
} as typeof HTMLCanvasElement.prototype.getContext
