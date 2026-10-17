// The built app end to end: every screen in French and in English (screenshots in tests/e2e/screenshots),
// a cold start from an archipelago:// link, the keyboard on the home and the wizard, reduced motion,
// and the boot sequence that only plays once.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { FIXTURE_YAMLS } from '../integration/harness'
import { startMockWebhost, type MockWebhost } from '../mock-webhost/server'
import {
  addPlayers,
  checkAndKeepRules,
  createSession,
  fixtureYaml,
  generate,
  goTo,
  hostLocally,
  launchApp,
  openMockRoom,
  overflowingTexts,
  rawTexts,
  removeDirs,
  screenTitle,
  screenshot,
  stopServer,
  translator,
  type Lang,
  type LaunchedApp,
  type LaunchOptions,
  type Translate,
} from './helpers'

let site: MockWebhost
let launches: LaunchedApp[] = []

/** A launch closed and removed after the test, whatever happens. */
async function start(opts: LaunchOptions): Promise<LaunchedApp> {
  const launched = await launchApp(opts)
  launches.push(launched)
  return launched
}

test.beforeEach(async () => {
  site = await startMockWebhost()
})

test.afterEach(async () => {
  for (const launched of launches.reverse()) {
    await launched.close().catch(() => undefined)
    removeDirs(launched.dirs)
  }
  launches = []
  await site.close()
})

/** The screen is clean (no raw key or code, nothing spilling out, no console error), then its picture. */
async function shoot(
  launched: LaunchedApp,
  lang: Lang,
  name: string,
  opts: Parameters<typeof screenshot>[3] = {},
): Promise<void> {
  // Soft: every screen is still visited and pictured, and the test fails at the end with all of them.
  expect.soft(await rawTexts(launched.page), `${name}: untranslated text`).toEqual([])
  expect.soft(await overflowingTexts(launched.page), `${name}: text out of its box`).toEqual([])
  expect.soft(launched.problems.splice(0), `${name}: console errors or CSP violations`).toEqual([])
  await screenshot(launched.page, lang, name, opts)
}

const bootDialog = (page: Page, t: Translate): Locator => page.getByRole('dialog', { name: t('boot.label') })

for (const lang of ['fr', 'en'] as const) {
  test.describe(lang, () => {
    test(`visits every screen without console errors or CSP violations and screenshots it (${lang})`, async () => {
      const t = await translator(lang)

      // First run, Archipelago missing: the boot sequence, the INSERT COIN home, the install screen.
      const first = await start({ lang, fakeAp: false, bootSeen: false, webhostUrl: site.url })
      await expect(bootDialog(first.page, t)).toBeVisible()
      await expect(first.page.getByText(t('common.unofficial'))).toBeVisible()
      await shoot(first, lang, 'boot')
      await first.page.keyboard.press('Enter')
      await expect(bootDialog(first.page, t)).toBeHidden()
      await expect(screenTitle(first.page)).toHaveText(t('nav.home'))
      await expect(first.page.getByText(t('screens.home.coin.title'))).toBeVisible()
      await shoot(first, lang, 'home-no-ap')
      await goTo(first.page, '/install')
      await expect(screenTitle(first.page)).toHaveText(t('screens.install.title'))
      await shoot(first, lang, 'install-no-ap')
      await first.close()

      // The fake Archipelago 0.6.8 installed: every other screen.
      const launched = await start({ lang, fakeAp: true, webhostUrl: site.url })
      const { page } = launched
      await expect(screenTitle(page)).toHaveText(t('nav.home'))
      await expect(page.locator('.home__tiles').getByText('0.6.8')).toBeVisible()
      await shoot(launched, lang, 'home')

      // Each screen, with what shows that it has loaded.
      const screens: [route: string, title: string, name: string, loaded: Locator][] = [
        ['/doctor', t('nav.doctor'), 'doctor', page.getByRole('button', { name: t('screens.doctor.rerun') })],
        [
          '/install',
          t('screens.install.title'),
          'install',
          page.getByText(t('screens.install.state.unchecked.error')),
        ],
        ['/worlds', t('nav.worlds'), 'worlds', page.getByText('TUNIC', { exact: true })],
        ['/studio', t('nav.studio'), 'studio', page.getByText(t('screens.studio.start.title'))],
        ['/vault', t('nav.vault'), 'vault', page.getByText(t('screens.vault.bizhawk.lead'))],
        [
          '/settings',
          t('nav.settings'),
          'settings',
          page.locator('main').getByText(t('shell.status.version', { version: '0.1.0' })),
        ],
      ]
      for (const [route, title, name, loaded] of screens) {
        await goTo(page, route)
        await expect(screenTitle(page)).toHaveText(title)
        await expect(loaded).toBeVisible()
        await shoot(launched, lang, name)
      }

      // The catalog tab: offline here, so it says why it is empty.
      await goTo(page, '/worlds')
      const catalog = page.getByRole('tab', { name: new RegExp(t('screens.worlds.tabs.catalog')) })
      await catalog.click()
      await expect(catalog).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: t('common.retry') })).toBeVisible()
      await shoot(launched, lang, 'worlds-catalog')

      // The studio editing a new YAML, from the fake install's TUNIC template.
      await goTo(page, '/studio')
      await page.getByRole('combobox', { name: t('screens.studio.game.label') }).click()
      await page.getByRole('option', { name: /TUNIC/ }).click()
      await expect(page.getByText(t('screens.studio.game.source.local'))).toBeVisible()
      await shoot(launched, lang, 'studio-editor')

      // Join: a room link of archipelago.gg (read from the mock site), its slots, then one slot's plan.
      const roomId = await openMockRoom(site)
      await goTo(page, '/join')
      await expect(screenTitle(page)).toHaveText(t('nav.join'))
      await shoot(launched, lang, 'join')
      const link = page.getByLabel(t('screens.join.entry.label'))
      await link.fill(`https://archipelago.gg/room/${roomId}`)
      await link.press('Enter')
      await expect(page.getByText(t('screens.join.slots.title'))).toBeVisible()
      await expect(page.getByText('Alice', { exact: true })).toBeVisible()
      await shoot(launched, lang, 'join-room')
      // Bob plays TUNIC, a PC game: no patch, nothing to download.
      await page.getByRole('button', { name: /Bob/ }).click()
      await expect(page.getByText(t('screens.join.checklist.title'))).toBeVisible()
      await shoot(launched, lang, 'join-plan')

      // The organizer's wizard, step by step, then the live game.
      await goTo(page, '/session/new')
      await expect(screenTitle(page)).toHaveText(t('nav.session'))
      await shoot(launched, lang, 'session-new')
      const sessionId = await createSession(page, t, lang === 'fr' ? 'Partie E2E' : 'E2E game')
      await shoot(launched, lang, 'session-players-empty')
      await addPlayers(launched, t, await Promise.all(FIXTURE_YAMLS.map(fixtureYaml)))
      await shoot(launched, lang, 'session-players')
      await checkAndKeepRules(page, t, (step) =>
        shoot(launched, lang, step === 2 ? 'session-check' : 'session-rules'),
      )
      await shoot(launched, lang, 'session-generate-idle')
      await generate(page, t)
      await shoot(launched, lang, 'session-generate')
      await hostLocally(page, t, sessionId)
      // The machine's own network addresses stay out of the pictures.
      const addresses = [
        page.locator('.connection-card__address .copy-field__value'),
        page.locator('.connection-card__preview'),
      ]
      await shoot(launched, lang, 'live', { mask: addresses })
      await stopServer(page, t)
      await shoot(launched, lang, 'live-stopped')

      // Back home: the game is in the recent list, over now that its server stopped.
      await goTo(page, '/')
      const recent = page.locator('.home-recent')
      await expect(recent.getByText(lang === 'fr' ? 'Partie E2E' : 'E2E game')).toBeVisible()
      await expect(recent.getByText(t('screens.home.recent.status.finished'))).toBeVisible()
      await recent.scrollIntoViewIfNeeded()
      await shoot(launched, lang, 'home-recent')
    })
  })
}

test('cold start with an archipelago:// argv lands on /join with the input resolved', async () => {
  const t = await translator('en')
  const { page, problems } = await start({
    lang: 'en',
    fakeAp: true,
    argv: ['archipelago://Goat@127.0.0.1:38281'],
  })
  await expect(page).toHaveURL(/#\/join\?input=archipelago/)
  await expect(screenTitle(page)).toHaveText(t('nav.join'))
  const target = page.locator('.join-target')
  await expect(target.getByText(t('screens.join.target.address'), { exact: true })).toBeVisible()
  await expect(target.getByText('127.0.0.1:38281', { exact: true })).toBeVisible()
  expect(problems).toEqual([])
})

test('keyboard: Tab reaches both player cards and Enter opens wizard', async () => {
  const t = await translator('en')
  const { page, problems } = await start({ lang: 'en', fakeAp: true })
  await expect(screenTitle(page)).toHaveText(t('nav.home'))
  const host = page.locator('.player-card[data-player="1"]')
  const join = page.locator('.player-card[data-player="2"]')

  // From nothing focused, Tab only: the host card comes, then the join card right after it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (let presses = 0; !(await host.evaluate((card) => card === document.activeElement)); presses++) {
    expect(presses, 'Tab presses before the host card').toBeLessThan(30)
    await page.keyboard.press('Tab')
  }
  await expect(host).toBeFocused()
  expect(await host.evaluate((card) => card.matches(':focus-visible'))).toBe(true)
  await page.keyboard.press('Tab')
  await expect(join).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(host).toBeFocused()

  // Enter opens the wizard, where the keyboard names and creates the game.
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/session\/new$/)
  await expect(screenTitle(page)).toHaveText(t('nav.session'))
  const name = page.getByLabel(t('screens.session.new.nameLabel'))
  for (let presses = 0; !(await name.evaluate((input) => input === document.activeElement)); presses++) {
    expect(presses, 'Tab presses before the name field').toBeLessThan(30)
    await page.keyboard.press('Tab')
  }
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Keyboard game')
  await page.keyboard.press('Enter')
  await expect(screenTitle(page)).toHaveText('Keyboard game')
  await expect(page).toHaveURL(/#\/session\/[^?]+\?step=1$/)
  expect(problems).toEqual([])
})

test('reduced motion disables animations', async () => {
  const t = await translator('en')
  const { page, problems } = await start({ lang: 'en', fakeAp: true })
  await expect(screenTitle(page)).toHaveText(t('nav.home'))
  const running = (): Promise<number> =>
    page.evaluate(
      () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
    )
  const card = page.locator('.player-card[data-player="1"]')
  const cta = card.locator('.player-card__cta')

  // The arcade look moves by default: the CRT and, under the pointer, the PRESS START blink.
  await card.hover()
  await expect.poll(running).toBeGreaterThan(0)
  expect(await cta.evaluate((element) => getComputedStyle(element).animationName)).toBe('player-card-blink')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(running).toBe(0)
  expect(await cta.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await expect(page.locator('.crt-overlay')).toBeHidden()

  // A new screen comes in without a transition either.
  await goTo(page, '/worlds')
  await expect(screenTitle(page)).toHaveText(t('nav.worlds'))
  expect(await running()).toBe(0)
  expect(problems).toEqual([])
})

test('second launch skips boot screen', async () => {
  const t = await translator('en')
  const first = await start({ lang: 'en', fakeAp: false, bootSeen: false })
  await expect(bootDialog(first.page, t)).toBeVisible()
  // Left alone, the sequence ends by itself and the app remembers it.
  await expect(bootDialog(first.page, t)).toBeHidden({ timeout: 10_000 })
  const configFile = join(first.dirs.userData, 'config.json')
  await expect
    .poll(() => (JSON.parse(readFileSync(configFile, 'utf8')) as { firstRunDone?: boolean }).firstRunDone)
    .toBe(true)
  await first.close()

  const second = await start({ lang: 'en', fakeAp: false, dirs: first.dirs })
  await expect(screenTitle(second.page)).toHaveText(t('nav.home'))
  // The boot would be up for two seconds from the first frame of the home: it never comes.
  await expect(bootDialog(second.page, t)).toHaveCount(0)
  await second.page.waitForTimeout(500)
  await expect(bootDialog(second.page, t)).toHaveCount(0)
  expect(second.problems).toEqual([])
})

test('the content security policy refuses what it does not list, and the runs see it', async () => {
  const t = await translator('en')
  const { page, problems } = await start({ lang: 'en', fakeAp: false })
  await expect(screenTitle(page)).toHaveText(t('nav.home'))
  expect(problems).toEqual([])
  // An image from a host img-src does not allow: refused before any request, and reported.
  await page.evaluate(() => {
    const image = document.createElement('img')
    image.src = 'https://example.com/goat.png'
    document.body.append(image)
  })
  await expect
    .poll(() => problems.filter((problem) => problem.startsWith('csp: img-src https://example.com/goat.png')))
    .toHaveLength(1)
})
