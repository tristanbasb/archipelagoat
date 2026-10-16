import { redact } from '@main/core/system/redact'

describe('redact', () => {
  describe('Archipelago output', () => {
    it('masks the password of the Hosting line', () => {
      expect(redact('Hosting game at 1.2.3.4:38281 (Password: hunter2)')).toBe(
        'Hosting game at 1.2.3.4:38281 (Password: •••)',
      )
    })

    it('masks a Hosting password that holds spaces and parentheses, and keeps what follows the line', () => {
      expect(redact('Hosting game at 1.2.3.4:38281 (Password: a) b(c)\nnext line')).toBe(
        'Hosting game at 1.2.3.4:38281 (Password: •••)\nnext line',
      )
    })

    it('leaves a Hosting line without password alone', () => {
      const line = 'Hosting game at 1.2.3.4:38281 (No password)'
      expect(redact(line)).toBe(line)
    })

    it('masks the password of an URI and keeps the slot name', () => {
      expect(redact('archipelago://Bob:s3cr3t@host:1')).toBe('archipelago://Bob:•••@host:1')
    })

    it('masks an URI password that holds a raw @ and keeps the query', () => {
      expect(redact('connecting to archipelago://Bob:p@ss:w0rd@host:38281?game=A%20B now')).toBe(
        'connecting to archipelago://Bob:•••@host:38281?game=A%20B now',
      )
    })

    it('leaves URIs without a password alone', () => {
      for (const uri of [
        'archipelago://Bob@host:1',
        'ws://localhost:38281/',
        'https://archipelago.gg/room/abc',
        'ws://host:38281/path@thing',
      ]) {
        expect(redact(uri)).toBe(uri)
      }
    })

    it('masks the password of the refused-connection line and keeps the rest', () => {
      const line =
        "A client connection was refused due to: {'InvalidPassword'}, the sent connect information was " +
        "{'cmd': 'Connect', 'password': 'hunter2', 'game': 'A Link to the Past', 'name': 'Bob', 'uuid': 'u'}."
      expect(redact(line)).toBe(
        "A client connection was refused due to: {'InvalidPassword'}, the sent connect information was " +
          "{'cmd': 'Connect', 'password': '•••', 'game': 'A Link to the Past', 'name': 'Bob', 'uuid': 'u'}.",
      )
    })

    it('masks a refused-connection password that python prints with double quotes or escapes', () => {
      expect(redact(`{'cmd': 'Connect', 'password': "it's", 'name': 'Bob'}`)).toBe(
        `{'cmd': 'Connect', 'password': "•••", 'name': 'Bob'}`,
      )
      expect(redact(String.raw`{'password': 'it\'s "x"', 'name': 'Bob'}`)).toBe(
        `{'password': '•••', 'name': 'Bob'}`,
      )
    })

    it('leaves a refused-connection line that sent no password alone', () => {
      const line = "{'cmd': 'Connect', 'password': None, 'name': 'Bob'}"
      expect(redact(line)).toBe(line)
    })

    it('masks the output of /options', () => {
      expect(redact('Option server_password is set to adm1n')).toBe('Option server_password is set to •••')
      expect(redact('Option password is set to hunter2')).toBe('Option password is set to •••')
      expect(redact('Option hint_cost is set to 10')).toBe('Option hint_cost is set to 10')
    })

    it('masks the echo of a password change (Set option … to …)', () => {
      expect(redact('Set option password to hunter2')).toBe('Set option password to •••')
      expect(redact('Set option server_password to adm1n')).toBe('Set option server_password to •••')
      expect(redact('Set option server_password to adm1n s3')).toBe('Set option server_password to •••')
      expect(redact('[12:00:01] Set option password to a (b) c')).toBe(
        '[12:00:01] Set option password to •••',
      )
      expect(redact('Set option hint_cost to 10')).toBe('Set option hint_cost to 10')
    })

    it('masks the /option password commands typed in the console', () => {
      expect(redact('/option password hunter2')).toBe('/option password •••')
      expect(redact('> /option server_password two words')).toBe('> /option server_password •••')
      expect(redact('!admin /option server_password adm1n')).toBe('!admin /option server_password •••')
      expect(redact('/option hint_cost 10')).toBe('/option hint_cost 10')
    })
  })

  describe('YAML, JSON and web traffic', () => {
    it('masks password and server_password values in YAML', () => {
      const yaml = [
        'server_options:',
        '  password: hunter2',
        '  server_password: "a b" # admin',
        '  port: 38281',
      ].join('\n')
      expect(redact(yaml)).toBe(
        ['server_options:', '  password: •••', '  server_password: •••', '  port: 38281'].join('\n'),
      )
    })

    it('keeps CRLF line endings and does not touch other keys', () => {
      expect(redact('name: Bob\r\npassword: x\r\npasswords: y\r\nmy_password: z\r\n')).toBe(
        'name: Bob\r\npassword: •••\r\npasswords: y\r\nmy_password: z\r\n',
      )
    })

    it('leaves an empty value alone', () => {
      expect(redact('password:\nserver_password:   \n')).toBe('password:\nserver_password:   \n')
    })

    it('masks quoted password keys of JSON, even inside a logged line', () => {
      expect(redact('2026-10-16T10:00:00.000Z INFO sent {"server_password":"ad\\"m1n","port":1}')).toBe(
        '2026-10-16T10:00:00.000Z INFO sent {"server_password":"•••","port":1}',
      )
    })

    it('masks the session cookie', () => {
      expect(redact('Set-Cookie: session=eyJfaWQiOnt9fQ.abc-def_1.xyz; Path=/; HttpOnly')).toBe(
        'Set-Cookie: session=•••; Path=/; HttpOnly',
      )
      expect(redact('Cookie: theme=dark; session=abc123')).toBe('Cookie: theme=dark; session=•••')
    })

    it('masks the session UUID of /session/<uuid>', () => {
      expect(redact('GET https://archipelago.gg/session/2f9c8a3e-1b7d-4c5e-9a6f-0d2e4b8c1a73 200')).toBe(
        'GET https://archipelago.gg/session/••• 200',
      )
      expect(redact('GET /session 200')).toBe('GET /session 200')
    })
  })

  describe('extra secrets', () => {
    it('masks every occurrence of a literal secret', () => {
      expect(redact('token=hunter2 and again hunter2', ['hunter2'])).toBe('token=••• and again •••')
    })

    it('treats secrets as plain text, not as patterns', () => {
      expect(redact('x a.b*c(d y aXbbbc(d', ['a.b*c(d'])).toBe('x ••• y aXbbbc(d')
    })

    it('masks the longest secret first and ignores empty ones', () => {
      expect(redact('abcdef and abc', ['abc', '', 'abcdef'])).toBe('••• and •••')
    })

    it('masks the JSON-escaped and URL-encoded forms of a secret', () => {
      const secret = 'p"a@s/s'
      expect(redact(`json ${JSON.stringify(secret)} url ${encodeURIComponent(secret)}`, [secret])).toBe(
        'json "•••" url •••',
      )
    })
  })

  describe('as a whole', () => {
    it('masks several secrets in one text', () => {
      const text = [
        'Hosting game at 1.2.3.4:38281 (Password: one)',
        'Option server_password is set to two',
        'archipelago://Bob:three@host:1',
        'extra four',
      ].join('\n')
      const out = redact(text, ['four'])
      for (const secret of ['one', 'two', 'three', 'four']) expect(out).not.toContain(secret)
      expect(out.split('\n')).toEqual([
        'Hosting game at 1.2.3.4:38281 (Password: •••)',
        'Option server_password is set to •••',
        'archipelago://Bob:•••@host:1',
        'extra •••',
      ])
    })

    it('is idempotent', () => {
      const text = 'Hosting game at h:1 (Password: x)\npassword: y\narchipelago://B:z@h:1\nsession=abc'
      expect(redact(redact(text))).toBe(redact(text))
    })

    it('returns text without secrets unchanged', () => {
      const text = 'Generating game 1 for Bob\nFilling...\nCreating final archive at C:\\out\\AP_1.zip'
      expect(redact(text)).toBe(text)
      expect(redact('')).toBe('')
    })

    it('takes linear time on very long lines (every log line goes through it)', () => {
      const lines = [
        'x'.repeat(2_000_000),
        'a:'.repeat(1_000_000),
        'Hosting game at '.repeat(100_000),
        "'password': '" + 'ab'.repeat(500_000),
        'http://a:b '.repeat(200_000),
      ]
      const start = performance.now()
      for (const line of lines) redact(line, ['secret'])
      expect(performance.now() - start).toBeLessThan(3000)
    })
  })
})
