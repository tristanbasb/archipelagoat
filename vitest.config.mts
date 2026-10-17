import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vitest/config'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/**
 * Vitest keeps transformed modules on disk between runs (`fsModuleCache`, on by default), keyed by
 * the module's own source. A module that calls import.meta.glob holds the files its pattern matched
 * when it was transformed, so a cached copy misses every file added since (e.g. a new
 * src/main/ipc/<domain>.ts). Vitest skips only sources containing the literal `import.meta.glob(`,
 * which a type argument (`import.meta.glob<T>(`) defeats. This plugin skips every source in which
 * Vite may expand a glob: Vite's own filter is the same substring.
 */
const uncachedImportGlob: Plugin = {
  name: 'goat:uncached-import-glob',
  configureVitest({ defineCacheKeyGenerator }) {
    defineCacheKeyGenerator(({ sourceCode }) => (sourceCode.includes('import.meta.glob') ? false : undefined))
  },
}

export default defineConfig({
  plugins: [uncachedImportGlob],
  resolve: {
    alias: {
      '@shared': fromRoot('./src/shared'),
      '@main': fromRoot('./src/main'),
      '@renderer': fromRoot('./src/renderer/src'),
    },
  },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/main/core/**/*.ts'],
      exclude: ['**/*.d.ts'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.tsx'],
          setupFiles: ['tests/renderer/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
    ],
  },
})
