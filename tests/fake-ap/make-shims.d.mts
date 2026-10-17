// Types of make-shims.mjs for the TypeScript tests.

/** tests/fake-ap itself, absolute, with a trailing separator. */
export declare const FAKE_AP_DIR: string

/** Program name → script of tests/fake-ap that plays it. */
export declare const SHIMS: Readonly<Record<string, string>>

/** Writes `<destDir>/<program>.mjs` for every program and returns their paths. */
export declare function makeShims(destDir: string): string[]
