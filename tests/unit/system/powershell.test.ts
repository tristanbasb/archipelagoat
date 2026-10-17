import type { ExecFn, ExecOptions, ExecResult } from '@main/core/exec'
import { exec } from '@main/core/exec'
import { POWERSHELL_STDIN_COMMAND, psQuote, runPowerShell } from '@main/core/system/powershell'

describe('psQuote', () => {
  it('wraps the value in single quotes', () => {
    expect(psQuote('C:\\Program Files\\Archipelago\\setup.exe')).toBe(
      "'C:\\Program Files\\Archipelago\\setup.exe'",
    )
    expect(psQuote('')).toBe("''")
  })

  it('doubles straight and curly apostrophes, which PowerShell reads as quotes too', () => {
    expect(psQuote("it's")).toBe("'it''s'")
    expect(psQuote('l‘un et l’autre')).toBe("'l‘‘un et l’’autre'")
    expect(psQuote('a‚b‛c')).toBe("'a‚‚b‛‛c'")
  })

  it('keeps everything else verbatim, so $, ` and " stay inert', () => {
    expect(psQuote('$env:TEMP `n "x" ; calc')).toBe(`'$env:TEMP \`n "x" ; calc'`)
  })
})

describe('runPowerShell', () => {
  const ok: ExecResult = { code: 0, stdout: 'out', stderr: '' }

  function recordingExec(): ExecFn & { calls: { cmd: string; args: string[]; opts?: ExecOptions }[] } {
    const calls: { cmd: string; args: string[]; opts?: ExecOptions }[] = []
    const fake: ExecFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return Promise.resolve(ok)
    }
    return Object.assign(fake, { calls })
  }

  it('runs powershell.exe with the fixed flags and hands it the script on stdin, UTF-8 output first', async () => {
    const fake = recordingExec()
    const result = await runPowerShell(fake, 'Get-Date', { timeoutMs: 5000, cwd: 'C:\\x' })
    expect(result).toEqual(ok)
    expect(fake.calls).toHaveLength(1)
    const [call] = fake.calls
    expect(call?.cmd).toBe('powershell.exe')
    expect(call?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      POWERSHELL_STDIN_COMMAND,
    ])
    const { input, ...opts } = call?.opts ?? {}
    expect(opts).toEqual({ timeoutMs: 5000, cwd: 'C:\\x' })
    expect(input?.startsWith('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')).toBe(
      true,
    )
    expect(input?.endsWith('\nGet-Date')).toBe(true)
  })

  // An antivirus inspects a new command line when the process is created, and CreateProcess (so the
  // whole main process) waits for it: half a second to seconds for each -EncodedCommand script seen
  // under Electron. The command line stays the same whatever the script.
  it('never puts the script on the command line: it is the same for every script', async () => {
    const fake = recordingExec()
    await runPowerShell(fake, `Write-Output ${psQuote('Jérôme')}`)
    await runPowerShell(fake, 'exit 3')
    expect(fake.calls[0]?.args).toEqual(fake.calls[1]?.args)
    expect(fake.calls[0]?.args.join(' ')).not.toMatch(/Jérôme|EncodedCommand/)
    expect(POWERSHELL_STDIN_COMMAND).toContain(
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    )
  })

  it('turns a CLIXML error stream into plain text', async () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">bad &lt;value&gt; &amp; é_x000D__x000A_</S><S S="Error">at line 1_x000D__x000A_</S></Objs>'
    const fake: ExecFn = () => Promise.resolve({ code: 1, stdout: '', stderr: clixml })
    expect(await runPowerShell(fake, 'throw')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'bad <value> & é\r\nat line 1\r\n',
    })
  })

  it('leaves a plain stderr alone', async () => {
    const fake: ExecFn = () => Promise.resolve({ code: 2, stdout: '', stderr: 'plain failure' })
    expect((await runPowerShell(fake, 'x')).stderr).toBe('plain failure')
  })

  it('passes a null exit code (killed) through', async () => {
    const fake: ExecFn = () => Promise.resolve({ code: null, stdout: '', stderr: '' })
    expect((await runPowerShell(fake, 'x')).code).toBeNull()
  })

  describe.skipIf(process.platform !== 'win32')('with the real powershell.exe', () => {
    it('returns accented and non-BMP output as clean UTF-8, and a quiet stderr', async () => {
      const result = await runPowerShell(exec, `Write-Output ${psQuote('Jérôme €uro 日本 😀 l’un')}`, {
        timeoutMs: 60_000,
      })
      expect(result).toEqual({ code: 0, stdout: 'Jérôme €uro 日本 😀 l’un\r\n', stderr: '' })
    })

    it('reports the exit code and a readable error', async () => {
      const result = await runPowerShell(exec, "Write-Error 'boom é'; exit 7", { timeoutMs: 60_000 })
      expect(result.code).toBe(7)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('boom é')
      expect(result.stderr).not.toContain('CLIXML')
    })

    it('does not let a quoted value break out of its string', async () => {
      const hostile = "x'; Write-Output 'pwned'; '"
      const result = await runPowerShell(exec, `Write-Output ${psQuote(hostile)}`, { timeoutMs: 60_000 })
      expect(result.stdout).toBe(`${hostile}\r\n`)
    })
  })
})
