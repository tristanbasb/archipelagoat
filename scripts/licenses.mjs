// Writes resources/licenses.json, the licenses the About panel lists (src/renderer/src/features/settings/
// licenses.ts imports it when the renderer is bundled, so `npm run build` runs this script first).
// Usage: node scripts/licenses.mjs [package-lock.json] [out]
//
// The list comes from the lockfile, so it is the same on every machine: every package the app ships,
// as [{ name, version, license }] sorted by name then version. Shipped means a runtime dependency,
// direct or not (the renderer's are bundled, the main process's are packed in the asar), plus
// Electron itself, a devDependency that is the runtime of every build. Build and test tools are not
// shipped: npm flags them `dev` (or `devOptional`, an optional peer that only a dev package needs).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const lockFile = process.argv[2] ?? root('package-lock.json')
const outFile = process.argv[3] ?? root('resources/licenses.json')

/** Shipped although npm sees a devDependency. */
const RUNTIME_DEV_PACKAGES = new Set(['electron'])

function fail(message) {
  console.error(`licenses: ${message}`)
  process.exit(1)
}

let lock
try {
  lock = JSON.parse(readFileSync(lockFile, 'utf8'))
} catch (error) {
  fail(`cannot read ${lockFile}: ${error.message}`)
}
if (![2, 3].includes(lock?.lockfileVersion) || typeof lock.packages !== 'object') {
  fail(`${lockFile} is not a package-lock.json of version 2 or 3`)
}

const entries = new Map()
for (const [path, info] of Object.entries(lock.packages)) {
  // '' is the app itself; a link points at a local folder, not a package.
  if (!path || info.link) continue
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const shipped = !(info.dev || info.devOptional) || RUNTIME_DEV_PACKAGES.has(name)
  if (!shipped || typeof info.version !== 'string') continue
  const license = typeof info.license === 'string' && info.license.trim() ? info.license.trim() : null
  entries.set(`${name}@${info.version}`, { name, version: info.version, license })
}

const list = [...entries.values()].sort((a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
)
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify(list, null, 2)}\n`)
console.log(`licenses: ${list.length} packages in ${outFile}`)
