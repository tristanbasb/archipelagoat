// The editing model of the YAML Studio, shared by the main process (Task 13) and the renderer's Studio
// (Task 27). Pure functions without dependencies: they run in the renderer too. An EditorDoc holds:
// - `options`: the game section, one OptionValue per option:
//   - `value`: the value written as it is (a scalar, a list, a mapping);
//   - `weighted`: the weights of the values of a weighted option (Toggle, Choice, Range…);
//   - `raw`: YAML text, parsed when the doc is rendered (complex options, or what plain data cannot
//     hold exactly, such as boolean keys);
// - `extraRoot`: every other root key, as an OptionValue (`value` or `raw`), kept as it was read.
import type { EditorDoc, GameSchema, OptionValue } from './types'

/** A copy the doc owns: editing it never changes a schema or a preset. */
const copy = <T>(value: T): T => structuredClone(value)

/** `options` with `key` set in its place (or last), never through `__proto__` or another accessor. */
function withOption(
  options: Record<string, OptionValue>,
  key: string,
  value: OptionValue,
): Record<string, OptionValue> {
  const entries = Object.entries(options)
  const at = entries.findIndex(([k]) => k === key)
  if (at === -1) entries.push([key, value])
  else entries[at] = [key, value]
  return Object.fromEntries(entries)
}

/**
 * A new doc for `schema`'s game: every option at its default (options without one are left out, so
 * Archipelago uses its own) and `requires.version` set to the schema's version.
 */
export function docFromSchema(schema: GameSchema, name: string): EditorDoc {
  const options = schema.groups
    .flatMap((group) => group.options)
    .filter((option) => option.default !== null && option.default !== undefined)
    .map((option): [string, OptionValue] => [option.key, { mode: 'value', value: copy(option.default) }])
  return {
    name,
    description: '',
    game: schema.game,
    requiresVersion: schema.apVersion,
    options: Object.fromEntries(options),
    extraRoot: {},
  }
}

/**
 * `doc` with the values of a preset (`GameSchema.presets[name]`) set over its own. The options the
 * preset does not name keep their value: start from docFromSchema to reset them first.
 */
export function applyPreset(doc: EditorDoc, preset: Record<string, unknown>): EditorDoc {
  let options = doc.options
  for (const [key, value] of Object.entries(preset)) {
    if (value !== undefined) options = withOption(options, key, { mode: 'value', value: copy(value) })
  }
  return { ...doc, options }
}

/** `doc` with one option replaced. */
export function setOptionValue(doc: EditorDoc, key: string, v: OptionValue): EditorDoc {
  return { ...doc, options: withOption(doc.options, key, copy(v)) }
}
