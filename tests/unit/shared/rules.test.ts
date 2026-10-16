import { channels } from '@shared/ipc'
import { defaultRules, RULE_PRESETS } from '@shared/rules'

describe('rule presets', () => {
  it('RULE_PRESETS.race sets race true, spoiler 0, compatibility 0; defaultRules equals casual', () => {
    expect(RULE_PRESETS.race).toMatchObject({ preset: 'race', race: true, spoiler: 0, compatibility: 0 })
    expect(defaultRules()).toEqual(RULE_PRESETS.casual)
  })

  it('casual turns the item cheat off, hint cost 10, release and collect auto, spoiler 3', () => {
    expect(RULE_PRESETS.casual).toMatchObject({
      preset: 'casual',
      itemCheat: false,
      hintCost: 10,
      releaseMode: 'auto',
      collectMode: 'auto',
      spoiler: 3,
      race: false,
    })
  })

  it('async is casual with auto_shutdown 0', () => {
    expect(RULE_PRESETS.async).toEqual({ ...RULE_PRESETS.casual, preset: 'async', autoShutdown: 0 })
  })

  it('defaultRules returns a fresh copy', () => {
    const rules = defaultRules()
    rules.plando.push('items')
    expect(RULE_PRESETS.casual.plando).not.toContain('items')
  })

  it('every preset is valid input for session:update', () => {
    for (const rules of Object.values(RULE_PRESETS)) {
      expect(channels['session:update'].input.safeParse({ id: 's', rules }).success).toBe(true)
    }
  })
})
