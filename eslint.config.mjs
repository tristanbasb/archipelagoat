import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  // Build output, reports and git-ignored scratch files (.superpowers/: plans, screenshot harnesses;
  // .claude/: agent worktrees, each a full copy of the repository).
  globalIgnores([
    'out/',
    'release/',
    'coverage/',
    'test-results/',
    'playwright-report/',
    '.superpowers/',
    '.claude/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // Plain JS (configs, build scripts, fake AP programs) runs in Node and has no type information.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
)
