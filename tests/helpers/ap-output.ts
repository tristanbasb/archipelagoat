// Reads the captured Archipelago output fixtures (tests/fixtures/ap-output) as text.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function apOutput(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/ap-output/${name}`, import.meta.url)), 'utf8')
}

/** The fixture lines, without the empty string a trailing newline would leave. */
export function apOutputLines(name: string): string[] {
  const lines = apOutput(name).split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}
