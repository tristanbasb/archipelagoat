// What the smoke runs of the packaged builds share (packaged-win.spec.ts, linux-smoke.spec.ts): where
// electron-builder put the artifacts, and the check that a build starts: the home screen over the fake
// Archipelago, then About, which shows a packaged build of the package's version with its license list
// (resources/licenses.json bundled), without an untranslated text or a console error on the way.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import {
  appEnv,
  freshDirs,
  goTo,
  rawTexts,
  removeDirs,
  repoRoot,
  screenTitle,
  type LaunchedApp,
  type Translate,
} from './helpers'

export interface Release {
  /** The `version` of package.json, in every artifact name. */
  version: string
  /** release/<version>/. */
  dir: string
}

export async function release(): Promise<Release> {
  const root = await repoRoot()
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  return { version, dir: join(root, 'release', version) }
}

/**
 * What the build at `exe` prints for `[...args, '--version']`, and its exit code. It runs with the
 * test folders and environment (plus `env`), so that a build that started instead would keep away from
 * the machine's own data; it is stopped after a minute.
 */
export async function versionOf(
  exe: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ stdout: string; status: number | null }> {
  const dirs = await freshDirs({ lang: 'en', fakeAp: false })
  try {
    const result = spawnSync(exe, [...args, '--version'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...(await appEnv(dirs)), ...env },
    })
    return { stdout: result.stdout.trim(), status: result.status }
  } finally {
    removeDirs(dirs)
  }
}

/** The launched build shows the home screen, then About as a packaged build of `version`. */
export async function expectStarts(
  launched: Pick<LaunchedApp, 'page' | 'problems'>,
  t: Translate,
  version: string,
): Promise<void> {
  const { page } = launched
  await expect(screenTitle(page)).toHaveText(t('nav.home'))
  await expect(page.locator('.home__tiles').getByText('0.6.8')).toBeVisible()
  expect(await rawTexts(page)).toEqual([])

  await goTo(page, '/settings')
  await expect(screenTitle(page)).toHaveText(t('nav.settings'))
  const main = page.locator('main')
  await expect(main.getByText(t('shell.status.version', { version }))).toBeVisible()
  await expect(main.getByText(t('screens.settings.about.builds.packaged'), { exact: true })).toBeVisible()
  await expect(main.getByText(t('screens.settings.about.licensesShow'))).toBeVisible()
  expect(await rawTexts(page)).toEqual([])
  expect(launched.problems).toEqual([])
}
