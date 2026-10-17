import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_CODES, DOCTOR_CHECK_IDS, ERROR_CODES, GENERATE_STAGE_IDS, ISSUE_CODES } from '@shared/codes'
import type { TaskKind, TrustTier } from '@shared/types'
import { resources } from '@renderer/i18n'
import { ERROR_ACTIONS } from '@renderer/lib/errors'
import { TASK_STAGES } from '@renderer/lib/task-stages'

type Tree = { [key: string]: Tree | string }

/** Every leaf of a translation tree, as `a.b.c` → text. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.set(path, value)
    else for (const [leaf, text] of flatten(value, path)) out.set(leaf, text)
  }
  return out
}

const fr = flatten(resources.fr as Tree)
const en = flatten(resources.en as Tree)

function variables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*(\w+)/g)].map((match) => match[1] ?? '').sort()
}

function expectText(key: string): void {
  for (const [lang, table] of [
    ['fr', fr],
    ['en', en],
  ] as const) {
    expect(table.get(key)?.trim(), `${lang}: ${key}`).toBeTruthy()
  }
}

const TASK_KINDS: TaskKind[] = [
  'ap-install',
  'ap-uninstall',
  'templates',
  'world-prepare',
  'generate',
  'webhost-host',
  'join-prepare',
  'rom-scan',
  'bizhawk-install',
]
const TRUST_TIERS: TrustTier[] = ['core', 'indexed-verified', 'wiki-release', 'unknown']

const MAIN_DIR = fileURLToPath(new URL('../../src/main/', import.meta.url))

/** Every stage literal the main process passes to a task's progress(), e.g. progress('inspect', null). */
function mainStageLiterals(): string[] {
  const stages = new Set<string>()
  for (const file of readdirSync(MAIN_DIR, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) continue
    const code = readFileSync(join(MAIN_DIR, file), 'utf8')
    for (const match of code.matchAll(/\bprogress\(\s*['"`]([^'"`]+)['"`]/g)) stages.add(match[1] ?? '')
  }
  return [...stages].sort()
}

describe('i18n resources', () => {
  it('fr.json and en.json have identical key sets', () => {
    expect([...fr.keys()].sort()).toEqual([...en.keys()].sort())
    // The screen files are merged under screens.<folder>, one per screen folder.
    expect(Object.keys(resources.fr.screens).sort()).toEqual(
      [
        'doctor',
        'home',
        'host',
        'install',
        'join',
        'session',
        'settings',
        'studio',
        'vault',
        'worlds',
      ].sort(),
    )
    expect(Object.keys(resources.en.screens).sort()).toEqual(Object.keys(resources.fr.screens).sort())
  })

  it('uses the same interpolation variables in both languages and no empty text', () => {
    for (const [key, text] of fr) {
      expect(text.trim(), `fr: ${key}`).not.toBe('')
      expect(variables(en.get(key) ?? ''), key).toEqual(variables(text))
    }
  })

  it('every ERROR_CODES, ISSUE_CODES, DOCTOR_CHECK_IDS and GENERATE_STAGE_IDS entry has fr and en text', () => {
    for (const code of ERROR_CODES) {
      expectText(`errors.${code}`)
      expectText(`errors.help.${code}`)
    }
    for (const code of ISSUE_CODES) expectText(`issues.${code}`)
    for (const id of DOCTOR_CHECK_IDS) {
      expectText(`doctor.${id}.title`)
      expectText(`doctor.${id}.ok`)
      expectText(`doctor.${id}.problem`)
    }
    for (const id of GENERATE_STAGE_IDS) expectText(`stages.${id}`)
    for (const code of CHECK_CODES) expectText(`checks.${code}`)
    for (const kind of TASK_KINDS) expectText(`tasks.kinds.${kind}`)
    for (const stage of TASK_STAGES) expectText(`taskStages.${stage}`)
    for (const tier of TRUST_TIERS) {
      expectText(`trust.${tier}.label`)
      expectText(`trust.${tier}.description`)
    }
  })

  it('labels every task stage the main process reports', () => {
    const literals = mainStageLiterals()
    // The world inspection's stages, at least, are found.
    expect(literals).toEqual(expect.arrayContaining(['download', 'inspect']))
    for (const stage of literals) expect(TASK_STAGES, `progress('${stage}')`).toContain(stage)
  })

  it('has a label for every error action describeError offers', () => {
    const actions = Object.values(ERROR_ACTIONS)
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) expectText(action.labelKey)
  })
})
