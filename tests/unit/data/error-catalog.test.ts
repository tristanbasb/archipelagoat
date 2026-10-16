import { ERROR_CODES } from '@shared/codes'
import { AP_ERRORS, matchApError } from '@shared/data/error-catalog'
import { apOutput } from '../../helpers/ap-output'

const AP_CODES = ERROR_CODES.filter((code) => code.startsWith('AP_'))

describe('AP_ERRORS', () => {
  it('every AP_* error code has a catalog entry', () => {
    expect(AP_CODES.length).toBeGreaterThan(15)
    for (const code of AP_CODES) {
      expect(
        AP_ERRORS.some((entry) => entry.code === code),
        code,
      ).toBe(true)
    }
  })

  it('only maps to AP_* codes, so the catalog never invents a main process error', () => {
    for (const entry of AP_ERRORS) expect(entry.code.startsWith('AP_')).toBe(true)
  })

  it('has no stateful regex (no g or y flag), because entries are shared across calls', () => {
    for (const entry of AP_ERRORS) expect(entry.re.flags).not.toMatch(/[gy]/)
  })
})

describe('matchApError on captured output', () => {
  it('maps FillError text to AP_FILL_UNBEATABLE', () => {
    expect(matchApError(apOutput('generate-fill-error.txt'))).toEqual({
      code: 'AP_FILL_UNBEATABLE',
      params: {},
    })
  })

  it('maps a YAML syntax error to AP_YAML_INVALID with the file and the line and column of the caret', () => {
    // AP reports the 0-based line of the problem (line 2 = third line) and shows a caret at its column.
    expect(matchApError(apOutput('generate-yaml-error.txt'))).toEqual({
      code: 'AP_YAML_INVALID',
      params: { file: 'Bob.yaml', line: '3', column: '1' },
    })
  })

  it('finds nothing in a successful run, in the server startup or in the session log', () => {
    for (const name of ['generate-success.txt', 'server-startup.txt', 'server-session.txt']) {
      expect(matchApError(apOutput(name)), name).toBeNull()
    }
  })
})

describe('matchApError on generation errors', () => {
  it('maps a missing world to AP_WORLD_NOT_FOUND with params.game', () => {
    const text =
      "Exception: No world found to handle game Pokemon Emeraldd. Did you mean 'Pokemon Emerald' (93% sure)? " +
      'Check your spelling or installation of that world.'
    expect(matchApError(text)).toEqual({
      code: 'AP_WORLD_NOT_FOUND',
      params: { game: 'Pokemon Emeraldd', suggestion: 'Pokemon Emerald', percent: '93' },
    })
  })

  it('keeps dots and punctuation of the game name', () => {
    const text =
      "Exception: No world found to handle game Yu-Gi-Oh. 2006!. Did you mean 'Yu-Gi-Oh! 2006' (80% sure)? " +
      'Check your spelling or installation of that world.'
    expect(matchApError(text)?.params.game).toBe('Yu-Gi-Oh. 2006!')
  })

  it('tells a world that failed to load from one that is missing', () => {
    const text =
      "Exception: No functional world found to handle game Tunic. Did you mean 'TUNIC' (60% sure)? " +
      'If so, it appears the world failed to initialize correctly.'
    expect(matchApError(text)).toEqual({
      code: 'AP_WORLD_NOT_FOUND',
      params: { game: 'Tunic', suggestion: 'TUNIC', percent: '60', loadFailed: 'true' },
    })
  })

  it('prefers the specific cause over the generic "File is invalid" wrapper', () => {
    const text = [
      'ValueError: Encountered 1 error(s) in player files. See logs for full tracebacks.',
      '',
      '1. File Alice.yaml is invalid. Please fix your yaml.',
      "Exception: No world found to handle game Foo. Did you mean 'Bar' (50% sure)? Check your spelling or installation of that world.",
    ].join('\n')
    expect(matchApError(text)?.code).toBe('AP_WORLD_NOT_FOUND')
  })

  it('maps the file level errors to AP_YAML_INVALID, with the document of a multi document file', () => {
    expect(
      matchApError('1. File Alice.yaml is invalid. Please fix your yaml.\nKeyError: "Duplicate key x"'),
    ).toEqual({
      code: 'AP_YAML_INVALID',
      params: { file: 'Alice.yaml' },
    })
    expect(
      matchApError(
        '1. File Players\\Alice.yaml document #2 (with name: Al) is invalid. Please fix your yaml.\nException: x',
      ),
    ).toEqual({ code: 'AP_YAML_INVALID', params: { file: 'Players\\Alice.yaml', document: '2' } })
  })

  it('maps an aggregate error that names no file to AP_YAML_INVALID with the error count', () => {
    expect(
      matchApError(
        'ValueError: Encountered 2 error(s) in player files. See logs for full tracebacks.\n\n1. x',
      ),
    ).toEqual({ code: 'AP_YAML_INVALID', params: { count: '2' } })
  })

  it('maps the other yaml level errors', () => {
    expect(matchApError('Exception: No game options for selected game "Hollow Knight" found.')).toEqual({
      code: 'AP_NO_GAME_OPTIONS',
      params: { game: 'Hollow Knight' },
    })
    expect(matchApError('ValueError: Quantity greater than 1 is deactivated by host settings.')?.code).toBe(
      'AP_QUANTITY_DISABLED',
    )
    // PlandoOptions.__str__ joins the flag names (BaseClasses.py:1988).
    expect(
      matchApError('Exception: Settings reports required plando module items, texts, which is not enabled.'),
    ).toEqual({ code: 'AP_PLANDO_DISABLED', params: { module: 'items, texts' } })
    expect(matchApError("2. Names have to be unique. Names: Counter({'bob': 2})")?.code).toBe(
      'AP_NAMES_NOT_UNIQUE',
    )
  })

  it('maps a required generator or world version to AP_VERSION_REQUIRED', () => {
    expect(
      matchApError(
        'Exception: Settings reports required version of generator is at least 0.7.0, however generator is of version 0.6.8',
      ),
    ).toEqual({ code: 'AP_VERSION_REQUIRED', params: { required: '0.7.0', current: '0.6.8' } })
    expect(
      matchApError(
        'Exception: Settings reports required version of world "Hollow Knight" is at least 2.0.0, however world is of version 1.4.0.',
      ),
    ).toEqual({
      code: 'AP_VERSION_REQUIRED',
      params: { game: 'Hollow Knight', bound: 'min', required: '2.0.0', current: '1.4.0' },
    })
  })

  it('maps the FillError family', () => {
    expect(
      matchApError(
        'Fill.FillError: No more spots to place 3 items. Remaining locations are invalid.\nUnplaced items:\nA, B, C',
      ),
    ).toEqual({ code: 'AP_FILL_NO_SPOTS', params: { count: '3' } })
    expect(
      matchApError(
        'Fill.FillError: Not enough locations for progression items. There are 2 more progression items than there are available locations.',
      ),
    ).toEqual({ code: 'AP_FILL_NOT_ENOUGH_LOCATIONS', params: { count: '2' } })
    expect(
      matchApError('Fill.FillError: Unable to fill all locations.\nUnfilled locations(2): [a, b]')?.code,
    ).toBe('AP_FILL_FAILED')
    expect(matchApError('Fill.FillError: No more progress items left to place.')?.code).toBe('AP_FILL_FAILED')
    expect(matchApError('Fill.FillError: Could not place boss for location Eastern Palace')?.code).toBe(
      'AP_FILL_FAILED',
    )
  })

  it('never takes a FillError message for a different FillError code', () => {
    const unbeatable =
      'Fill.FillError: Game appears as unbeatable. Aborting.\nAll Placements:\n[(a (P1), b (P1))]'
    expect(matchApError(unbeatable)?.code).toBe('AP_FILL_UNBEATABLE')
    // A placement list that mentions the words of another error must not change the code.
    const noisy = `Fill.FillError: Unable to fill all locations.\nUnfilled locations: [Not enough locations for progression items (P1)]`
    expect(matchApError(noisy)?.code).toBe('AP_FILL_FAILED')
  })
})

describe('matchApError on ROM errors', () => {
  it('maps a required but missing rom setting to AP_ROM_MISSING', () => {
    const text =
      'FileNotFoundError: C:\\ProgramData\\Archipelago\\Pokemon - Emerald Version (USA, Europe).gba does not exist, but PokemonEmeraldSettings.rom_file is required'
    expect(matchApError(text)).toEqual({
      code: 'AP_ROM_MISSING',
      params: {
        path: 'C:\\ProgramData\\Archipelago\\Pokemon - Emerald Version (USA, Europe).gba',
        key: 'PokemonEmeraldSettings.rom_file',
      },
    })
  })

  it('maps the bare FileNotFoundError of a base ROM check to AP_ROM_MISSING', () => {
    expect(
      matchApError(
        'FileNotFoundError: C:\\ProgramData\\Archipelago\\Zelda no Densetsu - Kamigami no Triforce (Japan).sfc',
      ),
    ).toEqual({
      code: 'AP_ROM_MISSING',
      params: { path: 'C:\\ProgramData\\Archipelago\\Zelda no Densetsu - Kamigami no Triforce (Japan).sfc' },
    })
  })

  it('maps the Lufia II base ROM message to AP_ROM_MISSING with its game and path', () => {
    expect(
      matchApError('FileNotFoundError: Could not find base ROM for Lufia II Ancient Cave: /home/a/Lufia.sfc'),
    ).toEqual({
      code: 'AP_ROM_MISSING',
      params: { game: 'Lufia II Ancient Cave', path: '/home/a/Lufia.sfc' },
    })
  })

  it('does not take any other FileNotFoundError for a ROM problem', () => {
    expect(matchApError('FileNotFoundError: C:\\Users\\a\\Players\\Bob.yaml')?.code).toBe('AP_UNKNOWN')
    // A program is not a base ROM the host needs to generate.
    expect(matchApError('FileNotFoundError: C:\\Games\\Emulators\\EmuHawk.exe')?.code).toBe('AP_UNKNOWN')
  })

  it('cuts a very long value instead of passing megabytes to the renderer', () => {
    const long = 'x'.repeat(5000)
    const params = matchApError(`FileNotFoundError: C:\\${long}.sfc`)?.params
    expect(params?.path?.length).toBe(300)
    expect(matchApError(`KeyError: ${long}`)?.params.message?.length).toBe(300)
  })

  it('maps a hash mismatch to AP_ROM_HASH', () => {
    expect(matchApError('ValueError: File hash does not match for C:\\roms\\emerald.gba')).toEqual({
      code: 'AP_ROM_HASH',
      params: { path: 'C:\\roms\\emerald.gba' },
    })
    expect(
      matchApError(
        'Exception: Supplied Base Rom does not match known MD5 for Japan(1.0) release. Get the correct game and version, then dump it',
      ),
    ).toEqual({ code: 'AP_ROM_HASH', params: {} })
    expect(matchApError('Exception: Supplied Base ROM does not match known MD5s for Castlevania')?.code).toBe(
      'AP_ROM_HASH',
    )
    expect(matchApError('ValueError: Unexpected file size for /home/a/game.sfc')).toEqual({
      code: 'AP_ROM_HASH',
      params: { path: '/home/a/game.sfc' },
    })
  })
})

describe('matchApError on the symptoms of the main process codes', () => {
  it('maps a component the AppImage cannot find to AP_NOT_INSTALLED', () => {
    expect(matchApError('bash: ArchipelagoGenerate: command not found')).toEqual({
      code: 'AP_NOT_INSTALLED',
      params: { command: 'ArchipelagoGenerate' },
    })
    expect(matchApError('ArchipelagoGenerate command not found')?.code).toBe('AP_NOT_INSTALLED')
  })

  it('maps a settings file another Archipelago program holds open to AP_RUNNING', () => {
    const text =
      "PermissionError: [WinError 32] The process cannot access the file because it is being used by another process: 'C:\\ProgramData\\Archipelago\\host.yaml.tmp' -> 'C:\\ProgramData\\Archipelago\\host.yaml'"
    expect(matchApError(text)).toEqual({ code: 'AP_RUNNING', params: {} })
    expect(matchApError("PermissionError: [WinError 5] Access is denied: 'C:\\a\\options.yaml'")?.code).toBe(
      'AP_RUNNING',
    )
  })

  it('does not take any other PermissionError for it', () => {
    expect(matchApError("PermissionError: [WinError 5] Access is denied: 'C:\\a\\Bob.yaml'")?.code).toBe(
      'AP_UNKNOWN',
    )
  })
})

describe('matchApError on server errors', () => {
  it('maps an incompatible multidata to AP_MULTIDATA_INCOMPATIBLE', () => {
    expect(matchApError('Utils.VersionException: Incompatible multidata.')?.code).toBe(
      'AP_MULTIDATA_INCOMPATIBLE',
    )
  })

  it('maps a too old server to AP_SERVER_TOO_OLD with both versions', () => {
    const text =
      'RuntimeError: Supplied Multidata (.archipelago) requires a server of at least version Version(major=0, minor=6, build=9), ' +
      'however this server is of version Version(major=0, minor=6, build=8)'
    expect(matchApError(text)).toEqual({
      code: 'AP_SERVER_TOO_OLD',
      params: { required: '0.6.9', current: '0.6.8' },
    })
  })

  it('maps a zip without a multidata to AP_NO_ARCHIPELAGO_IN_ZIP', () => {
    expect(matchApError('Exception: No .archipelago found in archive.')?.code).toBe(
      'AP_NO_ARCHIPELAGO_IN_ZIP',
    )
  })

  it('maps an occupied port on Windows and on Linux to AP_PORT_IN_USE', () => {
    expect(
      matchApError(
        "OSError: [Errno 10048] error while attempting to bind on address ('0.0.0.0', 38281): only one usage of each socket address (protocol/network address/port) is normally permitted",
      ),
    ).toEqual({ code: 'AP_PORT_IN_USE', params: { port: '38281' } })
    expect(
      matchApError(
        "OSError: [Errno 98] error while attempting to bind on address ('::', 40000, 0, 0): address already in use",
      ),
    ).toEqual({ code: 'AP_PORT_IN_USE', params: { port: '40000' } })
  })

  it('recognises the occupied port whatever the language of the system message', () => {
    expect(
      matchApError(
        "OSError: [Errno 10048] error while attempting to bind on address ('0.0.0.0', 38281): une seule utilisation de chaque adresse de socket est habituellement autorisée",
      )?.code,
    ).toBe('AP_PORT_IN_USE')
    expect(matchApError('OSError: [WinError 10048] Only one usage of each socket address')?.code).toBe(
      'AP_PORT_IN_USE',
    )
  })
})

describe('matchApError fallbacks', () => {
  it('returns null for text with no exception, so the caller can report a generic failure', () => {
    expect(matchApError('')).toBeNull()
    expect(matchApError('Creating Items.\nDone. Enjoy. Total Time: 3.1')).toBeNull()
  })

  it('maps an exception AP has no entry for to AP_UNKNOWN, with its type and message', () => {
    expect(matchApError("KeyError: 'foo'")).toEqual({
      code: 'AP_UNKNOWN',
      params: { type: 'KeyError', message: "'foo'" },
    })
    expect(
      matchApError(
        'Traceback (most recent call last):\n  File "x.py", line 1, in <module>\nOptions.OptionError: bad',
      ),
    ).toEqual({
      code: 'AP_UNKNOWN',
      params: { type: 'Options.OptionError', message: 'bad' },
    })
  })

  it('works on CRLF output', () => {
    const text = apOutput('generate-fill-error.txt').replace(/\n/g, '\r\n')
    expect(matchApError(text)?.code).toBe('AP_FILL_UNBEATABLE')
    expect(matchApError('Exception: No .archipelago found in archive.\r\n')?.code).toBe(
      'AP_NO_ARCHIPELAGO_IN_ZIP',
    )
  })

  it('answers fast on a multi megabyte FillError placement list (no catastrophic backtracking)', () => {
    const placements = Array.from(
      { length: 60_000 },
      (_, i) => `(Location ${i} (Bob), Item ${i} (Alice))`,
    ).join(', ')
    const huge = `Fill.FillError: Game appears as unbeatable. Aborting.\nAll Placements:\n[${placements}]`
    expect(huge.length).toBeGreaterThan(2_000_000)
    const started = performance.now()
    expect(matchApError(huge)?.code).toBe('AP_FILL_UNBEATABLE')
    expect(matchApError(`${huge.slice(0, 1000)}\n${placements}`)).not.toBeNull()
    expect(matchApError(`x ${placements}`)).toBeNull()
    expect(performance.now() - started).toBeLessThan(3000)
  })
})
