import { useEffect, useEffectEvent } from 'react'

/**
 * Global keyboard shortcuts, written `Ctrl+1`, `Ctrl+Shift+K`… Digits follow the physical key
 * (`event.code`), so Ctrl+1 also works on an AZERTY keyboard where that key types "&".
 */
export function useShortcuts(shortcuts: Record<string, () => void>): void {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return
    const run = shortcuts[comboOf(event)]
    if (!run) return
    event.preventDefault()
    run()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
}

function comboOf(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string {
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1]
  const key = digit ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  return [
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && 'Meta',
    key,
  ]
    .filter(Boolean)
    .join('+')
}
