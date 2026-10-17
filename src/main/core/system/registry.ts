// Reads the values of one Windows registry key through PowerShell and .NET, which print them as
// UTF-8 JSON. Not with reg.exe: its output is in the OEM code page (850 on a French Windows), which
// breaks accented paths.
import type { ExecFn } from '../exec'
import { psQuote, runPowerShell } from './powershell'

const HIVES: Record<string, string> = {
  HKLM: 'LocalMachine',
  HKEY_LOCAL_MACHINE: 'LocalMachine',
  HKCU: 'CurrentUser',
  HKEY_CURRENT_USER: 'CurrentUser',
  HKCR: 'ClassesRoot',
  HKEY_CLASSES_ROOT: 'ClassesRoot',
  HKU: 'Users',
  HKEY_USERS: 'Users',
}

const TIMEOUT_MS = 15_000

/** `HKLM\SOFTWARE\X` → the .NET hive name and `SOFTWARE\X`. */
function splitKeyPath(keyPath: string): { hive: string; subKey: string } {
  const separator = keyPath.indexOf('\\')
  const hiveName = (separator === -1 ? keyPath : keyPath.slice(0, separator)).toUpperCase()
  const hive = HIVES[hiveName]
  if (!hive) throw new Error(`unknown registry hive in ${keyPath}`)
  const subKey = separator === -1 ? '' : keyPath.slice(separator + 1).replace(/^\\+|\\+$/g, '')
  if (!subKey) throw new Error(`registry key without a subkey: ${keyPath}`)
  return { hive, subKey }
}

/**
 * Prints `null` when the key does not exist, else a JSON object of its values: the default value
 * under the name '', numbers as text, a multi-string joined with line feeds, binary values left out.
 */
function buildScript(hive: string, subKey: string, view64: boolean): string {
  const view = view64 ? 'Registry64' : 'Registry32'
  return [
    `$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::${hive}, [Microsoft.Win32.RegistryView]::${view})`,
    'try {',
    `  $key = $base.OpenSubKey(${psQuote(subKey)})`,
    "  if ($null -eq $key) { 'null' } else {",
    '    try {',
    '      $values = @{}',
    '      foreach ($name in $key.GetValueNames()) {',
    '        $value = $key.GetValue($name)',
    '        if ($value -is [byte[]]) { continue }',
    '        if ($value -is [array]) { $value = $value -join "`n" }',
    '        $values[$name] = [string]$value',
    '      }',
    '      ConvertTo-Json -InputObject $values -Compress',
    '    } finally { $key.Dispose() }',
    '  }',
    '} finally { $base.Dispose() }',
  ].join('\n')
}

/**
 * The string values of `keyPath` (e.g. `HKLM\SOFTWARE\...`) read in the 64-bit or the 32-bit view;
 * the default value is under the name ''. Null when the key does not exist. Throws when PowerShell
 * fails or prints something else.
 */
export async function readRegistryValues(
  exec: ExecFn,
  keyPath: string,
  opts: { view64: boolean },
): Promise<Record<string, string> | null> {
  const { hive, subKey } = splitKeyPath(keyPath)
  const result = await runPowerShell(exec, buildScript(hive, subKey, opts.view64), { timeoutMs: TIMEOUT_MS })
  if (result.code !== 0) {
    throw new Error(`registry read of ${keyPath} failed (exit ${result.code}): ${result.stderr.trim()}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`unexpected registry output for ${keyPath}: ${result.stdout.slice(0, 200)}`)
  }
  if (parsed === null) return null
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`unexpected registry output for ${keyPath}: ${result.stdout.slice(0, 200)}`)
  }
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}
