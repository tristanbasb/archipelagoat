import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vitest/config'
import type { CacheKeyIdGenerator, CacheKeyIdGeneratorContext, VitestPluginContext } from 'vitest/node'
import config from '../../vitest.config.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

const isPlugin = (option: unknown): option is Plugin =>
  typeof option === 'object' && option !== null && !Array.isArray(option) && 'name' in option

/** The cache key generators the plugins of vitest.config.mts give a project. */
function cacheKeyGenerators(): CacheKeyIdGenerator[] {
  const generators: CacheKeyIdGenerator[] = []
  const ctx: Pick<VitestPluginContext, 'defineCacheKeyGenerator'> = {
    defineCacheKeyGenerator: (generator) => void generators.push(generator),
  }
  for (const plugin of (config.plugins ?? []).filter(isPlugin)) {
    plugin.configureVitest?.call(plugin, ctx as VitestPluginContext)
  }
  return generators
}

/** False when a generator keeps the module out of Vitest's file system module cache. */
const isCached = (id: string, sourceCode: string): boolean =>
  cacheKeyGenerators().every(
    (generate) => generate({ id, sourceCode } as CacheKeyIdGeneratorContext) !== false,
  )

describe('vitest fs module cache', () => {
  // A cached module keeps the file list its import.meta.glob matched when it was cached; Vitest only
  // skips sources that contain the literal `import.meta.glob(`, so `import.meta.glob<T>(` went stale.
  it('never caches a module that uses import.meta.glob, whatever its spelling', () => {
    expect(isCached('typed.ts', "import.meta.glob<{ default: F }>(['./*.ts'], { eager: true })")).toBe(false)
    expect(isCached('plain.ts', "import.meta.glob('./*.service.ts', { eager: true })")).toBe(false)
    expect(isCached('plain.ts', 'export const answer = 42')).toBe(true)
  })

  it('covers every module of src and tests that uses import.meta.glob', () => {
    const sources = ['src', 'tests'].flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.(m?ts|tsx)$/.test(file))
        .map((file) => ({
          name: `${dir}/${file.replaceAll('\\', '/')}`,
          code: readFileSync(join(root, dir, file), 'utf8'),
        })),
    )
    const globbing = sources.filter(({ code }) => /import\.meta\.glob\b/.test(code))
    expect(globbing.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'src/main/ipc/index.ts',
        'src/main/services/index.ts',
        'src/renderer/src/i18n/index.ts',
        'tests/unit/shared/ipc.test.ts',
      ]),
    )
    for (const { name, code } of globbing) expect(isCached(name, code), name).toBe(false)
  })
})
