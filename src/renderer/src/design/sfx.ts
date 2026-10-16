// 8-bit sound effects synthesized with WebAudio (no audio files). Off until enabled: sounds are off
// by default in the app settings, and EffectsProvider keeps `sfx.enabled` in step with them.

export type SfxName = 'blip' | 'confirm' | 'error' | 'coin' | 'success'

interface Note {
  /** Start frequency in Hz. */
  freq: number
  /** Frequency reached at the end of the note (a slide), if any. */
  to?: number
  /** Seconds. */
  dur: number
  type?: OscillatorType
  /** Peak volume relative to the master volume. */
  vol?: number
}

const SOUNDS: Record<SfxName, Note[]> = {
  // A short tick for focus and ordinary clicks.
  blip: [{ freq: 1046.5, dur: 0.035, vol: 0.6 }],
  // Two rising notes.
  confirm: [
    { freq: 659.25, dur: 0.06 },
    { freq: 987.77, dur: 0.1 },
  ],
  // A low buzz falling down.
  error: [
    { freq: 196, to: 98, dur: 0.12, type: 'sawtooth', vol: 0.7 },
    { freq: 146.83, to: 73.42, dur: 0.2, type: 'sawtooth', vol: 0.7 },
  ],
  // The classic coin: B5 then a held E6.
  coin: [
    { freq: 987.77, dur: 0.07 },
    { freq: 1318.51, dur: 0.28 },
  ],
  // A C major arpeggio, last note held.
  success: [
    { freq: 523.25, dur: 0.07 },
    { freq: 659.25, dur: 0.07 },
    { freq: 783.99, dur: 0.07 },
    { freq: 1046.5, dur: 0.3 },
  ],
}

const MASTER_VOLUME = 0.08
const SILENT = 0.0001

export interface Sfx {
  readonly enabled: boolean
  setEnabled(enabled: boolean): void
  /** Plays a sound; does nothing while disabled or where WebAudio is unavailable. */
  play(name: SfxName): void
}

export function createSfx(): Sfx {
  let enabled = false
  let audio: AudioContext | null = null
  let master: GainNode | null = null

  function output(): { audio: AudioContext; master: GainNode } | null {
    if (!audio || !master) {
      const Context = globalThis.AudioContext as typeof AudioContext | undefined
      if (typeof Context !== 'function') return null
      try {
        audio = new Context()
        master = audio.createGain()
        master.gain.value = MASTER_VOLUME
        master.connect(audio.destination)
      } catch {
        audio = null
        master = null
        return null
      }
    }
    // Contexts made before any user gesture start suspended.
    if (audio.state === 'suspended') void audio.resume().catch(() => undefined)
    return { audio, master }
  }

  return {
    get enabled() {
      return enabled
    },
    setEnabled(next) {
      enabled = next
    },
    play(name) {
      if (!enabled) return
      const out = output()
      if (!out) return
      let at = out.audio.currentTime + 0.01
      for (const note of SOUNDS[name]) {
        const oscillator = out.audio.createOscillator()
        const gain = out.audio.createGain()
        oscillator.type = note.type ?? 'square'
        oscillator.frequency.setValueAtTime(note.freq, at)
        if (note.to !== undefined) oscillator.frequency.exponentialRampToValueAtTime(note.to, at + note.dur)
        gain.gain.setValueAtTime(note.vol ?? 1, at)
        gain.gain.exponentialRampToValueAtTime(SILENT, at + note.dur)
        oscillator.connect(gain).connect(out.master)
        oscillator.start(at)
        oscillator.stop(at + note.dur + 0.02)
        at += note.dur
      }
    },
  }
}

/** The app-wide player. */
export const sfx: Sfx = createSfx()
