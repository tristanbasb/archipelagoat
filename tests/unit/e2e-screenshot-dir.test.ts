import { join } from 'node:path'
import { screenshotDir } from '../e2e/screenshot-dir'

describe('E2E screenshot folder', () => {
  const root = join('repo')

  it('writes to the git-ignored test-results/ by default', () => {
    expect(screenshotDir(root, 'fr', {})).toBe(join('repo', 'test-results', 'screenshots', 'fr'))
    expect(screenshotDir(root, 'en', { GOAT_E2E_UPDATE_SCREENSHOTS: '0' })).toBe(
      join('repo', 'test-results', 'screenshots', 'en'),
    )
  })

  it('writes to the committed tests/e2e/screenshots/ only when asked to update them', () => {
    expect(screenshotDir(root, 'en', { GOAT_E2E_UPDATE_SCREENSHOTS: '1' })).toBe(
      join('repo', 'tests', 'e2e', 'screenshots', 'en'),
    )
  })
})
