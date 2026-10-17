// Smoke run of the Linux builds of `npm run dist:linux:docker` (spec §7.3, §8), in the same container
// image under Xvfb: tests/e2e/linux-smoke.spec.ts starts linux-unpacked, the installed deb and the
// extracted tar.gz, and asks the AppImage for its version.
// Usage: node scripts/smoke-linux-docker.mjs
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The same two in scripts/build-linux-docker.mjs, which installs these node_modules.
const IMAGE = 'electronuserland/builder:24'
const NODE_MODULES_VOLUME = 'archipelagoat-linux-node-modules'

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

// Xvfb and the libraries Electron needs, plus what the deb depends on, so that `dpkg -i` installs it.
const PACKAGES = [
  'xvfb',
  'libnss3',
  'libgtk-3-0',
  'libgbm1',
  'libasound2',
  'libxss1',
  'libnotify4',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0',
]

const script = [
  'apt-get update',
  `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PACKAGES.join(' ')}`,
  // The node_modules volume of the build; a fresh volume gets its install here.
  '{ [ -d node_modules/@playwright/test ] || npm ci; }',
  'xvfb-run -a npx playwright test tests/e2e/linux-smoke.spec.ts',
].join(' && ')

const args = [
  'run',
  '--rm',
  // An init process as PID 1: xvfb-run waits forever for Xvfb's ready signal when it is PID 1 itself.
  '--init',
  // Chromium's shared memory: the default 64 MB of a container is too small.
  '--shm-size=1g',
  '-e',
  'GOAT_E2E_LINUX_SMOKE=1',
  '-v',
  `${repo}:/project`,
  '-v',
  `${NODE_MODULES_VOLUME}:/project/node_modules`,
  '-w',
  '/project',
  IMAGE,
  'bash',
  '-lc',
  script,
]

console.log(`smoke-linux-docker: docker ${args.join(' ')}`)
const result = spawnSync('docker', args, { stdio: 'inherit' })
if (result.error) {
  console.error(`smoke-linux-docker: cannot run docker (${result.error.message}); is Docker running?`)
  process.exit(1)
}
process.exit(result.status ?? 1)
