// Types of make-pickle.mjs for the TypeScript tests.

/** What `unpickle` returns (`PickleValue`), plus `{ reduce }`: an object made by REDUCE, not NEWOBJ. */
export type PickleSource =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | PickleSource[]
  | { tuple: PickleSource[] }
  | Map<PickleSource, PickleSource>
  | Set<PickleSource>
  | { global: { module: string; name: string } }
  | { object: { class: PickleSource; args: PickleSource; state: PickleSource } }
  | { reduce: { class: PickleSource; args: PickleSource } }

/** The protocol 4 pickle of `value`. */
export declare function pickle(value: PickleSource): Buffer

export interface MultidataSlot {
  name: string
  game: string
  /** How many locations the slot has. */
  checks: number
}

/** A `.archipelago`: the format byte 3, then the zlib of a pickle with `locations`, `slot_info`, `connect_names` and `datapackage`. */
export declare function pickleMultidata(input: { slots: MultidataSlot[] }): Buffer
