// Which Archipelago client opens which patch file, and how much the app can do for the player
// (brief 1.11, spec 3.12). A suffix is the `patch_file_ending` of a world; the client that handles it
// is the one that registers it (AutoSNIClient / _bizhawk `patch_suffix`, or a launcher component).
import type { PatchRoute } from '../types'
import { AP_EXES } from './ap-constants'

function routes(
  suffixes: string[],
  client: PatchRoute['client'],
  exe: string,
  tier: PatchRoute['tier'],
): PatchRoute[] {
  return suffixes.map((suffix) => ({ suffix, client, exe, tier }))
}

export const PATCH_ROUTES: PatchRoute[] = [
  // BizHawk Client: the app can do everything once the ROM and the emulator are known (full).
  ...routes(
    [
      '.apred',
      '.apblue',
      '.apemerald',
      '.apmlss',
      '.apcv64',
      '.apcvcotm',
      '.apmm2',
      '.apmm3',
      '.apsml2',
      '.apygo06',
    ],
    'bizhawk',
    AP_EXES.bizhawkClient,
    'full',
  ),
  // SNI Client: the user still picks and starts an SNES emulator (assisted).
  ...routes(
    ['.aplttp', '.apsm', '.apsmw', '.apsmz3', '.apsoe', '.apl2ac', '.apkdl3', '.apyi', '.apeb'],
    'sni',
    AP_EXES.sniClient,
    'assisted',
  ),
  // Clients with their own connector script (assisted).
  ...routes(['.apz5'], 'oot', AP_EXES.ootClient, 'assisted'),
  ...routes(['.apbn3'], 'mmbn3', AP_EXES.mmbn3Client, 'assisted'),
  ...routes(['.aptloz'], 'tloz', AP_EXES.zelda1Client, 'assisted'),
  ...routes(['.apadvn'], 'adventure', AP_EXES.adventureClient, 'assisted'),
  ...routes(['.apzl'], 'zillion', AP_EXES.zillionClient, 'assisted'),
  // Clients that only exist as launcher components: the Launcher opens the patch (assisted).
  ...routes(['.apladx', '.apgl', '.apcivvi'], 'launcher', AP_EXES.launcher, 'assisted'),
]

// Suffixes left out on purpose, so `routeForFile` gives null and the join flow falls back to its
// guided route: `.apmq` (patched on a website), `.aptww` (an input of the wwrando randomizer),
// `.apsm64ex` and `.apv6` (handed to the game itself), the legacy `.apz3` and `.apm3` that the SNI
// Client still lists (worlds/alttp/Client.py:474, worlds/sm/Client.py:40) but no 0.6 world writes,
// and the `.zip` slot files of Factorio, Kingdom Hearts and Kingdom Hearts 2. Above all, never hand
// a `.zip` to the Launcher: it would take it for a multiworld to host (brief 1.5).

/** The route for a patch file, from the case insensitive suffix of its name; null when it has none. */
export function routeForFile(fileName: string): PatchRoute | null {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot < 0) return null
  const suffix = base.slice(dot).toLowerCase()
  return PATCH_ROUTES.find((route) => route.suffix === suffix) ?? null
}

/** No patch to open: connection details, the tutorial and the Text Client are all the app gives. */
export const TEXT_ROUTE: PatchRoute = {
  suffix: '',
  client: 'text',
  exe: AP_EXES.textClient,
  tier: 'guided',
}
