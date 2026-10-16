// The only place that builds PowerShell command lines: a script is passed as -EncodedCommand, so
// no quoting layer of cmd.exe, CreateProcess or the PowerShell parser can reinterpret it, and every
// value that goes inside a script is quoted by `psQuote`.
import type { ExecFn, ExecOptions, ExecResult } from '../exec'

/** Base64 of the UTF-16LE script, the format of `powershell.exe -EncodedCommand`. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

// PowerShell reads all of these as a single quote: ' ‘ ’ ‚ ‛ . Inside '…' each must be doubled.
const SINGLE_QUOTES = /['‘’‚‛]/g

/**
 * `value` as a PowerShell literal string: wrapped in single quotes, where `$`, backticks and double
 * quotes are inert, with every kind of apostrophe doubled.
 */
export function psQuote(value: string): string {
  return `'${value.replace(SINGLE_QUOTES, '$&$&')}'`
}

// Without the first line, PowerShell writes its output in the OEM code page and accents turn into
// garbage. The second one keeps progress records (written to stderr as CLIXML) out of the way.
const PRELUDE = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ProgressPreference = 'SilentlyContinue'",
].join('\n')

/** What PowerShell writes to a redirected stderr: `#< CLIXML` followed by an XML document. */
function decodeClixml(stderr: string): string {
  if (!stderr.startsWith('#< CLIXML')) return stderr
  const unescape = (s: string): string =>
    s
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&')
      .replaceAll(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  return [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => unescape(m[1] ?? '')).join('')
}

/**
 * Runs `script` with `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass` and resolves
 * with its exit code and output (UTF-8; stderr as plain text). Rejects like `exec` does.
 */
export async function runPowerShell(exec: ExecFn, script: string, opts?: ExecOptions): Promise<ExecResult> {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowerShell(`${PRELUDE}\n${script}`),
  ]
  const result = await exec('powershell.exe', args, opts)
  return { ...result, stderr: decodeClixml(result.stderr) }
}
