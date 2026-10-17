// Shell state shared between the pieces of the layout.
import { create } from 'zustand'

interface UiState {
  /** A file waiting for the user to say what it is (a dropped or opened .zip). */
  pendingChoice: string | null
  askAbout: (path: string) => void
  clearChoice: () => void
}

export const useUiStore = create<UiState>((set) => ({
  pendingChoice: null,
  askAbout: (path) => set({ pendingChoice: path }),
  clearChoice: () => set({ pendingChoice: null }),
}))
