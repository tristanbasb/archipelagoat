import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/check-preload.mjs', import.meta.url))

describe('scripts/check-preload.mjs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goat-check-preload-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function check(code: string): { status: number | null; stderr: string } {
    const file = join(dir, 'index.js')
    writeFileSync(file, code)
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' })
    return { status: result.status, stderr: result.stderr }
  }

  it('accepts a bundle that only requires electron', () => {
    expect(
      check('"use strict";\nlet electron = require("electron");\nelectron.contextBridge;\n').status,
    ).toBe(0)
  })

  it('rejects a bundle that requires another module and names it', () => {
    const result = check('const electron = require("electron");\nconst zod = require("zod");\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('require("zod")')
  })

  it('rejects node built-ins, which a sandboxed preload cannot load', () => {
    expect(check('const fs = require("node:fs");\n').status).toBe(1)
  })

  it('fails when the bundle is missing', () => {
    const result = spawnSync(process.execPath, [script, join(dir, 'absent.js')], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('absent.js')
  })
})
