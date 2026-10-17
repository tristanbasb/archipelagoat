import { routeDroppedFile } from '@renderer/lib/drop-routing'

const enc = encodeURIComponent

describe('routeDroppedFile', () => {
  it('routeDroppedFile maps apworld, yaml, patch and zip', () => {
    const world = 'C:\\Users\\Jérôme Dupont\\Downloads\\pokemon_crystal.apworld'
    expect(routeDroppedFile(world)).toEqual({ to: `/worlds?install=${enc(world)}`, intent: 'world-install' })

    const yaml = '/home/goat/Joueur 1.yaml'
    expect(routeDroppedFile(yaml)).toEqual({ to: `/studio?open=${enc(yaml)}`, intent: 'studio-open' })
    expect(routeDroppedFile('/home/goat/Joueur.YML')).toMatchObject({ intent: 'studio-open' })
    expect(routeDroppedFile(yaml, { activeSessionId: 'abc' })).toEqual({
      to: '/session/abc',
      intent: 'session-import',
    })

    for (const patch of ['AP_123_P1_Goat.apsml2', 'AP_1_P2_Link.aplttp', 'AP_1_P3_Mario.apsm64ex']) {
      expect(routeDroppedFile(`D:\\patches\\${patch}`)).toEqual({
        to: `/join?input=${enc(`D:\\patches\\${patch}`)}`,
        intent: 'join-patch',
      })
    }

    expect(routeDroppedFile('C:\\seeds\\AP_12345.zip')).toEqual({ to: '', intent: 'ask' })
  })

  it('returns null for files the app cannot use', () => {
    expect(routeDroppedFile('C:\\images\\goat.png')).toBeNull()
    expect(routeDroppedFile('C:\\seeds\\AP_12345.archipelago')).toBeNull()
    expect(routeDroppedFile('noextension')).toBeNull()
  })
})
