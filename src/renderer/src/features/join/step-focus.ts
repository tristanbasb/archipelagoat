// Each step of the join flow replaces the one before it (link, preparation, slot, checklist). When the
// step that held the keyboard focus goes away, the new one takes it, so the keyboard carries on where
// the eyes are; a focus held anywhere else is never taken.
import { useEffect, type RefObject } from 'react'

const ATTRIBUTE = 'data-step-focus'

/** Marks the element a step gives the focus to: the first one marked in the page wins. */
export const STEP_FOCUS = { [ATTRIBUTE]: '' } as const

/** The same, for an element that is not focusable by itself (a panel). */
export const STEP_FOCUS_PANEL = { [ATTRIBUTE]: '', tabIndex: -1 } as const

/** Gives the focus to the step marked in `container` each time `step` changes and nothing holds it. */
export function useStepFocus(container: RefObject<HTMLElement | null>, step: string): void {
  useEffect(() => {
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    container.current?.querySelector<HTMLElement>(`[${ATTRIBUTE}]`)?.focus()
  }, [container, step])
}
