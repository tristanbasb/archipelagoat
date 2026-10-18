// « Jeu prêt » on the built app, offline, on the fake Archipelago: from a catalog card of a core game (a
// saved catalog and its covers seeded in the dataRoot, see seed-catalog.ts) to a session that holds the
// player's YAML, then the Checks panel measuring it. FR and EN, with the 0.2 screenshots (the catalog
// with covers, the dialog, the end screen, the Checks panel) in test-results/screenshots, or in the
// committed tests/e2e/screenshots with GOAT_E2E_UPDATE_SCREENSHOTS=1.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  goTo,
  launchApp,
  overflowingTexts,
  rawTexts,
  removeDirs,
  screenTitle,
  screenshot,
  translator,
  type Lang,
  type LaunchedApp,
} from './helpers'
import { SEEDED_GAMES } from './seed-catalog'

const GAME = 'TUNIC'
const PLAYER = 'Goat'
/** What the fake ArchipelagoGenerate gives every TUNIC document it measures. */
const CHECKS = 122

let launched: LaunchedApp | undefined

test.afterEach(async () => {
  if (!launched) return
  await launched.close().catch(() => undefined)
  removeDirs(launched.dirs)
  launched = undefined
})

/** The screen is clean (no raw key or code, nothing spilling out, no console error), then its picture. */
async function shoot(
  app: LaunchedApp,
  lang: Lang,
  name: string,
  opts: Parameters<typeof screenshot>[3] = {},
): Promise<void> {
  // Soft: every picture is still taken, and the test fails at the end with all the problems.
  expect.soft(await rawTexts(app.page), `${name}: untranslated text`).toEqual([])
  expect.soft(await overflowingTexts(app.page), `${name}: text out of its box`).toEqual([])
  expect.soft(app.problems.splice(0), `${name}: console errors or CSP violations`).toEqual([])
  await screenshot(app.page, lang, name, opts)
}

for (const lang of ['fr', 'en'] as const) {
  test(`Jeu prêt on a core game with the fake Archipelago ends in a session with the player's YAML (${lang})`, async () => {
    const t = await translator(lang)
    const r = (key: string, params?: Record<string, string | number>): string =>
      t(`screens.worlds.ready.${key}`, params)
    const sessionName = lang === 'fr' ? 'Partie prête' : 'Ready game'
    launched = await launchApp({ lang, fakeAp: true, catalog: true, fakeChecks: { [GAME]: CHECKS } })
    const app = launched
    const { page } = app

    // The catalog opens from the saved copy, with the covers of the cache shown through goat-cover://.
    await goTo(page, '/worlds')
    await expect(screenTitle(page)).toHaveText(t('nav.worlds'))
    await page.getByRole('tab', { name: new RegExp(t('screens.worlds.tabs.catalog')) }).click()
    const grid = page.getByRole('list', { name: t('screens.worlds.catalog.listLabel') })
    await expect(grid.getByRole('article')).toHaveCount(SEEDED_GAMES.length)
    const pictures = grid.locator('.game-cover[data-state="image"] img')
    await expect(pictures).toHaveCount(SEEDED_GAMES.length)
    await expect
      .poll(() =>
        pictures.evaluateAll((images) =>
          images.map((image) => {
            const picture = image as HTMLImageElement
            return picture.src.startsWith('goat-cover://') && picture.complete && picture.naturalWidth > 0
          }),
        ),
      )
      .toEqual(SEEDED_GAMES.map(() => true))
    // The picture says when the copy was made: that moves with the clock.
    await shoot(app, lang, 'catalog-covers', { mask: [page.locator('.worlds-catalog__fetched')] })

    // « Jeu prêt » on the TUNIC card: a core world, so no consent and nothing to install.
    await grid
      .getByRole('article', { name: GAME, exact: true })
      .getByRole('button', { name: r('openFor', { game: GAME }) })
      .click()
    const dialog = page.getByRole('dialog', { name: r('title', { game: GAME }) })
    const prepare = dialog.getByRole('button', { name: r('prepare'), exact: true })
    await expect(prepare).toBeEnabled()
    await expect(dialog.getByRole('radiogroup', { name: r('profile.label') })).toBeVisible()
    await dialog.getByLabel(r('name.label')).fill(PLAYER)
    // No session being prepared yet: the YAML goes to a new one.
    await dialog.getByLabel(r('destination.newName')).fill(sessionName)
    await shoot(app, lang, 'ready-dialog')

    await prepare.click()
    // The end screen: Standard, measured by the fake generation, in the session just made.
    await expect(dialog.getByRole('heading', { name: r('done.title') })).toBeVisible({ timeout: 90_000 })
    await expect(dialog.getByText(r('done.session', { name: sessionName }))).toBeVisible()
    await expect(
      dialog.getByText(
        r('done.summary', {
          profile: t('profiles.names.standard'),
          checks: t('profiles.checks_other', { count: CHECKS }),
        }),
      ),
    ).toBeVisible()
    // What the plan says to know: the wiki lists a PopTracker pack and a setup guide for TUNIC.
    await expect(dialog.getByText(r('notes.popTracker'), { exact: true })).toBeVisible()
    await expect(dialog.getByText(r('notes.guide'), { exact: true })).toBeVisible()
    await shoot(app, lang, 'ready-done')

    // The session holds the player's YAML.
    await dialog.getByRole('button', { name: r('done.openSession') }).click()
    await expect(page).toHaveURL(/#\/session\/[^?]+\?step=1$/)
    const sessionId = /#\/session\/([^?]+)\?step=1$/.exec(page.url())?.[1]
    if (!sessionId) throw new Error(`not on a session: ${page.url()}`)
    await expect(screenTitle(page)).toHaveText(sessionName)
    await expect(page.locator('.roster-player')).toHaveCount(1)
    await expect(page.locator('.roster-player__name')).toHaveText(PLAYER)
    await expect(page.locator('.roster-player__games')).toContainText(GAME)
    const playersDir = join(app.dirs.dataRoot, 'sessions', sessionId, 'players')
    const files = readdirSync(playersDir)
    expect(files).toHaveLength(1)
    const yaml = readFileSync(join(playersDir, files[0] ?? ''), 'utf8')
    expect(yaml).toMatch(new RegExp(`^name: ${PLAYER}$`, 'm'))
    expect(yaml).toMatch(new RegExp(`^game: ${GAME}$`, 'm'))
    expect(yaml).toMatch(new RegExp(`^${GAME}:`, 'm'))

    // The Checks panel measures that file with the fake generation.
    await page.getByRole('button', { name: t('screens.session.nav.next'), exact: true }).click()
    await expect(page.getByText(t('screens.session.check.readyTitle'), { exact: true })).toBeVisible()
    await page.getByRole('button', { name: t('screens.session.checksPanel.measure') }).click()
    const row = page.locator('.checks-row')
    await expect(row.locator('.checks-row__value')).toHaveText(String(CHECKS), { timeout: 60_000 })
    await expect(row.locator('.checks-row__note')).toHaveText(t('screens.session.checksPanel.source.measure'))
    // Centered: the panel clears the sticky step bar at the bottom of the window.
    await row.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await shoot(app, lang, 'checks-panel')
  })
}
