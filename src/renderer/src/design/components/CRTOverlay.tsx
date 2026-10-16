import { useEffectsPrefs } from '../useEffectsPrefs'

/**
 * The CRT screen over the whole window: scanlines, vignette and a rolling band. Never takes the
 * pointer; not rendered when the CRT effect is off. Its styles live in effects.css.
 */
export function CRTOverlay(): React.JSX.Element | null {
  const { crt } = useEffectsPrefs()
  if (!crt) return null
  return <div className="crt-overlay crt scanlines" aria-hidden="true" style={{ pointerEvents: 'none' }} />
}
