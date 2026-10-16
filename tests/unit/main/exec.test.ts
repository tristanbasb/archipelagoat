import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '@main/core/exec'

const node = process.execPath

describe('exec', () => {
  it('captures stdout, stderr and the exit code as UTF-8', async () => {
    const result = await exec(node, [
      '-e',
      'process.stdout.write("Jérôme ok"); process.stderr.write("warn"); process.exitCode = 3',
    ])
    expect(result).toEqual({ code: 3, stdout: 'Jérôme ok', stderr: 'warn' })
  })

  it('passes arguments verbatim, without a shell', async () => {
    const args = ['a b', '$HOME', '%PATH%', '&echo hacked', '"quoted"']
    const result = await exec(node, [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      ...args,
    ])
    expect(JSON.parse(result.stdout)).toEqual(args)
  })

  it('honours cwd and env', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goat exec é-'))
    try {
      const result = await exec(
        node,
        ['-e', 'process.stdout.write(process.cwd() + "|" + process.env.GOAT_PROBE)'],
        {
          cwd,
          env: { ...process.env, GOAT_PROBE: 'yes' },
        },
      )
      expect(result.stdout).toBe(`${cwd}|yes`)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects with PROCESS_TIMEOUT when the timeout fires', async () => {
    await expect(exec(node, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 200 })).rejects.toThrow(
      /PROCESS_TIMEOUT/,
    )
  })

  it('rejects when the program cannot be started', async () => {
    await expect(exec('goat-definitely-not-a-program', [])).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
