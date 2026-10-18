import { basename } from 'node:path'
import { z } from 'zod'
import type { DoctorCheckId } from '@shared/codes'
import { channels, domainChannels } from '@shared/ipc'
import type { ChannelInput, ChannelName, ChannelOutput } from '@shared/ipc/contract'
import { EVENT_NAMES } from '@shared/ipc/event-names'
import type { EventPayloads } from '@shared/ipc/events'
import { RULE_PRESETS } from '@shared/rules'
import type {
  AppConfig,
  BalanceTarget,
  EditorDoc,
  JoinTarget,
  OpenRequest,
  QuitRequest,
  Rules,
  ServerEvent,
  Session,
  TaskDone,
  TaskProgress,
  TaskRef,
  WorldSource,
} from '@shared/types'

// Every channel of the Task 2 table, in table order.
const CHANNEL_TABLE = [
  'app:getInfo',
  'app:getConfig',
  'app:setConfig',
  'app:openPath',
  'app:openExternal',
  'app:pickPaths',
  'app:savePath',
  'app:pendingOpenRequests',
  'app:confirmQuit',
  'app:setGithubToken',
  'app:secretsStatus',
  'app:clearData',
  'tasks:list',
  'tasks:cancel',
  'ap:detect',
  'ap:latestRelease',
  'ap:install',
  'ap:uninstall',
  'ap:setCustomPath',
  'ap:processes',
  'ap:regenerateTemplates',
  'worlds:list',
  'worlds:prepareInstall',
  'worlds:confirmInstall',
  'worlds:setEnabled',
  'worlds:remove',
  'catalog:list',
  'checks:estimate',
  'checks:measureSession',
  'checks:lastSession',
  'checks:suggest',
  'checks:apply',
  'covers:get',
  'studio:games',
  'studio:schema',
  'studio:parse',
  'studio:render',
  'studio:validate',
  'studio:open',
  'studio:save',
  'session:list',
  'session:create',
  'session:get',
  'session:update',
  'session:delete',
  'session:addFiles',
  'session:addText',
  'session:removeFile',
  'session:readFile',
  'session:replaceFile',
  'session:getSecrets',
  'session:setSecrets',
  'session:validate',
  'session:generate',
  'server:start',
  'server:stop',
  'server:command',
  'server:get',
  'server:history',
  'webhost:host',
  'webhost:room',
  'webhost:wake',
  'webhost:command',
  'webhost:log',
  'webhost:myRooms',
  'webhost:openAsOwner',
  'join:resolve',
  'join:prepare',
  'join:refresh',
  'join:play',
  'join:textClient',
  'vault:list',
  'vault:scan',
  'vault:remove',
  'vault:apply',
  'vault:table',
  'bizhawk:state',
  'bizhawk:install',
  'bizhawk:setPath',
  'bizhawk:configureAp',
  'doctor:run',
  'doctor:fix',
  'doctor:supportBundle',
  'system:integration',
  'system:setIntegration',
]

const VOID_CHANNELS = [
  'app:getInfo',
  'app:getConfig',
  'app:pendingOpenRequests',
  'app:secretsStatus',
  'tasks:list',
  'ap:detect',
  'ap:processes',
  'ap:regenerateTemplates',
  'worlds:list',
  'studio:games',
  'session:list',
  'webhost:myRooms',
  'vault:list',
  'vault:apply',
  'vault:table',
  'bizhawk:state',
  'bizhawk:install',
  'bizhawk:configureAp',
  'doctor:run',
  'doctor:supportBundle',
  'system:integration',
]

const NOT_DOMAIN_FILES = new Set(['contract', 'events', 'event-names', 'index'])
const ipcFiles = import.meta.glob('../../../src/shared/ipc/*.ts')

/** Paths of object schemas, at any depth, that accept unknown keys. */
function looseObjects(schema: z.ZodType, at: string): string[] {
  if (schema instanceof z.ZodObject) {
    const self = schema.def.catchall instanceof z.ZodNever ? [] : [at]
    const shape = schema.shape as Record<string, z.ZodType>
    return [...self, ...Object.entries(shape).flatMap(([key, value]) => looseObjects(value, `${at}.${key}`))]
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return looseObjects(schema.unwrap() as z.ZodType, at)
  }
  if (schema instanceof z.ZodUnion) {
    return (schema.options as z.ZodType[]).flatMap((option, i) => looseObjects(option, `${at}|${i}`))
  }
  if (schema instanceof z.ZodArray) return looseObjects(schema.element as z.ZodType, `${at}[]`)
  if (schema instanceof z.ZodRecord) return looseObjects(schema.valueType as z.ZodType, `${at}{}`)
  return []
}

describe('ipc contract', () => {
  it('every channel has an input schema and no domain file redefines another domain channel', () => {
    const domains = Object.entries(domainChannels)
    const total = domains.reduce((n, [, defs]) => n + Object.keys(defs).length, 0)
    expect(total).toBe(Object.keys(channels).length)
    for (const [domain, defs] of domains) {
      for (const name of Object.keys(defs)) expect(name.startsWith(`${domain}:`), name).toBe(true)
    }
    for (const def of Object.values(channels)) expect(def.input).toBeInstanceOf(z.ZodType)
  })

  it('merges exactly one file per domain', () => {
    const files = Object.keys(ipcFiles)
      .map((file) => basename(file, '.ts'))
      .filter((name) => !NOT_DOMAIN_FILES.has(name))
    expect(files.sort()).toEqual(Object.keys(domainChannels).sort())
  })

  it('declares exactly the channel table', () => {
    expect(Object.keys(channels).sort()).toEqual([...CHANNEL_TABLE].sort())
  })

  it('object inputs are strict at every depth', () => {
    const loose = Object.entries(channels).flatMap(([name, def]) => looseObjects(def.input, name))
    expect(loose).toEqual([])
  })

  it('void inputs accept undefined and nothing else', () => {
    for (const name of VOID_CHANNELS) {
      const input = channels[name as ChannelName].input
      expect(input.safeParse(undefined).success, name).toBe(true)
      expect(input.safeParse({}).success, name).toBe(false)
    }
  })

  it('rejects invalid input via schema', () =>
    expect(channels['session:get'].input.safeParse({}).success).toBe(false))

  it('webhost:host requires consent literal true', () => {
    expect(channels['webhost:host'].input.safeParse({ sessionId: 's', consent: false }).success).toBe(false)
    expect(channels['webhost:host'].input.safeParse({ sessionId: 's' }).success).toBe(false)
    expect(channels['webhost:host'].input.safeParse({ sessionId: 's', consent: true }).success).toBe(true)
  })

  it('app:setConfig accepts a deep partial but never the fields reserved to the main process', () => {
    const input = channels['app:setConfig'].input
    expect(input.safeParse({ effects: { crt: false } }).success).toBe(true)
    expect(input.safeParse({}).success).toBe(true)
    expect(input.safeParse({ language: 'de' }).success).toBe(false)
    expect(input.safeParse({ apPathOverride: 'C:\\evil' }).success).toBe(false)
    expect(input.safeParse({ integration: { winProtocol: true } }).success).toBe(false)
    expect(input.safeParse({ webhostUrl: 'https://evil.example' }).success).toBe(false)
  })

  it('app:setConfig takes the player name (16 characters at most) and the last ready destination', () => {
    const input = channels['app:setConfig'].input
    expect(input.safeParse({ playerName: 'Tristan', readyDestination: 'file' }).success).toBe(true)
    expect(input.safeParse({ playerName: '' }).success).toBe(true)
    expect(input.safeParse({ playerName: 'x'.repeat(17) }).success).toBe(false)
    expect(input.safeParse({ readyDestination: 'cloud' }).success).toBe(false)
  })

  it('validates nested shared types', () => {
    expect(channels['session:update'].input.safeParse({ id: 's', rules: RULE_PRESETS.race }).success).toBe(
      true,
    )
    expect(
      channels['session:update'].input.safeParse({ id: 's', rules: { ...RULE_PRESETS.race, spoiler: 4 } })
        .success,
    ).toBe(false)
    expect(
      channels['worlds:prepareInstall'].input.safeParse({
        source: { kind: 'url', url: 'https://x/y.apworld' },
      }).success,
    ).toBe(true)
    expect(
      channels['worlds:prepareInstall'].input.safeParse({ source: { kind: 'ftp', url: 'x' } }).success,
    ).toBe(false)
    const address = {
      kind: 'address',
      host: 'archipelago.gg',
      port: 38281,
      slot: null,
      password: null,
      game: null,
    }
    expect(channels['join:prepare'].input.safeParse({ target: address }).success).toBe(true)
    expect(channels['join:prepare'].input.safeParse({ target: { ...address, port: 0 } }).success).toBe(false)
    expect(channels['doctor:fix'].input.safeParse({ checkId: 'worlds-corrupt' }).success).toBe(true)
    expect(channels['doctor:fix'].input.safeParse({ checkId: 'nope' }).success).toBe(false)
    expect(channels['app:clearData'].input.safeParse({ targets: ['logs', 'catalog'] }).success).toBe(true)
    expect(channels['app:clearData'].input.safeParse({ targets: ['sessions'] }).success).toBe(false)
  })

  it('derives the channel types from the contract', () => {
    expectTypeOf<ChannelInput<'app:getInfo'>>().toEqualTypeOf<undefined>()
    expectTypeOf<ChannelOutput<'app:getConfig'>>().toEqualTypeOf<AppConfig>()
    expectTypeOf<ChannelOutput<'app:openPath'>>().toEqualTypeOf<void>()
    expectTypeOf<ChannelOutput<'session:get'>>().toEqualTypeOf<Session>()
    expectTypeOf<ChannelOutput<'ap:install'>>().toEqualTypeOf<TaskRef>()
    expectTypeOf<ChannelOutput<'app:pendingOpenRequests'>>().toEqualTypeOf<OpenRequest[]>()
    expectTypeOf<NonNullable<ChannelInput<'session:update'>['rules']>>().toEqualTypeOf<Rules>()
    expectTypeOf<ChannelInput<'worlds:prepareInstall'>['source']>().toEqualTypeOf<WorldSource>()
    expectTypeOf<ChannelInput<'join:prepare'>['target']>().toEqualTypeOf<JoinTarget>()
    expectTypeOf<ChannelInput<'studio:render'>['doc']>().toEqualTypeOf<EditorDoc>()
    expectTypeOf<ChannelInput<'doctor:fix'>['checkId']>().toEqualTypeOf<DoctorCheckId>()
    expectTypeOf<ChannelInput<'webhost:host'>['consent']>().toEqualTypeOf<true>()
    expectTypeOf<ChannelInput<'checks:suggest'>['target']>().toEqualTypeOf<BalanceTarget>()
    expectTypeOf<ChannelOutput<'checks:apply'>>().toEqualTypeOf<Session>()
  })
})

describe('ipc events', () => {
  it('lists every event of the table once', () => {
    expect([...EVENT_NAMES].sort()).toEqual(
      [
        'task:progress',
        'task:log',
        'task:done',
        'task:failed',
        'server:state',
        'server:event',
        'server:log',
        'app:openRequest',
        'app:quitRequested',
        'config:changed',
        'worlds:changed',
        'checks:changed',
        'ap:installed',
      ].sort(),
    )
  })

  it('types every payload', () => {
    expectTypeOf<EventPayloads['task:progress']>().toEqualTypeOf<TaskProgress>()
    expectTypeOf<EventPayloads['task:done']>().toEqualTypeOf<TaskDone>()
    expectTypeOf<EventPayloads['server:event']>().toEqualTypeOf<{ sessionId: string; event: ServerEvent }>()
    expectTypeOf<EventPayloads['app:quitRequested']>().toEqualTypeOf<QuitRequest>()
    expectTypeOf<EventPayloads['worlds:changed']>().toEqualTypeOf<null>()
  })
})
