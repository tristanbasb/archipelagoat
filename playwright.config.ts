// The E2E runs (`npm run test:e2e`, after `npm run build`): the built app under Playwright's Electron
// support, one app at a time. The smoke runs of the packaged builds (Task 35) only run when their own
// variable is set: GOAT_E2E_LINUX_SMOKE for linux-smoke.spec.ts, GOAT_E2E_PACKAGED for packaged-win.spec.ts.
import { defineConfig } from '@playwright/test'

const GATED: readonly (readonly [file: string, variable: string])[] = [
  ['linux-smoke.spec.ts', 'GOAT_E2E_LINUX_SMOKE'],
  ['packaged-win.spec.ts', 'GOAT_E2E_PACKAGED'],
]

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  testIgnore: GATED.filter(([, variable]) => !process.env[variable]).map(([file]) => `**/${file}`),
  // Each launch has its own folders, but the machine has one screen, one set of ports and one CPU budget.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
