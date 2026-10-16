// Masks the secrets that Archipelago and the web site print or send (brief §6.3): everything the app
// logs, shows or bundles for support goes through `redact` first.

export const MASK = '•••'

/** Not already masked, which keeps `redact` idempotent and leaves a mask that holds `)` whole. */
const NOT_MASKED = `(?!${MASK})`

// Every rule works on one line of text: `[^\r\n]` never crosses a line end, and `$` (with the `m`
// flag) stops before `\r` or `\n`, so CRLF text keeps its line endings.
const RULES: readonly (readonly [RegExp, string])[] = [
  // `Hosting game at 1.2.3.4:38281 (Password: <pw>)`: MultiServer.py logs the password raw, and it
  // may hold spaces or `)`, so it runs up to the last `)` of the line.
  [/(Hosting game at \S+[ \t]+\(Password: )[^\r\n]*?(\)?[ \t]*$)/gim, `$1${MASK}$2`],

  // `'password': '…'` as Python prints a dict (the refused-connection line: `A client connection was
  // refused due to: {…}, the sent connect information was {'cmd': 'Connect', 'password': …}`), and
  // `"password": "…"` as JSON, which is how the logger writes the `data` of an entry. A string that
  // holds a quote is printed with the other kind, hence both.
  [/(["'])((?:server_)?password)\1([ \t]*:[ \t]*)"(?:[^"\\\r\n]|\\.)*"/gi, `$1$2$1$3"${MASK}"`],
  [/(["'])((?:server_)?password)\1([ \t]*:[ \t]*)'(?:[^'\\\r\n]|\\.)*'/gi, `$1$2$1$3'${MASK}'`],

  // YAML (host.yaml, a session's server options): the whole value, even with spaces or a comment.
  [new RegExp(`(\\b(?:server_)?password[ \\t]*:[ \\t]*)(?=\\S)${NOT_MASKED}[^\\r\\n]*`, 'gi'), `$1${MASK}`],

  // `scheme://user:pass@host`: the password only. It may hold a raw `@` (the last one is the
  // separator), but never `/`, `?` or `#`. The rule starts at `://` and ignores the scheme: looking
  // for one from every letter of a long word would take quadratic time.
  [/(:\/\/[^\s:/@?#]*:)[^\s/?#]*(?=@)/g, `$1${MASK}`],

  // `/options` output (MultiServer.py `_cmd_options`).
  [new RegExp(`(Option (?:server_)?password is set to )(?=\\S)${NOT_MASKED}[^\\r\\n]*`, 'gi'), `$1${MASK}`],

  // `Set option password to <pw>`: the echo MultiServer.py prints after every `/option` (`_cmd_option`),
  // with the value as it was stored, so it may hold spaces.
  [new RegExp(`(Set option (?:server_)?password to )(?=\\S)${NOT_MASKED}[^\\r\\n]*`, 'gi'), `$1${MASK}`],

  // `/option password <pw>` typed in the console (also after `!admin`).
  [
    new RegExp(`(\\/option[ \\t]+(?:server_)?password[ \\t]+)(?=\\S)${NOT_MASKED}[^\\r\\n]*`, 'gi'),
    `$1${MASK}`,
  ],

  // archipelago.gg: the Flask session cookie, and the identity UUID that `/session/<uuid>` rebinds
  // (whoever knows it is that user).
  [/(\bsession=)[^;\s"',]+/gi, `$1${MASK}`],
  [/(\/session\/)[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi, `$1${MASK}`],
]

/** A secret as it may appear in text: raw, JSON-escaped (a logged `data`) or URL-encoded. */
function forms(secret: string): string[] {
  return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]
}

/**
 * Replaces the secrets of `text` with `•••`: the known Archipelago and archipelago.gg patterns, then
 * every literal of `extraSecrets` (a password the caller knows, e.g. a session's). Safe to apply twice.
 */
export function redact(text: string, extraSecrets: readonly string[] = []): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  // The longest first, so that a secret that contains another one is masked whole.
  const literals = [...new Set(extraSecrets.filter((s) => s !== '').flatMap(forms))].sort(
    (a, b) => b.length - a.length,
  )
  for (const literal of literals) out = out.replaceAll(literal, MASK)
  return out
}
