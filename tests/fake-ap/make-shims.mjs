// Writes the fake Archipelago programs into a folder as one-line shims (tests only):
//
//   node tests/fake-ap/make-shims.mjs <destDir>
//
// Each shim is `import "file:///…/tests/fake-ap/<script>.mjs"`: the real script runs from the
// repository, so its imports (yazl) and the captured output it prints resolve from there, wherever
// the shim lives (GOAT_FAKE_AP_DIR, a fake install). The script knows its name from the shim's.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This folder, where the scripts the shims import live (the harness finds the fixtures from it). */
export const FAKE_AP_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Program name → script of this folder that plays it. */
export const SHIMS = {
  ArchipelagoGenerate: 'ArchipelagoGenerate.mjs',
  ArchipelagoServer: 'ArchipelagoServer.mjs',
  ArchipelagoBizHawkClient: 'ArchipelagoClient.mjs',
  ArchipelagoSNIClient: 'ArchipelagoClient.mjs',
  ArchipelagoTextClient: 'ArchipelagoClient.mjs',
  ArchipelagoLauncher: 'ArchipelagoClient.mjs',
  ArchipelagoLauncherDebug: 'ArchipelagoClient.mjs',
}

/** Writes `<destDir>/<program>.mjs` for every program and returns their paths. */
export function makeShims(destDir) {
  mkdirSync(destDir, { recursive: true })
  return Object.entries(SHIMS).map(([name, script]) => {
    const file = join(destDir, `${name}.mjs`)
    writeFileSync(file, `import ${JSON.stringify(new URL(script, import.meta.url).href)}\n`)
    return file
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destDir = process.argv[2]
  if (destDir === undefined) {
    console.error('usage: node tests/fake-ap/make-shims.mjs <destDir>')
    process.exit(2)
  }
  for (const file of makeShims(resolve(destDir))) console.log(file)
}
