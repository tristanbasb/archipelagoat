// The base ROMs Archipelago 0.6.8 asks for, derived from its source tree (tag 0.6.8): the settings
// classes `worlds/<world>/__init__.py` declare under `md5s`, with the group the world reads them from.
// Each entry names the file:line it comes from. tests/unit/data/rom-table.test.ts re-reads that source
// when AP_SRC is set and fails if a hash, a key, a header rule or a generation-time requirement drifts.
//
// - `settingsKey` is `<host.yaml group>.<setting>`. The group is the world's `settings_key`, which
//   defaults to `<world folder>_options` (worlds/AutoWorld.py:101-104).
// - `header` is how AP skips a copier header before it hashes: `settings.SNESRomPath` drops 512 bytes
//   when the size leaves 512 modulo 1024 (settings.py:491-512); Mega Man 2 and 3 drop the 16 byte iNES
//   header of a file that starts with `NES\x1A` (worlds/mm2/__init__.py:44-62); nothing otherwise.
// - `requiredAtGeneration` is true when `stage_assert_generate` of the world looks for the ROM, so the
//   host needs it to generate (research brief 1.6).
// - `extensions` are the plausible file extensions, to pick candidates when scanning a folder. They are
//   a hint (the md5 decides), taken from the `copy_to` file name of the setting and from the
//   alternatives its docstring or file dialog names.
// - SMZ3 has no entry of its own: it reads `sm_options.rom_file` and `lttp_options.rom_file`
//   (worlds/smz3/Rom.py:68-83), the Super Metroid and A Link to the Past entries.
// - The Messenger and Saving Princess have `md5s` too, but for the game executable, not a ROM.
import type { RomTableEntry } from '../types'

const SNES = ['.sfc', '.smc']
const N64 = ['.z64', '.n64', '.v64']

export const ROM_TABLE: RomTableEntry[] = [
  // ROMs the host needs to generate (stage_assert_generate)
  {
    // __init__.py:33-39 (key rom_file, settings_key lttp_options :138, needed at generation :305);
    // hash alttp/Rom.py:7 (JP 1.0)
    game: 'A Link to the Past',
    label: 'A Link to the Past (Japan, v1.0)',
    md5s: ['03a63945398191337e896e5771f77173'],
    header: 'snes',
    settingsKey: 'lttp_options.rom_file',
    requiredAtGeneration: true,
    extensions: [...SNES],
  },
  {
    // oot/__init__.py:71-88 (needed at generation :204), md5s :75-79: normal, byte-swapped, decompressed
    game: 'Ocarina of Time',
    label: 'Ocarina of Time (USA, v1.0)',
    md5s: [
      '5bd1fe107bf8106b2ab6650abecd54d6', // :76 normal
      '6697768a7a7df2dd27a692a2638ea90b', // :77 byte-swapped
      '05f0f3ebacbc8df9243b6148ffe4792f', // :78 decompressed
    ],
    header: 'none',
    settingsKey: 'oot_options.rom_file',
    requiredAtGeneration: true,
    extensions: [...N64],
  },
  {
    // soe/__init__.py:161-167 (needed at generation :222); hash soe/patch.py:7 (USA)
    game: 'Secret of Evermore',
    label: 'Secret of Evermore (USA)',
    md5s: ['6e9c94511d04fac6e0a1e582c170be3a'],
    header: 'snes',
    settingsKey: 'soe_options.rom_file',
    requiredAtGeneration: true,
    extensions: [...SNES],
  },
  {
    // smw/__init__.py:25-31 (needed at generation :79); hash smw/Rom.py:8 (USA)
    game: 'Super Mario World',
    label: 'Super Mario World (USA)',
    md5s: ['cdd3c8c37322978ca8669b34bc89c804'],
    header: 'snes',
    settingsKey: 'smw_options.rom_file',
    requiredAtGeneration: true,
    extensions: [...SNES],
  },
  {
    // tloz/__init__.py:25-41 (needed at generation :121); hash tloz/Rom.py:8 (USA, PRG0)
    game: 'The Legend of Zelda',
    label: 'The Legend of Zelda (USA, PRG0)',
    md5s: ['337bd6f1a1163df31bf2633665589ab0'],
    header: 'none',
    settingsKey: 'tloz_options.rom_file',
    requiredAtGeneration: true,
    extensions: ['.nes'],
  },
  {
    // lufia2ac/__init__.py:26-32 (needed at generation :75); hash lufia2ac/Rom.py:9 (USA)
    game: 'Lufia II Ancient Cave',
    label: 'Lufia II - Rise of the Sinistrals (USA)',
    md5s: ['6efc477d6203ed2b3b9133c1cd9e9c5d'],
    header: 'snes',
    settingsKey: 'lufia2ac_options.rom_file',
    requiredAtGeneration: true,
    extensions: [...SNES],
  },
  {
    // mmbn3/__init__.py:22-35 (needed at generation :531); hash mmbn3/Rom.py:16 (Blue Version, USA).
    // The Legacy Collection ships the same ROM as rom_b_e.srl (research brief 1.11).
    game: 'MegaMan Battle Network 3',
    label: 'Mega Man Battle Network 3 - Blue Version (USA)',
    md5s: ['6fe31df0144759b34ad666badaacc442'],
    header: 'none',
    settingsKey: 'mmbn3_options.rom_file',
    requiredAtGeneration: true,
    extensions: ['.gba', '.srl'],
  },
  {
    // yoshisisland/__init__.py:21-27 (needed at generation :86); hash yoshisisland/Rom.py:12 (USA, v1.0)
    game: "Yoshi's Island",
    label: "Super Mario World 2 - Yoshi's Island (USA, v1.0)",
    md5s: ['cb472164c5a71ccd3739963390ec6a50'],
    header: 'snes',
    settingsKey: 'yoshisisland_options.rom_file',
    requiredAtGeneration: true,
    extensions: [...SNES],
  },

  // BizHawk worlds: the ROM is only patched on the player's machine (brief 1.11)
  {
    // pokemon_rb/__init__.py:32-36,43 (key red_rom_file); hash pokemon_rb/rom.py:22
    game: 'Pokemon Red and Blue',
    label: 'Pokemon Red (USA, Europe)',
    md5s: ['3d45c1ee9abd5738df46d2bdda8b57dc'],
    header: 'none',
    settingsKey: 'pokemon_rb_options.red_rom_file',
    requiredAtGeneration: false,
    extensions: ['.gb'],
  },
  {
    // pokemon_rb/__init__.py:38-41,44 (key blue_rom_file); hash pokemon_rb/rom.py:42
    game: 'Pokemon Red and Blue',
    label: 'Pokemon Blue (USA, Europe)',
    md5s: ['50927e843568814f7ed45ec4f944bd8b'],
    header: 'none',
    settingsKey: 'pokemon_rb_options.blue_rom_file',
    requiredAtGeneration: false,
    extensions: ['.gb'],
  },
  {
    // pokemon_emerald/__init__.py:88-94 (settings_key pokemon_emerald_settings :107);
    // hash pokemon_emerald/rom.py:100
    game: 'Pokemon Emerald',
    label: 'Pokemon Emerald (USA, Europe)',
    md5s: ['605b89b67018abcea91e693a4dd25be3'],
    header: 'none',
    settingsKey: 'pokemon_emerald_settings.rom_file',
    requiredAtGeneration: false,
    extensions: ['.gba'],
  },
  {
    // mlss/__init__.py:44-51, md5s :49
    game: 'Mario & Luigi Superstar Saga',
    label: 'Mario & Luigi - Superstar Saga (USA)',
    md5s: ['4b1a5897d89d9e74ec7f630eefdfd435'],
    header: 'none',
    settingsKey: 'mlss_options.rom_file',
    requiredAtGeneration: false,
    extensions: ['.gba'],
  },
  {
    // cv64/__init__.py:26-32; hash cv64/rom.py:25 (USA, v1.0)
    game: 'Castlevania 64',
    label: 'Castlevania (USA, v1.0)',
    md5s: ['1cc5cf3b4d29d8c3ade957648b529dc1'],
    header: 'none',
    settingsKey: 'cv64_options.rom_file',
    requiredAtGeneration: false,
    extensions: [...N64],
  },
  {
    // cvcotm/__init__.py:28-35, md5s :33; hashes cvcotm/rom.py:23 (cartridge) and :24 (Advance Collection).
    // The Wii U Virtual Console hash (rom.py:25) is commented out in AP, so it is left out here.
    game: 'Castlevania - Circle of the Moon',
    label: 'Castlevania - Circle of the Moon (USA)',
    md5s: [
      '50a1089600603a94e15ecf287f8d5a1f', // cartridge
      '87a1bd6577b6702f97a60fc55772ad74', // Castlevania Advance Collection
    ],
    header: 'none',
    settingsKey: 'cvcotm_options.rom_file',
    requiredAtGeneration: false,
    extensions: ['.gba'],
  },
  {
    // mm2/__init__.py:29-64, md5s :33; hashes mm2/rom.py:18-21. A .exe is the Legacy Collection program.
    game: 'Mega Man 2',
    label: 'Mega Man 2 (USA)',
    md5s: [
      '0527a0ee512f69e08b8db6dc97964632', // rom.py:20 cartridge
      '0c78dfe8e90fb8f3eed022ff01126ad3', // rom.py:21 Virtual Console
      '37f2c36ce7592f1e16b3434b3985c497', // rom.py:18 Legacy Collection
      'b69fff40212b80c94f19e786d1efbf61', // rom.py:19 Proteus.exe, shared with Mega Man 3
    ],
    header: 'ines',
    settingsKey: 'mm2_options.rom_file',
    requiredAtGeneration: false,
    extensions: ['.nes', '.exe'],
  },
  {
    // mm3/__init__.py:26-61, md5s :30; hashes mm3/rom.py:18-21
    game: 'Mega Man 3',
    label: 'Mega Man 3 (USA)',
    md5s: [
      '4a53b6f58067d62c9a43404fe835dd5c', // rom.py:20 cartridge
      '5266687de215e790b2008284402f3917', // rom.py:18 Legacy Collection
      'b69fff40212b80c94f19e786d1efbf61', // rom.py:19 Proteus.exe, shared with Mega Man 2
      'c50008f1ac86fae8d083232cdd3001a5', // rom.py:21 Virtual Console
    ],
    header: 'ines',
    settingsKey: 'mm3_options.rom_file',
    requiredAtGeneration: false,
    extensions: ['.nes', '.exe'],
  },
  {
    // marioland2/__init__.py:22-28 (settings_key sml2_options :51); hash marioland2/rom.py:110
    game: 'Super Mario Land 2',
    label: 'Super Mario Land 2 - 6 Golden Coins (USA, Europe, v1.0)',
    md5s: ['a8413347d5df8c9d14f97f0330d67bce'],
    header: 'none',
    settingsKey: 'sml2_options.rom_file',
    requiredAtGeneration: false,
    extensions: ['.gb'],
  },
  {
    // yugioh06/__init__.py:67-74, md5s :72 (settings_key yugioh06_settings :87); hashes yugioh06/rom.py:15-16
    game: 'Yu-Gi-Oh! 2006',
    label: 'Yu-Gi-Oh! 2006 (Europe or USA)',
    md5s: [
      '020411d3b08f5639eb8cb878283f84bf', // rom.py:15 Europe
      'b8a7c976b28172995fe9e465d654297a', // rom.py:16 America
    ],
    header: 'none',
    settingsKey: 'yugioh06_settings.rom_file',
    requiredAtGeneration: false,
    extensions: ['.gba'],
  },

  // Other worlds with a base ROM that is not needed to generate
  {
    // sm/__init__.py:39-45, md5s :43; hash sm/Rom.py:11 (Japan and USA). Also read by SMZ3.
    game: 'Super Metroid',
    label: 'Super Metroid (Japan, USA)',
    md5s: ['21f3e98df4780ee1c667b84e57d88675'],
    header: 'snes',
    settingsKey: 'sm_options.rom_file',
    requiredAtGeneration: false,
    extensions: [...SNES],
  },
  {
    // kdl3/__init__.py:33-39, md5s :37; hashes kdl3/rom.py:19 (USA) and :20 (Japan)
    game: "Kirby's Dream Land 3",
    label: "Kirby's Dream Land 3 (USA or Japan)",
    md5s: [
      'b2f2d004ea640c3db66df958fce122b2', // rom.py:20 Japan
      '201e7658f6194458a3869dde36bf8ec2', // rom.py:19 USA
    ],
    header: 'snes',
    settingsKey: 'kdl3_options.rom_file',
    requiredAtGeneration: false,
    extensions: [...SNES],
  },
  {
    // earthbound/__init__.py:33-39, md5s :37; hashes earthbound/Rom.py:58-59 (valid_hashes)
    game: 'EarthBound',
    label: 'EarthBound (USA)',
    md5s: [
      'a864b2e5c141d2dec1c4cbed75a42a85', // Rom.py:58 cartridge
      '6d71ccc8e2afda15d011348291afdf4f', // Rom.py:59 Virtual Console
    ],
    header: 'snes',
    settingsKey: 'earthbound_options.rom_file',
    requiredAtGeneration: false,
    extensions: [...SNES],
  },
  {
    // adventure/__init__.py:27-35 (no ROM at generation any more, :129-131); hash adventure/Rom.py:14.
    // The docstring says the file may carry a .a26 extension (:31).
    game: 'Adventure',
    label: 'Adventure (NTSC)',
    md5s: ['157bddb7192754a45372be196797f284'],
    header: 'none',
    settingsKey: 'adventure_options.rom_file',
    requiredAtGeneration: false,
    extensions: ['.bin', '.a26'],
  },
  {
    // ladx/__init__.py:49-53; hash ladx/Rom.py:14 (English 1.0 / revision 0)
    game: 'Links Awakening DX',
    label: "Link's Awakening DX (USA, Europe, v1.0)",
    md5s: ['07c211479386825042efb4ad31bb525f'],
    header: 'none',
    settingsKey: 'ladx_options.rom_file',
    requiredAtGeneration: false,
    extensions: ['.gbc', '.gb'],
  },
  {
    // zillion/__init__.py:34-39; hash zillion/patch.py:14 (USA)
    game: 'Zillion',
    label: 'Zillion (USA, Europe)',
    md5s: ['d4bf9e7bcf9a48da53785d2ae7bc4270'],
    header: 'none',
    settingsKey: 'zillion_options.rom_file',
    requiredAtGeneration: false,
    extensions: ['.sms'],
  },
  {
    // gl/__init__.py:56-63, md5s :60
    game: 'Gauntlet Legends',
    label: 'Gauntlet Legends (USA)',
    md5s: ['9cb963e8b71f18568f78ec1af120362e'],
    header: 'none',
    settingsKey: 'gl_options.rom_file',
    requiredAtGeneration: false,
    extensions: [...N64],
  },
]

const BY_MD5 = new Map<string, RomTableEntry[]>()
for (const entry of ROM_TABLE) {
  for (const md5 of entry.md5s) BY_MD5.set(md5, [...(BY_MD5.get(md5) ?? []), entry])
}

const normalize = (md5: string): string => md5.trim().toLowerCase()

/**
 * Every entry whose settings accept this md5. Only the Proteus.exe hash gives two, because Mega Man 2
 * and Mega Man 3 both accept it.
 */
export function findRomsByMd5(md5: string): RomTableEntry[] {
  return [...(BY_MD5.get(normalize(md5)) ?? [])]
}

/** The entry that accepts this md5 (the first one for the hash Mega Man 2 and 3 share). */
export function findRomByMd5(md5: string): RomTableEntry | undefined {
  return BY_MD5.get(normalize(md5))?.[0]
}
