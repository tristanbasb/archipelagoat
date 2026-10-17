import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '@main/core/config'
import { registerHandlers } from '@main/ipc'
import { isAllowedExternalUrl } from '@main/ipc/app'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import type { QuitRequest } from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'

const meta = { senderId: 1 }

let dir: string
let core: TestCore
let call: (name: string, input?: unknown) => Promise<unknown>

function boot(overrides: Parameters<typeof createTestContext>[1] = {}): void {
  core = createTestContext(dir, overrides)
  const ipc = createIpcRegistry()
  registerHandlers(createServices(core.ctx), ipc.registerHandler)
  call = (name, input) => ipc.dispatch(name, input, meta)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat-app-handlers-'))
  boot()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('app handlers', () => {
  it('app:getInfo describes the app and its folders', async () => {
    const { paths } = core.platform
    expect(await call('app:getInfo')).toEqual({
      ok: true,
      value: {
        version: '0.1.0-test',
        os: core.platform.os,
        locale: 'fr-FR',
        isPackaged: false,
        userData: paths.userData,
        dataRoot: paths.dataRoot,
        // Not packaged: electron-updater does nothing.
        updater: 'development',
      },
    })
  })

  it('app:getConfig and app:setConfig read and deep-merge the config', async () => {
    expect(await call('app:getConfig')).toEqual({ ok: true, value: defaultConfig(core.platform.os) })
    const result = (await call('app:setConfig', { effects: { sounds: true } })) as {
      value: { effects: Record<string, boolean> }
    }
    expect(result.value.effects).toEqual({ crt: true, glow: true, animations: true, sounds: true })
    expect(await call('app:setConfig', { apPathOverride: 'C:\\x' })).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })
  })

  it('app:openPath opens folders and text files, never programs', async () => {
    const { dataRoot } = core.platform.paths
    const log = join(dataRoot, 'logs', 'app.log')
    const exe = join(dataRoot, 'downloads', 'Setup.Archipelago.0.6.8.exe')
    mkdirSync(join(dataRoot, 'logs'))
    mkdirSync(join(dataRoot, 'downloads'))
    writeFileSync(log, 'line\n')
    writeFileSync(exe, 'MZ')

    expect(await call('app:openPath', { path: log })).toEqual({ ok: true, value: undefined })
    expect(await call('app:openPath', { path: exe })).toMatchObject({ error: { code: 'PATH_FORBIDDEN' } })
    expect(await call('app:openPath', { path: join(dataRoot, 'missing') })).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
    expect(core.openPath.mock.calls).toEqual([[log]])
  })

  it('app:openExternal opens whitelisted https links only', async () => {
    expect(await call('app:openExternal', { url: 'https://archipelago.gg/tutorial' })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await call('app:openExternal', { url: 'http://archipelago.gg/' })).toMatchObject({
      error: { code: 'PATH_FORBIDDEN' },
    })
    expect(core.openExternal.mock.calls).toEqual([['https://archipelago.gg/tutorial']])
  })

  it('isAllowedExternalUrl checks the scheme, the host and its subdomains', () => {
    for (const url of [
      'https://archipelago.gg/room/abc',
      'https://github.com/ArchipelagoMW/Archipelago/releases',
      'https://archipelago.miraheze.org/wiki/Main_Page',
      'https://tasvideos.org/BizHawk',
      'https://discord.gg/8Z65BR2',
      'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist',
      'https://www.github.com/x',
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(true)
    }
    for (const url of [
      'http://archipelago.gg/',
      'https://archipelago.gg.evil.example/',
      'https://evilgithub.com/',
      'https://github.com:8443/x',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false)
    }
  })

  it('app:pickPaths and app:savePath use the platform dialogs', async () => {
    core.showOpenDialog.mockResolvedValueOnce(['C:\\a.yaml', 'C:\\b.yaml'])
    core.showSaveDialog.mockResolvedValueOnce('C:\\out\\Player.yaml')
    const filters = [{ name: 'YAML', extensions: ['yaml', 'yml'] }]

    expect(await call('app:pickPaths', { mode: 'files', title: 'Pick', filters })).toEqual({
      ok: true,
      value: ['C:\\a.yaml', 'C:\\b.yaml'],
    })
    expect(core.showOpenDialog).toHaveBeenCalledWith({ mode: 'files', title: 'Pick', filters })
    expect(await call('app:savePath', { defaultName: 'Player.yaml', filters })).toEqual({
      ok: true,
      value: 'C:\\out\\Player.yaml',
    })
    expect(core.showSaveDialog).toHaveBeenCalledWith({ defaultName: 'Player.yaml', filters })
  })

  it('app:setGithubToken stores github.token and app:secretsStatus reports it', async () => {
    expect(await call('app:secretsStatus')).toEqual({
      ok: true,
      value: { canEncrypt: true, hasGithubToken: false },
    })
    expect(await call('app:setGithubToken', { token: 'ghp_x' })).toEqual({
      ok: true,
      value: { hasToken: true },
    })
    expect(core.ctx.secrets.get('github.token')).toBe('ghp_x')
    expect(await call('app:secretsStatus')).toEqual({
      ok: true,
      value: { canEncrypt: true, hasGithubToken: true },
    })
    expect(await call('app:setGithubToken', { token: null })).toEqual({
      ok: true,
      value: { hasToken: false },
    })
    expect(core.ctx.secrets.get('github.token')).toBeNull()
  })

  it('app:setGithubToken reports SECRETS_UNAVAILABLE without encryption', async () => {
    boot({ canEncrypt: () => false })
    expect(await call('app:setGithubToken', { token: 'ghp_x' })).toEqual({
      ok: false,
      error: { code: 'SECRETS_UNAVAILABLE' },
    })
    expect(await call('app:secretsStatus')).toEqual({
      ok: true,
      value: { canEncrypt: false, hasGithubToken: false },
    })
  })

  it('app:clearData empties the chosen data folders only', async () => {
    const { dataRoot } = core.platform.paths
    for (const name of ['downloads', 'catalog', 'logs', 'sessions']) {
      mkdirSync(join(dataRoot, name, 'sub'), { recursive: true })
      writeFileSync(join(dataRoot, name, 'sub', 'f.bin'), 'x')
      writeFileSync(join(dataRoot, name, 'top.bin'), 'x')
    }
    expect(await call('app:clearData', { targets: ['downloads', 'catalog'] })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(readdirSync(join(dataRoot, 'downloads'))).toEqual([])
    expect(readdirSync(join(dataRoot, 'catalog'))).toEqual([])
    expect(readdirSync(join(dataRoot, 'logs')).sort()).toEqual(['sub', 'top.bin'])
    expect(existsSync(join(dataRoot, 'sessions', 'top.bin'))).toBe(true)

    rmSync(join(dataRoot, 'logs'), { recursive: true })
    expect(await call('app:clearData', { targets: ['logs'] })).toEqual({ ok: true, value: undefined })
  })

  it('app:confirmQuit answers the pending quit request', async () => {
    const requests: QuitRequest[] = []
    core.ctx.bus.on('app:quitRequested', (r) => void requests.push(r))
    core.lifecycle.onCloseRequested(() => ({ servers: ['s1'], tasks: [] }))
    expect(core.lifecycle.requestClose()).toBe(false)

    const requestId = requests[0]?.requestId
    expect(await call('app:confirmQuit', { requestId, confirm: true })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(core.quit).toHaveBeenCalledOnce()
  })

  it('app:pendingOpenRequests drains the queue of the openRequests service (ipc/system.ts)', async () => {
    // Outside Electron there is no launch argv to read: the queue starts empty.
    expect(await call('app:pendingOpenRequests')).toEqual({ ok: true, value: [] })
  })
})

describe('tasks handlers', () => {
  it('tasks:list returns running tasks and tasks:cancel cancels one', async () => {
    const ref = core.ctx.tasks.start(
      'rom-scan',
      (t) => new Promise((resolve) => t.signal.addEventListener('abort', resolve)),
    )
    expect(await call('tasks:list')).toEqual({
      ok: true,
      value: [{ taskId: ref.taskId, kind: 'rom-scan', stage: 'init', percent: null }],
    })
    expect(await call('tasks:cancel', { taskId: ref.taskId })).toEqual({ ok: true, value: undefined })
    expect(await call('tasks:list')).toEqual({ ok: true, value: [] })
    expect(await call('tasks:cancel', { taskId: 'gone' })).toEqual({ ok: true, value: undefined })
  })
})
