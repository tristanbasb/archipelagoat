// The organizer's whole game through the screens of the built app, on the fake Archipelago: the
// players' YAML files picked in the (queued) file dialog, the check, the generation, a local server
// that comes up ready, a console command answered, then the stop that saves the game.
import { readdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { FIXTURE_YAMLS } from '../integration/harness'
import {
  addPlayers,
  checkAndKeepRules,
  createSession,
  fixtureYaml,
  generate,
  hostLocally,
  launchApp,
  removeDirs,
  stopServer,
  translator,
  type LaunchedApp,
} from './helpers'

let launched: LaunchedApp | undefined

test.afterEach(async () => {
  if (!launched) return
  await launched.close().catch(() => undefined)
  removeDirs(launched.dirs)
  launched = undefined
})

/** Every file under `dir` whose name ends with `suffix`. */
function filesEndingWith(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith(suffix))
}

test('organizer flow through UI with fake AP: add yaml via queued dialog, generate, host locally, see ready', async () => {
  const t = await translator('en')
  launched = await launchApp({ lang: 'en', fakeAp: true })
  const { page } = launched

  const sessionId = await createSession(page, t, 'Saturday multiworld')

  // A cancelled dialog adds nothing; the next one picks the four fixture files (five TUNIC players).
  launched.queueDialogs(null)
  await page.getByRole('button', { name: t('screens.session.players.browse') }).click()
  await expect(page.getByText(t('screens.session.players.emptyTitle'))).toBeVisible()
  await addPlayers(launched, t, await Promise.all(FIXTURE_YAMLS.map(fixtureYaml)))
  const roster = page.getByRole('list', { name: t('screens.session.players.listLabel') })
  await expect(roster.locator('.roster-player')).toHaveCount(5)
  for (const name of ['Goat', 'Alice', 'Bob', 'Héloïse', 'Zoé']) {
    await expect(roster.getByText(name, { exact: true })).toBeVisible()
  }
  await expect(page.getByText(t('screens.session.players.count_other', { count: 5 }))).toBeVisible()

  // The check lets the game through with warnings (the Windows-1252 file, among others).
  await checkAndKeepRules(page, t, async (step) => {
    if (step === 2) await expect(page.getByText(t('screens.session.check.readyWarnings'))).toBeVisible()
  })

  // The fake generator writes AP_<seed>.zip with two slots: Alice (a patch) and Bob (none).
  await generate(page, t)
  const slots = page.getByRole('table', { name: t('screens.session.generate.slotsLabel') })
  await expect(slots.getByText('Alice', { exact: true })).toBeVisible()
  await expect(slots.getByText('Bob', { exact: true })).toBeVisible()

  await hostLocally(page, t, sessionId)

  // The console takes a command and shows the server's answer.
  const input = page.getByLabel(t('screens.host.console.input'))
  await input.fill('/players')
  await input.press('Enter')
  await expect(
    page.locator('.console-panel').getByText('0 players of 2 connected', { exact: false }),
  ).toBeVisible()

  // Stopping sends /exit: the server saves the game next to the multidata, then stops.
  await stopServer(page, t)
  expect(filesEndingWith(launched.dirs.dataRoot, '.apsave')).toHaveLength(1)
  expect(launched.problems).toEqual([])
})
