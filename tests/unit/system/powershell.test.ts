import type { ExecFn, ExecResult } from '@main/core/exec'
import { exec } from '@main/core/exec'
import { encodePowerShell, psQuote, runPowerShell } from '@main/core/system/powershell'

const decode = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le')

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

describe('encodePowerShell', () => {
  it('round-trips as base64 of UTF-16LE', () => {
    const script = "Write-Output 'Jérôme €uro 日本 😀'"
    const encoded = encodePowerShell(script)
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(decode(encoded)).toBe(script)
    expect(Buffer.from(encoded, 'base64')).toEqual(Buffer.from(script, 'utf16le'))
  })
})

describe('runPowerShell', () => {
  const ok: ExecResult = { code: 0, stdout: 'out', stderr: '' }

  it('runs powershell.exe with the fixed flags and the encoded script, UTF-8 output first', async () => {
    const calls: { cmd: string; args: string[]; opts: unknown }[] = []
    const fake: ExecFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return Promise.resolve(ok)
    }
    const result = await runPowerShell(fake, 'Get-Date', { timeoutMs: 5000, cwd: 'C:\\x' })
    expect(result).toEqual(ok)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.cmd).toBe('powershell.exe')
    expect(call?.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ])
    expect(call?.args).toHaveLength(6)
    expect(call?.opts).toEqual({ timeoutMs: 5000, cwd: 'C:\\x' })
    const script = decode(call?.args[5] ?? '')
    expect(script.startsWith('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')).toBe(
      true,
    )
    expect(script.endsWith('\nGet-Date')).toBe(true)
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
