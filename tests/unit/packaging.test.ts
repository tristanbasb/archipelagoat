// The packaging configuration (spec §8): electron-builder.yml, and the npm scripts that build each
// artifact. The builds themselves are checked by the packaged smoke runs (tests/e2e/packaged-win.spec.ts
// and tests/e2e/linux-smoke.spec.ts).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url))

type Json = Record<string, unknown>

const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8')) as Json & {
  scripts: Record<string, string>
}
const config = parse(readFileSync(root('electron-builder.yml'), 'utf8')) as Json

const section = (name: string): Json => config[name] as Json

describe('electron-builder.yml', () => {
  it('identifies the app and packs the build output into an asar, without source maps', () => {
    expect(config.appId).toBe('com.archipelagoat.app')
    expect(config.productName).toBe('ArchipelaGOAT')
    expect(config.asar).toBe(true)
    expect(section('directories').output).toBe('release/${version}')
    expect(config.files).toContain('out/**/*')
    expect(config.files).toContain('!**/*.map')
  })

  it('keeps out of the asar the packages the renderer bundle already holds, never one the main process loads', () => {
    const files = config.files as string[]
    expect(files).toContain('!node_modules/react-dom/**')
    expect(files).toContain('!node_modules/@tabler/**')
    // What out/main/index.js requires at runtime, and electron-updater.
    for (const name of [
      'zod',
      'yaml',
      'tar',
      'yauzl',
      'yazl',
      'semver',
      'smol-toml',
      'tough-cookie',
      'p-limit',
    ]) {
      expect(files.some((pattern) => pattern.startsWith(`!node_modules/${name}/`))).toBe(false)
    }
    expect(files.some((pattern) => pattern.includes('electron-updater'))).toBe(false)
  })

  it('declares the archipelago:// protocol', () => {
    expect(config.protocols).toEqual([{ name: 'Archipelago', schemes: ['archipelago'] }])
  })

  it('builds a per-user NSIS installer with a choice of folder, and a portable exe', () => {
    expect(section('win').target).toEqual(['nsis', 'portable'])
    expect(section('nsis')).toMatchObject({
      perMachine: false,
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      artifactName: 'ArchipelaGOAT-Setup-${version}.${ext}',
    })
    expect(section('portable').artifactName).toBe('ArchipelaGOAT-${version}-portable.${ext}')
  })

  it('builds an AppImage, a deb and a tar.gz in the Game category', () => {
    const linux = section('linux')
    expect(linux.target).toEqual(['AppImage', 'deb', 'tar.gz'])
    expect(linux.category).toBe('Game')
    // The protocols give the .desktop its x-scheme-handler/archipelago type (checked in the deb by
    // tests/e2e/linux-smoke.spec.ts); a `mimeTypes` list would repeat it once per target.
    expect(linux).not.toHaveProperty('mimeTypes')
    expect(linux.executableName).toBe('archipelagoat')
    expect(linux.artifactName).toBe('ArchipelaGOAT-${version}.${ext}')
    expect(section('deb').artifactName).toBe('archipelagoat_${version}_${arch}.${ext}')
  })

  it('leaves publishing to the release workflow, so a local build has no app-update.yml', () => {
    // electron-builder resolves a `github` provider from the git remote; without one (every local
    // build) it fails on the update info and writes a broken app-update.yml.
    expect(config).not.toHaveProperty('publish')
  })
})

describe('.github/workflows/release.yml', () => {
  const workflow = readFileSync(root('.github/workflows/release.yml'), 'utf8')
  type Job = { needs?: string; strategy?: { matrix: Json }; steps: { run?: string }[] }
  const release = parse(workflow) as { on: { push: { tags: string[] } }; jobs: Record<string, Job> }
  const runs = Object.values(release.jobs).flatMap((job) => job.steps.flatMap((step) => step.run ?? []))
  const runsOf = (name: string): string =>
    (release.jobs[name]?.steps ?? []).map((s) => s.run ?? '').join('\n')

  it('runs on v* tags, on Windows and Linux', () => {
    expect(release.on.push.tags).toEqual(['v*'])
    expect(release.jobs.release?.strategy?.matrix).toMatchObject({
      os: ['windows-latest', 'ubuntu-latest'],
    })
  })

  it('creates the draft once, before both builds publish into it', () => {
    expect(runsOf('draft')).toMatch(/gh release create "\$GITHUB_REF_NAME" --draft --verify-tag/)
    expect(release.jobs.release?.needs).toBe('draft')
  })

  it('adds the SHA256SUMS.txt the README promises, once both builds are in the draft', () => {
    const checksums = release.jobs.checksums
    expect(checksums?.needs).toBe('release')
    const steps = runsOf('checksums')
    expect(steps).toMatch(/gh release download "\$GITHUB_REF_NAME" --dir dist/)
    for (const pattern of ['*.exe', '*.AppImage', '*.deb', '*.tar.gz'])
      expect(steps).toContain(`'${pattern}'`)
    expect(steps).toContain('node scripts/checksums.mjs dist')
    expect(steps).toMatch(/gh release upload "\$GITHUB_REF_NAME" dist\/SHA256SUMS\.txt/)
  })

  it('publishes the artifacts to a draft GitHub release', () => {
    const publish = runs.filter((run) => run.includes('electron-builder'))
    expect(publish.length).toBeGreaterThan(0)
    for (const run of publish) {
      expect(run).toContain('--publish always')
      expect(run).toContain('-c.publish.provider=github')
      expect(run).toContain('-c.publish.releaseType=draft')
    }
  })
})

describe('package.json', () => {
  it('leaves the electron-builder configuration to electron-builder.yml', () => {
    expect(pkg).not.toHaveProperty('build')
  })

  it('gives the deb the homepage and the maintainer electron-builder requires', () => {
    // A placeholder on a reserved domain (RFC 2606) until the repository is public: it can never
    // lead anywhere, unlike a guessed address.
    expect(pkg.homepage).toBe('https://archipelagoat.invalid')
    expect(section('linux').maintainer).toBe('ArchipelaGOAT contributors')
  })

  it('writes resources/licenses.json before the renderer bundle imports it', () => {
    expect(pkg.scripts.licenses).toBe('node scripts/licenses.mjs')
    expect(pkg.scripts.build).toMatch(/^npm run licenses && electron-vite build/)
  })

  it('has a script for each artifact, the icons and the checksums', () => {
    expect(pkg.scripts).toMatchObject({
      icons: 'node scripts/make-icons.mjs',
      'dist:win': 'npm run build && electron-builder --win --publish never',
      'dist:linux': 'npm run build && electron-builder --linux --publish never',
      'dist:linux:docker': 'node scripts/build-linux-docker.mjs',
      checksums: 'node scripts/checksums.mjs',
    })
  })
})
