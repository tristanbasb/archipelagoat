// Maps the text Archipelago 0.6.8 prints when something fails to one of our error codes, plus the
// values the translated message needs (`params`). The main process never builds a message from this:
// the renderer shows `t('errors.<code>', params)`. Every entry names the source line of the message.
//
// - The first entry that matches wins, so the entries run from the most specific cause to the most
//   general one: a YAML error is reported as `File X is invalid. Please fix your yaml.` followed by
//   its cause, and the cause is what we want to show.
// - The text can be huge (a FillError appends every placement, megabytes of one line). Each pattern
//   therefore starts with a literal or is anchored to the start of a line (`^` with the `m` flag),
//   so none of them is quadratic on a long line (the tests run a 2 MB line through all of them).
import type { ErrorCode } from '../codes'
import { ROM_TABLE } from './rom-table'

export interface ApError {
  code: ErrorCode
  re: RegExp
  /** The parameters of the translated message, from the match. */
  params?: (m: RegExpMatchArray) => Record<string, string>
}

const MAX_PARAM_LENGTH = 300

/** The parameters that have a value, each cut to a sane length (the text it comes from can be huge). */
function given(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => [key, value.slice(0, MAX_PARAM_LENGTH)]),
  )
}

/** `Version(major=0, minor=6, build=9)` or `(0, 6, 9)` as `0.6.9`. */
function dotted(version: string): string {
  const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(version)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : version.trim()
}

// The ROMs the host needs to generate end in one of these: the extensions of the ROM table entries
// that are required at generation.
const GENERATION_ROM_EXTENSIONS = [
  ...new Set(ROM_TABLE.filter((entry) => entry.requiredAtGeneration).flatMap((entry) => entry.extensions)),
]
  .map((extension) => extension.slice(1))
  .join('|')

export const AP_ERRORS: ApError[] = [
  // --- Player files (Generate.py) ---
  {
    // Generate.py:594 and :591 (the world exists but failed to load)
    code: 'AP_WORLD_NOT_FOUND',
    re: /No (?<functional>functional )?world found to handle game (?<game>.+?)\. Did you mean '(?<suggestion>.+?)' \((?<percent>\d+)% sure\)\?/,
    params: (m) =>
      given({
        game: m.groups?.game,
        suggestion: m.groups?.suggestion,
        percent: m.groups?.percent,
        loadFailed: m.groups?.functional === undefined ? undefined : 'true',
      }),
  },
  {
    // Generate.py:598
    code: 'AP_NO_GAME_OPTIONS',
    re: /No game options for selected game "(?<game>.+?)" found\./,
    params: (m) => given({ game: m.groups?.game }),
  },
  {
    // Generate.py:144
    code: 'AP_QUANTITY_DISABLED',
    re: /Quantity greater than 1 is deactivated by host settings\./,
  },
  {
    // Generate.py:553: `requires: version`
    code: 'AP_VERSION_REQUIRED',
    re: /Settings reports required version of generator is at least (?<required>[^\s,]+), however generator is of version (?<current>\d+(?:\.\d+)*)/,
    params: (m) => given({ required: m.groups?.required, current: m.groups?.current }),
  },
  {
    // Generate.py:569 and :573: `requires: game:` with a minimum or a maximum world version
    code: 'AP_VERSION_REQUIRED',
    re: /Settings reports required version of world "(?<game>.+?)" is (?<bound>at least|no later than) (?<required>[^\s,]+), however world is of version (?<current>\d+(?:\.\d+)*)/,
    params: (m) =>
      given({
        game: m.groups?.game,
        bound: m.groups?.bound === 'at least' ? 'min' : 'max',
        required: m.groups?.required,
        current: m.groups?.current,
      }),
  },
  {
    // Generate.py:558: PlandoOptions.__str__ joins the flag names (BaseClasses.py:1988)
    code: 'AP_PLANDO_DISABLED',
    re: /Settings reports required plando module (?<module>.+?), which is not enabled\./,
    params: (m) => given({ module: m.groups?.module }),
  },
  {
    // Generate.py:291
    code: 'AP_NAMES_NOT_UNIQUE',
    re: /Names have to be unique\./,
  },

  // --- Fill (Fill.py, Main.py): `Fill.FillError: <message>` ---
  {
    // Main.py:367
    code: 'AP_FILL_UNBEATABLE',
    re: /FillError: Game appears as unbeatable\. Aborting\./,
  },
  {
    // Fill.py:975 and :1079
    code: 'AP_FILL_NO_SPOTS',
    re: /FillError: No more spots to place (?<count>\d+) items\./,
    params: (m) => given({ count: m.groups?.count }),
  },
  {
    // Fill.py:1350
    code: 'AP_FILL_NOT_ENOUGH_LOCATIONS',
    re: /FillError: Not enough locations for progression items\. There are (?<count>\d+) more progression items/,
    params: (m) => given({ count: m.groups?.count }),
  },
  {
    // Fill.py:1403 (Unable to fill all locations), :1458 and the FillErrors of the worlds
    code: 'AP_FILL_FAILED',
    re: /FillError: (?<message>.+)/,
    params: (m) => given({ message: m.groups?.message }),
  },

  // --- ROMs ---
  {
    // settings.py:96, raised when a required path setting is read and its file is missing
    code: 'AP_ROM_MISSING',
    re: /^(?:[\w.]+Error: )?(?<path>.+?) does not exist, but (?<key>\w+\.\w+) is required$/m,
    params: (m) => given({ path: m.groups?.path, key: m.groups?.key }),
  },
  {
    // lufia2ac/__init__.py:78
    code: 'AP_ROM_MISSING',
    re: /^(?:[\w.]+Error: )?Could not find base ROM for (?<game>.+?): (?<path>.+)$/m,
    params: (m) => given({ game: m.groups?.game, path: m.groups?.path }),
  },
  {
    // alttp, mmbn3, smw, soe, tloz and yoshisisland raise FileNotFoundError(<rom path>) in stage_assert_generate
    code: 'AP_ROM_MISSING',
    re: new RegExp(String.raw`^FileNotFoundError: (?<path>.+\.(?:${GENERATION_ROM_EXTENSIONS}))$`, 'im'),
    params: (m) => given({ path: m.groups?.path }),
  },
  {
    // settings.py:439
    code: 'AP_ROM_HASH',
    re: /File hash does not match for (?<path>.+?)\s*$/m,
    params: (m) => given({ path: m.groups?.path }),
  },
  {
    // settings.py:505: a SNES ROM whose size is not a multiple of 1024, with or without a 512 byte header
    code: 'AP_ROM_HASH',
    re: /Unexpected file size for (?<path>.+?)\s*$/m,
    params: (m) => given({ path: m.groups?.path }),
  },
  {
    // `Supplied Base Rom does not match known MD5 ...` of each world's Rom.py (alttp/Rom.py:2929 and others)
    code: 'AP_ROM_HASH',
    re: /Supplied Base ROM does not match known MD5/i,
  },

  // --- Server and multidata (MultiServer.py) ---
  {
    // MultiServer.py:535
    code: 'AP_MULTIDATA_INCOMPATIBLE',
    re: /Incompatible multidata\./,
  },
  {
    // MultiServer.py:545
    code: 'AP_SERVER_TOO_OLD',
    re: /requires a server of at least version (?<required>.+?), however this server is of version (?<current>.+?)\s*$/m,
    params: (m) =>
      given({ required: dotted(m.groups?.required ?? ''), current: dotted(m.groups?.current ?? '') }),
  },
  {
    // MultiServer.py:523
    code: 'AP_NO_ARCHIPELAGO_IN_ZIP',
    re: /No \.archipelago found in archive\./,
  },
  {
    // The bind of the server fails (asyncio, after the Hosting line): [Errno 10048] on Windows (the system
    // message is localized, the code is not), [Errno 98] on Linux.
    code: 'AP_PORT_IN_USE',
    re: /\[Errno (?:10048|98)\] error while attempting to bind on address \('[^']*', (?<port>\d+)|\[(?:Errno|WinError) (?:10048|98)\]|address already in use/i,
    params: (m) => given({ port: m.groups?.port }),
  },

  // --- Main process codes with a symptom in the output (no message of AP 0.6.8 says either) ---
  {
    // Brief 1.3, issue #6443: the AppImage cannot find the component it is asked to run.
    code: 'AP_NOT_INSTALLED',
    re: /\b(?<command>Archipelago\w+):? command not found/,
    params: (m) => given({ command: m.groups?.command }),
  },
  {
    // settings.py:864-868 renames `<settings>.tmp` over the settings file, which Windows refuses
    // (WinError 32, or 5) while another Archipelago program has the file open.
    code: 'AP_RUNNING',
    re: /PermissionError: \[WinError (?:5|32)\][^\n]*\b(?:host|options)\.yaml/,
  },

  // --- General ---
  {
    // Generate.py:154, :228 and :282: the error of one player file, wrapped around its cause. Every
    // cause above is more specific, so this one only gives the syntax errors and the rest.
    code: 'AP_YAML_INVALID',
    re: /File (?<file>.+?)(?: document #(?<document>\d+) \(with name: .*?\))? is invalid\. Please fix your yaml\./,
    params: (m) => {
      // A YAML syntax error is `<context> <problem> on line N:`, the lines, then a caret line
      // (Generate.py:323-324). N is the 0-based line of the problem, so the 1-based one is N + 1.
      const afterFile = (m.input ?? '').slice((m.index ?? 0) + m[0].length)
      const thisError = afterFile.split(/\r?\n\r?\n(?=\d+\. )/, 1)[0] ?? ''
      const position = /on line (?<line>\d+):\r?\n[\s\S]*?\r?\n(?<indent> *)\^[ \t]*(?:\r?\n|$)/.exec(
        thisError,
      )
      return given({
        file: m.groups?.file,
        document: m.groups?.document,
        line: position?.groups?.line === undefined ? undefined : String(Number(position.groups.line) + 1),
        column:
          position?.groups?.indent === undefined ? undefined : String(position.groups.indent.length + 1),
      })
    },
  },
  {
    // Generate.py:172, :185, :233 and :296: the errors of the player files, when no file is named
    code: 'AP_YAML_INVALID',
    re: /Encountered (?<count>\d+) error\(s\) in player files\./,
    params: (m) => given({ count: m.groups?.count }),
  },
  {
    // Any other Python exception: the last resort. A text without an exception gives no match, so the
    // caller can tell "AP failed in a way we know nothing about" from "AP reported an exception".
    code: 'AP_UNKNOWN',
    re: /^(?<type>[A-Za-z_][\w.]*(?:Error|Exception))(?::[ \t]*(?<message>.*))?$/m,
    params: (m) => given({ type: m.groups?.type, message: m.groups?.message }),
  },
]

/** The error code and message parameters for the first entry the text matches, or null. */
export function matchApError(text: string): { code: ErrorCode; params: Record<string, string> } | null {
  for (const entry of AP_ERRORS) {
    const m = entry.re.exec(text)
    if (m) return { code: entry.code, params: entry.params?.(m) ?? {} }
  }
  return null
}
