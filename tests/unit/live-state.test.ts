import type { ServerEvent } from '@shared/types'
import {
  appendCapped,
  appendLogChunk,
  chatMessage,
  EMPTY_ROOM_LOG,
  feedFromHistory,
  fileName,
  presence,
  roomAwake,
  roomLogLines,
  slotFolder,
} from '@renderer/features/host/live-state'

function event(kind: ServerEvent['kind'], player?: string): ServerEvent {
  return {
    ts: '2026-10-17T19:00:00.000Z',
    kind,
    text: `${kind} ${player ?? ''}`,
    ...(player ? { player } : {}),
  }
}

describe('live game state', () => {
  it('appendCapped keeps the newest items', () => {
    expect(appendCapped([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5])
    expect(appendCapped([1], [2], 4)).toEqual([1, 2])
  })

  it('feedFromHistory turns the log into plain console lines', () => {
    const feed = feedFromHistory({ events: [event('join', 'Alice')], log: ['a', 'b'] })
    expect(feed.events).toHaveLength(1)
    expect(feed.lines).toEqual([{ text: 'a' }, { text: 'b' }])
  })

  it('presence counts connections, so a tracker leaving keeps the game client online', () => {
    const state = presence([
      event('join', 'Alice'),
      event('join', 'Alice'),
      event('leave', 'Alice'),
      event('join', 'Bob'),
      event('leave', 'Bob'),
      // A leave whose join fell out of the history ring.
      event('leave', 'Carol'),
      event('goal', 'Bob'),
    ])
    expect([...state.online]).toEqual(['Alice'])
    expect([...state.goals]).toEqual(['Bob'])
    expect(state.everyoneDone).toBe(false)
    expect(presence([event('all-goals')]).everyoneDone).toBe(true)
  })

  it('presence of a server that does not run: nobody online, the goals stay', () => {
    const state = presence([event('join', 'Alice'), event('goal', 'Alice'), event('all-goals')], {
      running: false,
    })
    expect([...state.online]).toEqual([])
    expect([...state.goals]).toEqual(['Alice'])
    expect(state.everyoneDone).toBe(true)
  })

  it('roomAwake: a room sleeps without a port, or once idle for longer than its timeout', () => {
    const now = Date.parse('2026-10-17T20:00:00.000Z')
    const room = { port: 52011, lastActivity: '2026-10-17T19:00:00.000Z', timeoutS: 7200 }
    expect(roomAwake(room, now)).toBe(true)
    expect(roomAwake({ ...room, port: null }, now)).toBe(false)
    expect(roomAwake({ ...room, lastActivity: '2026-10-17T17:59:59.000Z' }, now)).toBe(false)
    // Nothing says when it goes to sleep: a room with a port counts as awake.
    expect(roomAwake({ ...room, lastActivity: null }, now)).toBe(true)
    expect(roomAwake({ ...room, timeoutS: null }, now)).toBe(true)
    expect(roomAwake({ ...room, lastActivity: 'not a date' }, now)).toBe(true)
  })

  it('appendLogChunk splits lines and keeps an unfinished one for the next chunk', () => {
    const first = appendLogChunk(EMPTY_ROOM_LOG, { text: 'one\r\ntwo\nthr', nextByte: 12 })
    expect(first.lines).toEqual([{ text: 'one' }, { text: 'two' }])
    expect(first.partial).toBe('thr')
    expect(first.nextByte).toBe(12)
    expect(roomLogLines(first)).toEqual([{ text: 'one' }, { text: 'two' }, { text: 'thr' }])

    const second = appendLogChunk(first, { text: 'ee\n', nextByte: 15 })
    expect(second.lines.map((line) => line.text)).toEqual(['one', 'two', 'three'])
    expect(second.partial).toBe('')
    expect(roomLogLines(second)).toHaveLength(3)
  })

  it('chatMessage drops the speaker prefix of the log line', () => {
    const chat = (text: string, player = 'Bob'): ServerEvent => ({ ...event('chat', player), text })
    expect(chatMessage(chat('Notice (all): Bob: salut: ça va ?'))).toBe('salut: ça va ?')
    expect(chatMessage(chat('Bob: gg'))).toBe('gg')
    expect(chatMessage(chat('gg'))).toBe('gg')
  })

  it('slotFolder and fileName read Windows and POSIX paths', () => {
    expect(slotFolder('C:\\ws\\output\\slots\\P1_Alice\\AP_42_P1_Alice.aplttp')).toBe(
      'C:\\ws\\output\\slots\\P1_Alice',
    )
    expect(slotFolder('/ws/output/slots/P2_Bob/AP_42_P2_Bob.apsm')).toBe('/ws/output/slots/P2_Bob')
    expect(slotFolder('AP_42.apsm')).toBeNull()
    expect(fileName('C:\\ws\\P1_Alice\\AP_42_P1_Alice.aplttp')).toBe('AP_42_P1_Alice.aplttp')
    expect(fileName('/ws/P2_Bob/AP_42_P2_Bob.apsm')).toBe('AP_42_P2_Bob.apsm')
  })
})
