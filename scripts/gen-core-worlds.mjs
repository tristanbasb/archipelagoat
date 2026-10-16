// Generates resources/core-worlds-<version>.json from a read-only Archipelago source tree.
//
// The tree is only read, never executed or imported: each world is found by reading the Python
// sources of worlds/<module>/ as text and taking the `game` attribute of its World subclass. The
// "loose" flag comes from the `non_apworlds` set in setup.py: the games the frozen build keeps as
// plain folders instead of packing them into an .apworld (research brief 1.10).
//
// Usage: node scripts/gen-core-worlds.mjs [<ap-src>] [--check]
//   <ap-src>  Archipelago source tree (default: the AP_SRC environment variable)
//   --check   write nothing; exit 1 when the committed JSON differs from what the tree gives
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = fileURLToPath(new URL('../resources/', import.meta.url))

function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** Python string literal at the start of `src` (either quote, simple escapes), or null. */
function pythonString(src) {
  const m = /^(["'])((?:\\.|(?!\1).)*)\1/.exec(src.trim())
  return m ? m[2].replace(/\\(["'\\])/g, '$1') : null
}

/** Every Python source of a world package (tests excluded), as { text } records. */
function packageSources(worldDir) {
  return readdirSync(worldDir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.py') && !/(^|[\\/])test[\\/]/.test(file))
    .sort()
    .map((file) => readText(join(worldDir, file)))
}

/** Body of `class <name>` (the lines indented under it), or null when the class is not declared. */
function classBodies(source, nameOrNull) {
  const bodies = []
  const header = /^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:[^\n]*\n((?:[ \t]+[^\n]*\n|[ \t]*\n)*)/gm
  for (const m of source.matchAll(header)) {
    if (nameOrNull === null || m[1] === nameOrNull) bodies.push({ name: m[1], bases: m[2] ?? '', body: m[3] })
  }
  return bodies
}

/** The value of one `game = ...` class attribute, resolved through constants or `Class.attr`. */
function resolveGame(expression, sources) {
  const literal = pythonString(expression)
  if (literal !== null) return literal
  const ref = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*(?:#.*)?$/.exec(expression.trim())
  if (ref === null) return null
  const [, first, attribute] = ref
  for (const source of sources) {
    if (attribute === undefined) {
      // `game = SOME_CONSTANT`
      const constant = new RegExp(`^${first}\\s*(?::[^=\\n]+)?=\\s*(.*)$`, 'm').exec(source)
      const value = constant === null ? null : pythonString(constant[1])
      if (value !== null) return value
    } else {
      // `game = SomeClass.attribute`
      for (const { body } of classBodies(source, first)) {
        const member = new RegExp(`^ {4}${attribute}\\s*(?::[^=\\n]+)?=\\s*(.*)$`, 'm').exec(body)
        const value = member === null ? null : pythonString(member[1])
        if (value !== null) return value
      }
    }
  }
  return null
}

/** The games registered by the World subclasses of one world package. */
function gamesOf(worldDir) {
  const sources = packageSources(worldDir)
  const games = new Set()
  for (const source of sources) {
    for (const { bases, body } of classBodies(source, null)) {
      // `World` as a whole word: AutoWorld.World, but not WebWorld.
      if (!/\bWorld\b/.test(bases)) continue
      const attribute = /^ {4}game\s*(?::[^=\n]+)?=\s*(.*)$/m.exec(body)
      if (attribute === null) continue
      const game = resolveGame(attribute[1], sources)
      if (game === null) throw new Error(`${worldDir}: cannot resolve game = ${attribute[1].trim()}`)
      games.add(game)
    }
  }
  return [...games]
}

/** The games setup.py keeps as loose folders (the `non_apworlds` set literal). */
function looseGames(apSrc) {
  const setup = readText(join(apSrc, 'setup.py'))
  const body = /^non_apworlds\s*(?::[^=\n]+)?=\s*\{([^}]*)\}/m.exec(setup)?.[1]
  if (body === undefined) throw new Error('non_apworlds not found in setup.py')
  const games = new Set()
  for (const line of body.split('\n')) {
    const value = pythonString(line)
    if (value !== null) games.add(value)
  }
  return games
}

function apVersionOf(apSrc) {
  const m = /^__version__\s*=\s*["']([^"']+)["']/m.exec(readText(join(apSrc, 'Utils.py')))
  if (m === null) throw new Error('__version__ not found in Utils.py')
  return m[1]
}

/** { apVersion, worlds: { module, game, loose }[] }, sorted by module then game. */
function generateCoreWorlds(apSrc) {
  const worldsDir = join(apSrc, 'worlds')
  const loose = looseGames(apSrc)
  const worlds = []
  for (const entry of readdirSync(worldsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // Same rule as AP: names starting with _ or . are not worlds; no __init__.py means no world.
    if (/^[._]/.test(entry.name) || !existsSync(join(worldsDir, entry.name, '__init__.py'))) continue
    const games = gamesOf(join(worldsDir, entry.name))
    // setup.py:395-402 asserts the same: a manifest game must equal the World class game.
    const manifestPath = join(worldsDir, entry.name, 'archipelago.json')
    if (existsSync(manifestPath)) {
      const { game } = JSON.parse(readText(manifestPath))
      if (!games.includes(game)) {
        throw new Error(`worlds/${entry.name}: manifest game "${game}" is not in [${games.join(', ')}]`)
      }
    }
    for (const game of games) worlds.push({ module: entry.name, game, loose: loose.has(game) })
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  worlds.sort((a, b) => order(a.module, b.module) || order(a.game, b.game))

  const known = new Set(worlds.map((w) => w.game))
  const unknown = [...loose].filter((game) => !known.has(game))
  if (unknown.length > 0) throw new Error(`setup.py names unknown games as loose: ${unknown.join(', ')}`)
  return { apVersion: apVersionOf(apSrc), worlds }
}

function main(argv) {
  const check = argv.includes('--check')
  const apSrc = argv.find((arg) => !arg.startsWith('--')) ?? process.env.AP_SRC
  if (!apSrc) {
    console.error('gen-core-worlds: pass the Archipelago source tree or set AP_SRC')
    return 2
  }
  if (!existsSync(join(apSrc, 'worlds')) || !existsSync(join(apSrc, 'setup.py'))) {
    console.error(`gen-core-worlds: ${apSrc} is not an Archipelago source tree (no worlds/ or setup.py)`)
    return 2
  }
  const data = generateCoreWorlds(apSrc)
  const text = `${JSON.stringify(data, null, 2)}\n`
  const outFile = join(OUT_DIR, `core-worlds-${data.apVersion}.json`)
  if (check) {
    const current = existsSync(outFile) ? readText(outFile) : null
    if (current === text) {
      console.log(`gen-core-worlds: ${outFile} is up to date (${data.worlds.length} worlds)`)
      return 0
    }
    console.error(`gen-core-worlds: ${outFile} differs from the Archipelago ${data.apVersion} source`)
    return 1
  }
  writeFileSync(outFile, text)
  const looseCount = data.worlds.filter((w) => w.loose).length
  console.log(`gen-core-worlds: wrote ${outFile} (${data.worlds.length} worlds, ${looseCount} loose)`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
