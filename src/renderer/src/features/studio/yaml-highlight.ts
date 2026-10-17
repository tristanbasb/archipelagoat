// A line-by-line YAML tokenizer for the Studio's live preview: enough to colour what the writer
// produces (block mappings and sequences, scalars, comments), not a YAML parser. Joining the tokens
// of a line gives the line back exactly.

export type YamlTokenKind =
  'key' | 'punct' | 'plain' | 'string' | 'quoted' | 'number' | 'bool' | 'null' | 'comment'

export interface YamlToken {
  kind: YamlTokenKind
  text: string
}

const QUOTED = /^("(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?)/
const QUOTED_KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(\s*):(?=\s|$)/
/** A plain key: up to the first `:` followed by a space or the end of the line. */
const PLAIN_KEY = /^([^\s#'"{}[\],&*!|>%@`][^#]*?)(\s*):(?=\s|$)/
const NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$|^0x[0-9a-f]+$|^0o?[0-7]+$/i
/** YAML 1.1 booleans, the ones PyYAML reads. */
const BOOL = /^(?:true|false|yes|no|on|off|y|n)$/i
const NULL = /^(?:null|~)$/i

function push(tokens: YamlToken[], kind: YamlTokenKind, text: string): void {
  if (text !== '') tokens.push({ kind, text })
}

function scalarKind(text: string): YamlTokenKind {
  if (
    text.startsWith('{') ||
    text.startsWith('[') ||
    text === '|' ||
    text === '>' ||
    /^[|>][-+]?\d*$/.test(text)
  )
    return 'punct'
  if (NUMBER.test(text)) return 'number'
  if (BOOL.test(text)) return 'bool'
  if (NULL.test(text)) return 'null'
  return 'string'
}

/** A value and what follows it on the line: trailing spaces, a comment. */
function value(tokens: YamlToken[], text: string): void {
  const lead = /^\s*/.exec(text)?.[0] ?? ''
  push(tokens, 'plain', lead)
  let rest = text.slice(lead.length)
  if (rest.startsWith('#')) {
    push(tokens, 'comment', rest)
    return
  }
  let body: string
  let kind: YamlTokenKind
  const quoted = QUOTED.exec(rest)
  if (quoted?.[1] && (rest.startsWith('"') || rest.startsWith("'"))) {
    body = quoted[1]
    kind = 'quoted'
  } else {
    // A plain scalar ends where ` #` starts a comment.
    const comment = /\s#/.exec(rest)
    body = (comment ? rest.slice(0, comment.index) : rest).trimEnd()
    kind = scalarKind(body)
  }
  push(tokens, kind, body)
  rest = rest.slice(body.length)
  if (/^\s*#/.test(rest)) push(tokens, 'comment', rest)
  else push(tokens, 'plain', rest)
}

function line(text: string): YamlToken[] {
  const tokens: YamlToken[] = []
  const indent = /^\s*/.exec(text)?.[0] ?? ''
  push(tokens, 'plain', indent)
  let rest = text.slice(indent.length)
  if (rest === '') return tokens
  if (rest.startsWith('#')) {
    push(tokens, 'comment', rest)
    return tokens
  }
  if (/^(?:---|\.\.\.)\s*$/.test(rest)) {
    push(tokens, 'punct', rest)
    return tokens
  }
  // Sequence entries: `- `, possibly nested (`- - a`).
  for (let dash = /^-(\s+|$)/.exec(rest); dash; dash = /^-(\s+|$)/.exec(rest)) {
    push(tokens, 'punct', '-')
    push(tokens, 'plain', dash[1] ?? '')
    rest = rest.slice(dash[0].length)
  }
  const key = QUOTED_KEY.exec(rest) ?? PLAIN_KEY.exec(rest)
  if (key?.[1] !== undefined) {
    push(tokens, 'key', key[1])
    push(tokens, 'plain', key[2] ?? '')
    push(tokens, 'punct', ':')
    rest = rest.slice(key[0].length)
  }
  if (rest !== '') value(tokens, rest)
  return tokens
}

/** The tokens of each line of `text`. */
export function highlightYaml(text: string): YamlToken[][] {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line)
}
