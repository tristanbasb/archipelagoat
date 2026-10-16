// Fails the build when the preload bundle requires anything but electron: with `sandbox: true`,
// Electron only lets a preload require('electron'), so any other require crashes it at startup.
// Usage: node scripts/check-preload.mjs [bundle]  (default: out/preload/index.js)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundle = process.argv[2] ?? fileURLToPath(new URL('../out/preload/index.js', import.meta.url))

let code
try {
  code = readFileSync(bundle, 'utf8')
} catch (error) {
  console.error(`check-preload: cannot read ${bundle}: ${error.message}`)
  process.exit(1)
}

const allowed = new Set(['"electron"', "'electron'"])
// Any `require(`, bundler shims such as `__require(` included.
const forbidden = [...code.matchAll(/require\s*\(([^)]*)\)/g)]
  .filter((match) => !allowed.has(match[1].trim()))
  .map((match) => match[0])

if (forbidden.length > 0) {
  console.error(`check-preload: ${bundle} may only require("electron"), found: ${forbidden.join(', ')}`)
  process.exit(1)
}
console.log(`check-preload: ${bundle} only requires electron`)
