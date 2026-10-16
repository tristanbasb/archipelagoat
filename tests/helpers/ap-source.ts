// Static reading of the Archipelago source tree (AP_SRC, tag 0.6.8), only to check the data tables
// against it. Nothing is executed or imported: the Python is read as text.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WorldSource {
  folder: string
  /** worlds/<folder>/__init__.py */
  initSource: string
  /** Every .py of the world (tests excluded), `__init__.py` included. */
  sources: string[]
}

export interface RomSetting {
  /** Attribute of the settings group, e.g. `rom_file` or `red_rom_file`. */
  attr: string
  /** Settings class that declares `md5s`, e.g. `RedRomFile`. */
  className: string
  /** Base class, e.g. `settings.SNESRomPath`. */
  base: string
  /** The accepted hashes, resolved from the constants the `md5s` list names. */
  md5s: string[]
}

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const stripComments = (text: string): string => text.replace(/#[^\n]*/g, '')

export function loadWorld(apSrc: string, folder: string): WorldSource {
  const dir = join(apSrc, 'worlds', folder)
  const files = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.py') && !/(^|[\\/])test[\\/]/.test(file))
  return {
    folder,
    initSource: read(join(dir, '__init__.py')),
    sources: files.map((file) => read(join(dir, file))),
  }
}

/** Folders of worlds/ with an __init__.py that are worlds (names starting with _ or . are not). */
export function worldFolders(apSrc: string): string[] {
  return readdirSync(join(apSrc, 'worlds'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name))
    .filter((e) => existsSync(join(apSrc, 'worlds', e.name, '__init__.py')))
    .map((e) => e.name)
}

/** `settings_key` of a world: the explicit one, else `<folder>_options` (worlds/AutoWorld.py:101-104). */
export function settingsKeyOf(world: WorldSource): string {
  return (
    /^\s+settings_key\s*=\s*["'](\w+)["']/m.exec(world.initSource)?.[1] ??
    `${world.folder.toLowerCase()}_options`
  )
}

/** The text after `<start>` up to the bracket that closes the list (or to the end of the line). */
function expressionAt(text: string, start: number): string {
  const rest = text.slice(start)
  if (!rest.trimStart().startsWith('[')) return rest.split('\n')[0] ?? ''
  const open = rest.indexOf('[')
  return rest.slice(open, rest.indexOf(']', open) + 1)
}

/** Hex strings an expression such as `[USHASH, Patch.hash, "ab..."]` stands for. */
function resolveHashes(expression: string, sources: string[], depth = 0): string[] {
  if (depth > 6) throw new Error(`hash expression too deep: ${expression}`)
  const expr = stripComments(expression).trim()
  if (expr.startsWith('[')) {
    return expr
      .slice(1, expr.lastIndexOf(']'))
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .flatMap((part) => resolveHashes(part, sources, depth + 1))
  }
  const literal = /^["']([0-9a-fA-F]{32})["']$/.exec(expr)
  if (literal) return [literal[1]?.toLowerCase() ?? '']
  const classAttr = /^(\w+)\.hash$/.exec(expr)
  if (classAttr) {
    for (const source of sources) {
      const body = new RegExp(
        `^class\\s+${classAttr[1]}\\b[^\\n]*\\n((?:[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*)`,
        'm',
      ).exec(source)?.[1]
      const assignment = body === undefined ? null : /^ {4}hash\s*(?::[^=\n]+)?=\s*/m.exec(body)
      if (body !== undefined && assignment) {
        return resolveHashes(expressionAt(body, assignment.index + assignment[0].length), sources, depth + 1)
      }
    }
    throw new Error(`class ${classAttr[1]} with a hash not found`)
  }
  if (/^\w+$/.test(expr)) {
    for (const source of sources) {
      const assignment = new RegExp(`^${expr}\\s*(?::[^=\\n]+)?=\\s*`, 'm').exec(source)
      if (assignment)
        return resolveHashes(
          expressionAt(source, assignment.index + assignment[0].length),
          sources,
          depth + 1,
        )
    }
    throw new Error(`constant ${expr} not found`)
  }
  throw new Error(`cannot read hash expression: ${expr}`)
}

/** The settings classes of a world that declare `md5s`, with the attribute that holds each one. */
export function romSettings(world: WorldSource): RomSetting[] {
  const found: RomSetting[] = []
  const header = /^ {4}class\s+(\w+)\(([^)]*)\):[^\n]*\n((?: {8,}[^\n]*\n|[ \t]*\n)*)/gm
  for (const m of world.initSource.matchAll(header)) {
    const [, className = '', base = '', body = ''] = m
    const md5s = /^\s+md5s\s*=\s*/m.exec(body)
    if (!md5s) continue
    const attr = new RegExp(`^ {4}(\\w+)\\s*:\\s*${className}\\b`, 'm').exec(world.initSource)?.[1]
    if (attr === undefined) throw new Error(`${world.folder}: no attribute of type ${className}`)
    found.push({
      attr,
      className,
      base: base.trim(),
      md5s: resolveHashes(expressionAt(body, md5s.index + md5s[0].length), world.sources),
    })
  }
  return found
}

/** Whether `stage_assert_generate` of the world looks for a ROM (it is how generation asks for one). */
export function needsRomAtGeneration(world: WorldSource): boolean {
  const code = stripComments(world.initSource)
  const method = /def stage_assert_generate\([^)]*\)[^\n]*\n((?:[ \t]+[^\n]*\n|[ \t]*\n)*)/.exec(code)?.[1]
  return method !== undefined && /rom_file|get_base_rom_path|\bRom\(/.test(method)
}
