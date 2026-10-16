import { AP_EXES } from '@shared/data/ap-constants'
import { PATCH_ROUTES, routeForFile, TEXT_ROUTE } from '@shared/data/patch-routes'

const BIZHAWK_SUFFIXES = [
  '.apred',
  '.apblue',
  '.apemerald',
  '.apmlss',
  '.apcv64',
  '.apcvcotm',
  '.apmm2',
  '.apmm3',
  '.apsml2',
  '.apygo06',
]
const SNI_SUFFIXES = [
  '.aplttp',
  '.apsm',
  '.apsmw',
  '.apsmz3',
  '.apsoe',
  '.apl2ac',
  '.apkdl3',
  '.apyi',
  '.apeb',
]

describe('routeForFile', () => {
  it('routes BizHawk suffixes as full', () => {
    expect(routeForFile('P1_Bob.apemerald')?.client).toBe('bizhawk')
    for (const suffix of BIZHAWK_SUFFIXES) {
      expect(routeForFile(`AP_123_P1_Bob${suffix}`)).toEqual({
        suffix,
        client: 'bizhawk',
        exe: 'ArchipelagoBizHawkClient',
        tier: 'full',
      })
    }
  })

  it('never routes .zip', () => {
    expect(routeForFile('AP_123_P2_Al.zip')).toBeNull()
    expect(routeForFile('AP_123.ZIP')).toBeNull()
    expect(PATCH_ROUTES.some((route) => route.suffix === '.zip')).toBe(false)
  })

  it('routes .aplttp to SNI assisted', () => {
    expect(routeForFile('AP_123_P1_Link.aplttp')).toEqual({
      suffix: '.aplttp',
      client: 'sni',
      exe: 'ArchipelagoSNIClient',
      tier: 'assisted',
    })
    for (const suffix of SNI_SUFFIXES) {
      const route = routeForFile(`AP_1_P1_Al${suffix}`)
      expect(route).toMatchObject({ client: 'sni', exe: 'ArchipelagoSNIClient', tier: 'assisted' })
    }
  })

  it('routes the game specific clients as assisted', () => {
    expect(routeForFile('a.apz5')).toMatchObject({
      client: 'oot',
      exe: 'ArchipelagoOoTClient',
      tier: 'assisted',
    })
    expect(routeForFile('a.apbn3')).toMatchObject({
      client: 'mmbn3',
      exe: 'ArchipelagoMMBN3Client',
      tier: 'assisted',
    })
    expect(routeForFile('a.aptloz')).toMatchObject({
      client: 'tloz',
      exe: 'ArchipelagoZelda1Client',
      tier: 'assisted',
    })
    expect(routeForFile('a.apadvn')).toMatchObject({
      client: 'adventure',
      exe: 'ArchipelagoAdventureClient',
      tier: 'assisted',
    })
    expect(routeForFile('a.apzl')).toMatchObject({
      client: 'zillion',
      exe: 'ArchipelagoZillionClient',
      tier: 'assisted',
    })
  })

  it('routes the suffixes the Launcher handles as assisted launcher routes', () => {
    for (const suffix of ['.apladx', '.apgl', '.apcivvi']) {
      expect(routeForFile(`a${suffix}`)).toEqual({
        suffix,
        client: 'launcher',
        exe: 'ArchipelagoLauncher',
        tier: 'assisted',
      })
    }
  })

  it('ignores the case of the suffix and the folders of the path', () => {
    expect(routeForFile('P1_Bob.APEMERALD')?.client).toBe('bizhawk')
    expect(routeForFile('C:\\Users\\Bob\\Downloads\\AP_1_P1_Bob.ApLttP')?.client).toBe('sni')
    expect(routeForFile('/home/bob/dl.dir/AP_1_P1_Bob.apz5')?.client).toBe('oot')
  })

  it('only looks at the final suffix', () => {
    expect(routeForFile('P1.apemerald.bak')).toBeNull()
    expect(routeForFile('P1.apemerald.zip')).toBeNull()
    expect(routeForFile('apemerald')).toBeNull()
    expect(routeForFile('')).toBeNull()
  })

  it('does not route the files AP does not consume as patches', () => {
    for (const name of ['multiworld.archipelago', 'world.apworld', 'Bob.yaml', 'readme.txt', 'room.json']) {
      expect(routeForFile(name)).toBeNull()
    }
  })

  it('leaves out on purpose the suffixes no client of the app can open', () => {
    // .apmq: patched on a website; .aptww: an input of wwrando; .apsm64ex and .apv6: handed to the game;
    // .apz3 and .apm3: legacy suffixes no 0.6 world writes.
    for (const suffix of ['.apmq', '.aptww', '.apsm64ex', '.apv6', '.apz3', '.apm3']) {
      expect(routeForFile(`AP_1_P1_Bob${suffix}`), suffix).toBeNull()
    }
  })
})

describe('PATCH_ROUTES', () => {
  it('has one route per suffix and every suffix is lowercase with its dot', () => {
    const suffixes = PATCH_ROUTES.map((route) => route.suffix)
    expect(new Set(suffixes).size).toBe(suffixes.length)
    for (const suffix of suffixes) expect(suffix).toMatch(/^\.[a-z0-9]+$/)
  })

  it('covers the BizHawk, SNI, own client and launcher suffixes of the brief, and nothing else', () => {
    const own = ['.apz5', '.apbn3', '.aptloz', '.apadvn', '.apzl']
    const launcher = ['.apladx', '.apgl', '.apcivvi']
    const expected = [...BIZHAWK_SUFFIXES, ...SNI_SUFFIXES, ...own, ...launcher]
    expect(PATCH_ROUTES.map((route) => route.suffix).sort()).toEqual(expected.sort())
  })

  it('only launches executables Archipelago ships', () => {
    const known = new Set<string>(Object.values(AP_EXES))
    for (const route of PATCH_ROUTES) {
      expect(route.exe).not.toBeNull()
      expect(known.has(route.exe ?? '')).toBe(true)
    }
  })
})

describe('TEXT_ROUTE', () => {
  it('is the guided text client with no patch suffix', () => {
    expect(TEXT_ROUTE).toEqual({ suffix: '', client: 'text', exe: 'ArchipelagoTextClient', tier: 'guided' })
  })
})
