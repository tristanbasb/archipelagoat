// Whether a « Jeu prêt » dialog is open. While it is, the run it follows ends on its own screen (the
// progress, then « Prêt ! » or the error): no toast says it again. A run whose dialog went away (the
// worlds screen left meanwhile) is told by a toast like any other task.
let openDialogs = 0

/** Marks a dialog open; the function returned marks it closed. */
export function readyDialogOpened(): () => void {
  openDialogs += 1
  let closed = false
  return () => {
    if (closed) return
    closed = true
    openDialogs -= 1
  }
}

export const isReadyDialogOpen = (): boolean => openDialogs > 0
