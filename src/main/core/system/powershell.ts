// The only place that runs PowerShell: a script goes to powershell.exe on its stdin, so no quoting
// layer of cmd.exe, CreateProcess or the PowerShell parser can reinterpret it, and every value that
// goes inside a script is quoted by `psQuote`.
//
// Not as -EncodedCommand: an antivirus (Windows Defender) inspects a new command line when the
// process is created, and CreateProcess, so the whole main process of the app, waits for it. Under
// Electron that took 0.5 to 2.5 s for each script, three times at startup. The command line is now
// the same for every script.
import type { ExecFn, ExecOptions, ExecResult } from '../exec'

/**
 * The fixed `-Command`: reads the whole of stdin as UTF-8 (the console's code page otherwise), then
 * runs it as one script block, so a statement may span lines and `exit` sets the exit code.
 */
export const POWERSHELL_STDIN_COMMAND =
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  '& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'

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
export async function runPowerShell(
  exec: ExecFn,
  script: string,
  opts?: Omit<ExecOptions, 'input'>,
): Promise<ExecResult> {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    POWERSHELL_STDIN_COMMAND,
  ]
  const result = await exec('powershell.exe', args, { ...opts, input: `${PRELUDE}\n${script}` })
  return { ...result, stderr: decodeClixml(result.stderr) }
}
