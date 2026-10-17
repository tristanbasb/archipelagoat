// Builds the Linux artifacts (AppImage, deb, tar.gz) in the electronuserland/builder container, from any
// system with Docker (spec §8): `npm run dist:linux:docker`. Artifacts in release/<version>/.
//
// The repository is mounted at /project, but its node_modules is a named volume: the container
// installs Linux binaries there (rolldown, sharp…) and never mixes them with the host's.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The same two in scripts/smoke-linux-docker.mjs, which runs the tests with these node_modules.
const IMAGE = 'electronuserland/builder:24'
const NODE_MODULES_VOLUME = 'archipelagoat-linux-node-modules'

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

const args = [
  'run',
  '--rm',
  '-v',
  `${repo}:/project`,
  '-v',
  `${NODE_MODULES_VOLUME}:/project/node_modules`,
  '-w',
  '/project',
  IMAGE,
  'bash',
  '-lc',
  'npm ci && npm run build && npx electron-builder --linux',
]

console.log(`build-linux-docker: docker ${args.join(' ')}`)
const result = spawnSync('docker', args, { stdio: 'inherit' })
if (result.error) {
  console.error(`build-linux-docker: cannot run docker (${result.error.message}); is Docker running?`)
  process.exit(1)
}
process.exit(result.status ?? 1)
