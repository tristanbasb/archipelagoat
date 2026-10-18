// Types of make-patch.mjs for the TypeScript tests.

export declare const EMERALD_MD5: string

export interface SeedSlot {
  name: string
  game: string
  /** How many locations the slot has, in its multidata and its spoiler. Default: 100. */
  checks?: number
  /** Extension of the slot's patch file, e.g. `.apemerald`; none for a game without one. */
  patch?: string
  /** `archipelago.json` fields over the defaults. */
  manifest?: Record<string, unknown>
}

export declare function patchManifest(fields?: Record<string, unknown>): Record<string, unknown>

export declare function makePatchZip(
  dest: string,
  manifest: Record<string, unknown> | string | null,
  extraEntries?: Record<string, string | Uint8Array>,
): Promise<string>

export declare function makeSeedZip(dest: string, opts: { seed: string; slots: SeedSlot[] }): Promise<string>
