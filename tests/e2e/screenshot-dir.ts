// Where the E2E runs write their screenshots. The committed ones (tests/e2e/screenshots/<lang>/, which
// the README picks from) only change when asked: GOAT_E2E_UPDATE_SCREENSHOTS=1. Every other run writes
// to the git-ignored test-results/screenshots/<lang>/, so a run leaves the work tree clean.
import { join } from 'node:path'

export function screenshotDir(root: string, lang: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.GOAT_E2E_UPDATE_SCREENSHOTS === '1'
    ? join(root, 'tests', 'e2e', 'screenshots', lang)
    : join(root, 'test-results', 'screenshots', lang)
}
