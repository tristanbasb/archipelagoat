import type { ExecFn, ExecOptions, ExecResult } from '@main/core/exec'
import { readRegistryValues } from '@main/core/system/registry'
import { AP_UNINSTALL_KEY } from '@shared/data/ap-constants'

// What the PowerShell script prints for the uninstall key of an install in an accented folder.
const JSON_SAMPLE = JSON.stringify({
  InstallLocation: 'D:\\Jeux\\Archipélago\\',
  DisplayName: 'Archipelago 0.6.8',
  'Inno Setup: App Path': 'D:\\Jeux\\Archipélago',
})
const KEY = AP_UNINSTALL_KEY

interface Call {
  cmd: string
  args: string[]
  opts?: ExecOptions
}

function fakeExec(stdout: string, result: Partial<ExecResult> = {}): ExecFn & { calls: Call[] } {
  const calls: Call[] = []
  const fn: ExecFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return Promise.resolve({ code: 0, stdout, stderr: '', ...result })
  }
  return Object.assign(fn, { calls })
}

/** The script a call ran: what runPowerShell writes to its stdin. */
const scriptOf = (call: Call | undefined): string => call?.opts?.input ?? ''

describe('readRegistryValues', () => {
  it('readRegistryValues decodes UTF-8 JSON with accented InstallLocation', async () =>
    expect((await readRegistryValues(fakeExec(JSON_SAMPLE), KEY, { view64: true }))?.InstallLocation).toBe(
      'D:\\Jeux\\Archipélago\\',
    ))

  it('returns every string value, the default one under the empty name', async () => {
    const exec = fakeExec('{"":"\\"C:\\\\AP\\\\ArchipelagoLauncher.exe\\" \\"%1\\"","URL Protocol":""}\r\n')
    expect(await readRegistryValues(exec, 'HKLM\\SOFTWARE\\Classes\\archipelago', { view64: true })).toEqual({
      '': '"C:\\AP\\ArchipelagoLauncher.exe" "%1"',
      'URL Protocol': '',
    })
  })

  it('opens the key through OpenBaseKey in the 64-bit view, with the subkey quoted', async () => {
    const exec = fakeExec(JSON_SAMPLE)
    await readRegistryValues(exec, KEY, { view64: true })
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0]?.cmd).toBe('powershell.exe')
    const script = scriptOf(exec.calls[0])
    expect(script).toContain(
      '[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, ' +
        '[Microsoft.Win32.RegistryView]::Registry64)',
    )
    expect(script).toContain(
      ".OpenSubKey('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" +
        "{918BA46A-FAB8-460C-9DFF-AE691E1C865B}_is1')",
    )
    expect(script).toContain('ConvertTo-Json')
  })

  it('uses the 32-bit view when asked and doubles apostrophes in the subkey', async () => {
    const exec = fakeExec('{}')
    expect(await readRegistryValues(exec, "HKCU\\Software\\O'Neil", { view64: false })).toEqual({})
    const script = scriptOf(exec.calls[0])
    expect(script).toContain('[Microsoft.Win32.RegistryHive]::CurrentUser')
    expect(script).toContain('[Microsoft.Win32.RegistryView]::Registry32')
    expect(script).toContain(".OpenSubKey('Software\\O''Neil')")
  })

  it('accepts the long hive names and HKCR / HKU', async () => {
    const cases: [string, string][] = [
      ['HKEY_LOCAL_MACHINE\\SOFTWARE\\X', 'LocalMachine'],
      ['HKEY_CURRENT_USER\\Software\\X', 'CurrentUser'],
      ['HKCR\\archipelago', 'ClassesRoot'],
      ['HKEY_CLASSES_ROOT\\archipelago', 'ClassesRoot'],
      ['HKU\\.DEFAULT', 'Users'],
      ['hklm\\SOFTWARE\\X', 'LocalMachine'],
    ]
    for (const [key, hive] of cases) {
      const exec = fakeExec('null')
      await readRegistryValues(exec, key, { view64: true })
      expect(scriptOf(exec.calls[0]), key).toContain(`[Microsoft.Win32.RegistryHive]::${hive}`)
    }
  })

  it('refuses an unknown hive or a key without a subkey, without running anything', async () => {
    const exec = fakeExec('{}')
    await expect(readRegistryValues(exec, 'HKXX\\Software', { view64: true })).rejects.toThrow(/hive/)
    await expect(readRegistryValues(exec, 'HKLM', { view64: true })).rejects.toThrow(/subkey/)
    expect(exec.calls).toHaveLength(0)
  })

  it('returns null when the key does not exist', async () => {
    expect(await readRegistryValues(fakeExec('null\r\n'), KEY, { view64: true })).toBeNull()
  })

  it('keeps string values only', async () => {
    const exec = fakeExec('{"a":"x","b":1,"c":null}')
    expect(await readRegistryValues(exec, KEY, { view64: true })).toEqual({ a: 'x' })
  })

  it('throws when PowerShell fails, with its error output', async () => {
    const exec = fakeExec('', { code: 1, stderr: 'Accès refusé' })
    await expect(readRegistryValues(exec, KEY, { view64: true })).rejects.toThrow(/Accès refusé/)
  })

  it('throws on output that is not a JSON object', async () => {
    await expect(readRegistryValues(fakeExec('oops'), KEY, { view64: true })).rejects.toThrow(/registry/)
    await expect(readRegistryValues(fakeExec('[1]'), KEY, { view64: true })).rejects.toThrow(/registry/)
  })

  it('passes a timeout, so a stuck PowerShell cannot hang detection', async () => {
    const exec = fakeExec('null')
    await readRegistryValues(exec, KEY, { view64: true })
    expect(exec.calls[0]?.opts).toMatchObject({ timeoutMs: expect.any(Number) as number })
  })
})
