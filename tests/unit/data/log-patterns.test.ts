import {
  FILL_STEP_RE,
  FINAL_ARCHIVE_RE,
  GENERATE_STAGES,
  SERVER_EVENT_PATTERNS,
  SERVER_HOSTING_RE,
  SERVER_READY_RE,
} from '@shared/data/log-patterns'
import { GENERATE_STAGE_IDS } from '@shared/codes'
import type { ServerEvent } from '@shared/types'
import { apOutputLines } from '../../helpers/ap-output'

/** Stage ids the lines of an output reach, in order, without consecutive repeats. */
function stagesOf(lines: string[]): string[] {
  const reached: string[] = []
  for (const line of lines) {
    const stage = GENERATE_STAGES.find((s) => s.re.test(line))
    if (stage && reached.at(-1) !== stage.id) reached.push(stage.id)
  }
  return reached
}

describe('GENERATE_STAGES', () => {
  it('generate stages match fixture in order with increasing percent', () => {
    // One stage can take several lines (a weights line per player): keep the first of each run.
    const reached = apOutputLines('generate-success.txt').reduce<typeof GENERATE_STAGES>((stages, line) => {
      const stage = GENERATE_STAGES.find((s) => s.re.test(line))
      return stage && stages.at(-1) !== stage ? [...stages, stage] : stages
    }, [])
    expect(reached.map((s) => s.id)).toEqual([...GENERATE_STAGE_IDS])
    const percents = reached.map((s) => s.percent)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
    expect(new Set(percents).size).toBe(percents.length)
    expect(percents[0]).toBe(2)
    expect(percents.at(-1)).toBe(100)
  })

  it('has one entry per stage id, in the order of GENERATE_STAGE_IDS, from 2 up to 100', () => {
    expect(GENERATE_STAGES.map((s) => s.id)).toEqual([...GENERATE_STAGE_IDS])
    const percents = GENERATE_STAGES.map((s) => s.percent)
    for (let i = 1; i < percents.length; i++) expect(percents[i]).toBeGreaterThan(percents[i - 1] ?? 0)
    expect(percents[0]).toBe(2)
    expect(percents.at(-1)).toBe(100)
  })

  it('never lets one line match two stages', () => {
    for (const line of apOutputLines('generate-success.txt')) {
      expect(GENERATE_STAGES.filter((s) => s.re.test(line)).length).toBeLessThanOrEqual(1)
    }
  })

  it('does not take the log noise of a stage for a stage', () => {
    const noise = [
      'Took 1.0520 seconds in PokemonEmeraldWorld.set_rules for player 2, named Bob.',
      'Archipelago Version 0.6.8  -  Seed: 91827364501827364095',
      ' Pokemon Emerald   : v1.2.0 | Items: 607 | Locations: 1347',
      'Current fill step (Progression) at 1000/1442 items placed.',
      'Race mode enabled. Using non-deterministic random source.',
      '',
    ]
    for (const line of noise) expect(GENERATE_STAGES.some((s) => s.re.test(line))).toBe(false)
  })

  it('knows the three ways the balancing step is reported', () => {
    const lines = [
      'Balancing multiworld progression for 3 Players.',
      'Progression balancing skipped.',
      'Skipping multiworld progression balancing.',
    ]
    for (const line of lines) expect(stagesOf([line])).toEqual(['balancing'])
  })

  it('matches the weights lines of the shared file and of a player file', () => {
    expect(stagesOf(['Weights: weights.yaml >> No description specified'])).toEqual(['weights'])
    expect(stagesOf(['P12 Weights: Bob.yaml >> My run'])).toEqual(['weights'])
  })

  it('reads a line that carries the --log_time prefix', () => {
    expect(stagesOf(['[2026-10-17 09:41:02] Creating Items.'])).toEqual(['items'])
    expect(stagesOf(['[2026-10-17 09:41:02] Done. Enjoy. Total Time: 3.5'])).toEqual(['done'])
  })

  it('stops at the failing step when generation fails', () => {
    expect(stagesOf(apOutputLines('generate-fill-error.txt')).at(-1)).toBe('output')
    expect(stagesOf(apOutputLines('generate-yaml-error.txt'))).toEqual(['init'])
  })
})

describe('FILL_STEP_RE', () => {
  it('FILL_STEP_RE parses "Current fill step (x) at 2000/5000 items placed."', () => {
    const m = FILL_STEP_RE.exec('Current fill step (x) at 2000/5000 items placed.')
    expect(m?.groups).toMatchObject({ done: '2000', total: '5000' })
  })

  it('reads the step name, which can hold spaces', () => {
    const m = FILL_STEP_RE.exec('Current fill step (Priority Retry 2) at 1000/1442 items placed.')
    expect(m?.groups).toMatchObject({ name: 'Priority Retry 2', done: '1000', total: '1442' })
  })

  it('reads every fill line of the fixture and the counts never exceed the total', () => {
    const steps = apOutputLines('generate-success.txt').flatMap((line) => {
      const g = FILL_STEP_RE.exec(line)?.groups
      return g ? [{ done: Number(g.done), total: Number(g.total) }] : []
    })
    expect(steps).toHaveLength(4)
    for (const { done, total } of steps) expect(done).toBeLessThanOrEqual(total)
  })

  it('does not match other lines', () => {
    expect(FILL_STEP_RE.test('Filling the multiworld with 3190 items.')).toBe(false)
    expect(FILL_STEP_RE.test('Current fill step (x) at many/5000 items placed.')).toBe(false)
  })
})

describe('FINAL_ARCHIVE_RE', () => {
  it('captures the absolute archive path of a Windows install', () => {
    const line = 'Creating final archive at C:\\ProgramData\\Archipelago\\output\\AP_47305681920473519826.zip'
    expect(FINAL_ARCHIVE_RE.exec(line)?.groups?.path).toBe(
      'C:\\ProgramData\\Archipelago\\output\\AP_47305681920473519826.zip',
    )
  })

  it('keeps spaces and accents in the path and drops a carriage return', () => {
    const line = 'Creating final archive at /home/jérôme/My Games/output/AP_1.zip\r'
    expect(FINAL_ARCHIVE_RE.exec(line)?.groups?.path).toBe('/home/jérôme/My Games/output/AP_1.zip')
  })

  it('finds the archive line in the success fixture and in no failure fixture', () => {
    expect(apOutputLines('generate-success.txt').filter((l) => FINAL_ARCHIVE_RE.test(l))).toHaveLength(1)
    for (const name of ['generate-fill-error.txt', 'generate-yaml-error.txt']) {
      expect(apOutputLines(name).some((l) => FINAL_ARCHIVE_RE.test(l))).toBe(false)
    }
  })
})

describe('the real output of Archipelago 0.6.8 (docs/verification/2026-10-16-real-run.md)', () => {
  const generation = apOutputLines('real-generate-12-players.txt')
  const server = apOutputLines('real-server-session.txt')

  it('logs every stage of a 12-player generation, in order, and one final archive', () => {
    expect(stagesOf(generation)).toEqual([...GENERATE_STAGE_IDS])
    const archives = generation.filter((line) => FINAL_ARCHIVE_RE.test(line))
    expect(archives).toHaveLength(1)
    expect(FINAL_ARCHIVE_RE.exec(archives[0] ?? '')?.groups?.path).toMatch(
      /\\output\\AP_85957999565022565374\.zip$/,
    )
  })

  it('reads a fill step that goes past its total', () => {
    const over = generation.find((line) => line.includes('1490/1473'))
    expect(FILL_STEP_RE.exec(over ?? '')?.groups).toMatchObject({
      name: 'Remaining',
      done: '1490',
      total: '1473',
    })
  })

  it('logs Hosting game at, then one listening line per socket, [::] first', () => {
    const hosting = server.findIndex((line) => SERVER_HOSTING_RE.test(line))
    expect(server.filter((line) => SERVER_READY_RE.test(line))).toEqual([
      'server listening on [::]:38281',
      'server listening on 0.0.0.0:38281',
    ])
    expect(server.findIndex((line) => SERVER_READY_RE.test(line))).toBe(hosting + 1)
  })
})

describe('server patterns', () => {
  const startup = apOutputLines('server-startup.txt')

  it('server ready regex matches only the listening line', () => {
    const matching = startup.filter((line) => SERVER_READY_RE.test(line))
    expect(matching).toEqual(['server listening on 0.0.0.0:38281', 'server listening on [::]:38281'])
    expect(SERVER_READY_RE.test('Hosting game at 203.0.113.7:38281 (No password)')).toBe(false)
    expect(SERVER_READY_RE.test('Notice (all): Bob: the server listening on port 5 is slow')).toBe(false)
  })

  it('reads the bound address from the listening line', () => {
    expect(SERVER_READY_RE.exec('server listening on 0.0.0.0:38281')?.groups).toMatchObject({
      host: '0.0.0.0',
      port: '38281',
    })
    expect(SERVER_READY_RE.exec('server listening on [::]:38281')?.groups).toMatchObject({
      host: '[::]',
      port: '38281',
    })
  })

  it('logs Hosting game at BEFORE server listening on', () => {
    const hosting = startup.findIndex((line) => SERVER_HOSTING_RE.test(line))
    const ready = startup.findIndex((line) => SERVER_READY_RE.test(line))
    expect(hosting).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(hosting)
  })

  it('SERVER_HOSTING_RE reads host and port with or without a password, and never captures the password', () => {
    const open = SERVER_HOSTING_RE.exec('Hosting game at 203.0.113.7:38281 (No password)')
    expect(open?.groups).toEqual({ host: '203.0.113.7', port: '38281' })
    const locked = SERVER_HOSTING_RE.exec('Hosting game at 192.168.1.20:40000 (Password: hunter2)')
    // Only the host and the port are captured: a password has no business in a group.
    expect(locked?.groups).toEqual({ host: '192.168.1.20', port: '40000' })
    expect(locked?.slice(1)).toEqual(['192.168.1.20', '40000'])
    expect(SERVER_HOSTING_RE.test('server listening on 0.0.0.0:38281')).toBe(false)
  })

  it('reads lines that carry the --logtime prefix', () => {
    expect(SERVER_READY_RE.test('[2026-10-17 09:41:02] server listening on 0.0.0.0:38281')).toBe(true)
    expect(SERVER_HOSTING_RE.test('[2026-10-17 09:41:02] Hosting game at 1.2.3.4:38281 (No password)')).toBe(
      true,
    )
  })
})

describe('SERVER_EVENT_PATTERNS', () => {
  /** What the first pattern that matches a line gives, as the consumer does. */
  function parse(line: string): { kind: ServerEvent['kind']; groups: Record<string, string> } | null {
    for (const { kind, re } of SERVER_EVENT_PATTERNS) {
      const m = re.exec(line)
      if (m) return { kind, groups: { ...m.groups } }
    }
    return null
  }

  const session = apOutputLines('server-session.txt')

  it('reads the events of the session fixture in order', () => {
    expect(session.map((line) => parse(line)?.kind ?? null)).toEqual([
      'join',
      'join',
      'join',
      'item',
      'item',
      'chat',
      null, // refused connection: not an event (it carries the client's password and is only logged)
      'leave',
      'leave',
      'goal',
      'goal',
      'all-goals',
    ])
  })

  it('reads who joined, as what, and on which game', () => {
    expect(parse(session[0] ?? '')?.groups).toMatchObject({ player: 'Alice', game: 'Pokemon Emerald' })
    expect(parse(session[1] ?? '')?.groups).toMatchObject({ player: 'Bob', game: 'A Hat in Time' })
    expect(parse(session[2] ?? '')?.groups).toMatchObject({ player: 'Carol', game: 'Pokemon Emerald' })
  })

  it('reads the finder, the receiver, the item and the location of an item event', () => {
    expect(parse(session[3] ?? '')).toEqual({
      kind: 'item',
      groups: {
        team: '1',
        player: 'Alice',
        item: 'Progressive Hat',
        receiver: 'Bob',
        location: 'Littleroot Town - Pokemon Center',
      },
    })
  })

  it('splits an item line correctly when the item or the location contain " to "', () => {
    expect(parse(session[4] ?? '')?.groups).toMatchObject({
      player: 'Bob',
      item: 'Key to the City',
      receiver: 'Alice',
      location: 'Mafia Town - Path to Lake',
    })
  })

  it('reads who left and who completed their goal', () => {
    expect(parse(session[7] ?? '')?.groups).toMatchObject({ player: 'Carol' })
    expect(parse(session[8] ?? '')?.groups).toMatchObject({ player: 'Bob' })
    expect(parse(session[9] ?? '')?.groups).toMatchObject({ player: 'Alice' })
    expect(parse(session[11] ?? '')?.groups).toMatchObject({ team: '1' })
  })

  it('reads a chat message and its author', () => {
    expect(parse(session[5] ?? '')).toEqual({
      kind: 'chat',
      groups: { player: 'Bob', message: 'gg, nice run' },
    })
  })

  it('also reads the server admin chat', () => {
    expect(parse('Notice (all): [Server]: GO')).toEqual({
      kind: 'chat',
      groups: { player: '[Server]', message: 'GO' },
    })
  })

  it('reads event lines that carry the --logtime prefix', () => {
    expect(
      parse('[2026-10-17 09:41:02] Notice (all): Alice (Team #1) has left the game. Client(0.6.8), [].')
        ?.kind,
    ).toBe('leave')
    expect(parse('[2026-10-17 09:41:02] (Team #1) Alice sent Sword to Bob (Chest)')?.kind).toBe('item')
  })

  it('does not take startup lines or the refused connection for events', () => {
    for (const line of apOutputLines('server-startup.txt')) expect(parse(line)).toBeNull()
    expect(parse(session[6] ?? '')).toBeNull()
  })
})
