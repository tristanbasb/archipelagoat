import type { Address, Rules, Session, WebRoom } from '@shared/types'
import { buildShareText } from '@renderer/features/host/share-text'
import { i18n } from '@renderer/i18n'

const en = i18n.getFixedT('en')
const fr = i18n.getFixedT('fr')

const RULES: Rules = {
  preset: 'casual',
  spoiler: 3,
  race: false,
  hintCost: 10,
  locationCheckPoints: 1,
  releaseMode: 'auto',
  collectMode: 'auto',
  remainingMode: 'goal',
  countdownMode: 'auto',
  itemCheat: false,
  autoShutdown: 0,
  plando: [],
  compatibility: 2,
}

const SESSION: Session = {
  id: 's1',
  name: 'Soirée Zelda',
  createdAt: '2026-10-17T18:00:00.000Z',
  updatedAt: '2026-10-17T19:00:00.000Z',
  status: 'hosting',
  players: [],
  rules: RULES,
  hasPassword: true,
  hasServerPassword: false,
  generation: {
    seedName: '42',
    zipPath: '/data/sessions/s1/output/AP_42.zip',
    spoilerName: null,
    slots: [
      { slot: 1, name: 'Alice', game: 'A Link to the Past', patchFile: null },
      { slot: 2, name: 'Bob', game: 'Super Metroid', patchFile: null },
    ],
    durationS: 12,
    logPath: '/data/sessions/s1/logs/generate.txt',
  },
  hosting: { mode: 'local', port: 38281, savefile: '/data/sessions/s1/output/AP_42.apsave' },
  workspace: '/data/sessions/s1',
}

const ADDRESSES: Address[] = [
  { kind: 'localhost', host: 'localhost', port: 38281 },
  { kind: 'lan', host: '192.168.1.20', port: 38281 },
  { kind: 'public', host: '82.64.1.2', port: 38281 },
]

const ROOM: WebRoom = {
  roomId: 'room1',
  seedId: 'seed1',
  roomUrl: 'https://archipelago.gg/room/room1',
  host: 'archipelago.gg',
  port: 52011,
  lastActivity: null,
  timeoutS: 7200,
  players: [],
  downloads: [],
  trackerUrl: null,
}

describe('buildShareText', () => {
  it('share text includes address, slots and password only when asked', () => {
    expect(buildShareText(SESSION, ADDRESSES, { password: null }, en)).toBe(
      [
        'Archipelago game: Soirée Zelda',
        'Address (local network): 192.168.1.20:38281',
        'Address (Internet): 82.64.1.2:38281',
        'Slots:',
        '- Alice (A Link to the Past)',
        '- Bob (Super Metroid)',
      ].join('\n'),
    )

    const withPassword = buildShareText(SESSION, ADDRESSES, { password: 'hunter2' }, en)
    expect(withPassword).toContain('Address (Internet): 82.64.1.2:38281\nPassword: hunter2\nSlots:')
    // An empty password is no password.
    expect(buildShareText(SESSION, ADDRESSES, { password: '' }, en)).not.toMatch(/password/i)
  })

  it('shares localhost only when the server has no other address', () => {
    const text = buildShareText(SESSION, ADDRESSES.slice(0, 1), { password: null }, en)
    expect(text).toContain('Address: localhost:38281')
  })

  it('shares the archipelago.gg address and the room link of a web room', () => {
    expect(buildShareText(SESSION, ROOM, { password: 'hunter2' }, en)).toBe(
      [
        'Archipelago game: Soirée Zelda',
        'Address: archipelago.gg:52011',
        'Room: https://archipelago.gg/room/room1',
        'Password: hunter2',
        'Slots:',
        '- Alice (A Link to the Past)',
        '- Bob (Super Metroid)',
      ].join('\n'),
    )
    // A sleeping room has no port yet: the room link is enough.
    const asleep = buildShareText(SESSION, { ...ROOM, port: null }, { password: null }, en)
    expect(asleep).not.toContain('Address')
    expect(asleep).toContain('Room: https://archipelago.gg/room/room1')
  })

  it('leaves the slots out when the game has no generation', () => {
    const text = buildShareText({ ...SESSION, generation: null }, ADDRESSES, { password: null }, en)
    expect(text).not.toContain('Slots')
  })

  it('speaks French with French punctuation', () => {
    const text = buildShareText(SESSION, ADDRESSES, { password: 'hunter2' }, fr)
    expect(text.split('\n')).toEqual([
      'Partie Archipelago : Soirée Zelda',
      'Adresse (réseau local) : 192.168.1.20:38281',
      'Adresse (Internet) : 82.64.1.2:38281',
      'Mot de passe : hunter2',
      'Slots :',
      '- Alice (A Link to the Past)',
      '- Bob (Super Metroid)',
    ])
  })
})
