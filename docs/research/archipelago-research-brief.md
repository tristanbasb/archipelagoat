# Archipelago Companion App: Research Brief

**What this covers:** a synthesis of 7 research tracks: `install-layout`, `generate-host`, `webhost-api`, `options-schema`, `apworld-ecosystem`, `clients-emulators` and `ecosystem-ux`.
**Date:** 2026-10-16.
**Target version:** Archipelago **0.6.8**, the latest stable release, published 2026-10-04. GitHub `main` reports `0.6.9` (dev). Every file the researchers cited is identical to tag `0.6.8` once CRLF line endings are ignored; the only exception is the version line `Utils.py:58`. All `ap-src/...` citations refer to that tree.
**User request:** an "ultra powerful", "ultra pretty" app that makes installing and setting up an Archipelago multiworld ultra fast and simple, shipped as a Windows 10/11 `.exe` and for Linux.

Confidence legend:
- **V**: verified, either by reading the source or by a live request.
- **L**: likely, inferred from code or docs.
- **U**: uncertain; needs a test.

---

## 0. One-paragraph framing

The app should be an **unofficial companion** that drives the **unmodified official binaries** (`ArchipelagoGenerate`, `ArchipelagoServer`, `ArchipelagoLauncher` and the per-game clients) and the **documented archipelago.gg endpoints**.

Two prior attempts show what to avoid:
- **Zephyr forks AP** and patches `SNIClient.py` and `host.yaml`.
- **Archipelago Setup Tool rehosts third-party binaries.** It also guesses game paths, and as a result one world maintainer formally asked to be removed.

Almost every organizer step can be automated end to end. The exceptions are getting other people's YAMLs, supplying ROMs, and the router or CGNAT side of self-hosting. For players, the BizHawk-based ROM games can be made one-click. SNI, RetroArch and PC-mod games can only be assisted or guided.

---

## 1. Key facts per area

### 1.1 Releases, assets, version detection

| Fact | Exact values | Source | Conf |
|---|---|---|---|
| Latest stable | tag `0.6.8` (bare, no `v`), published 2026-10-04 | `GET https://api.github.com/repos/ArchipelagoMW/Archipelago/releases/latest` | V |
| Windows asset | `Setup.Archipelago.0.6.8.exe`, 86,208,928 B, sha256 `416e8b34348da41e8ee6b428262e3b6b09778bf07407d4cdf0aae601bdeacaee` | releases API `digest` field | V |
| AppImage | `Archipelago_0.6.8_linux-x86_64.AppImage`, 82,446,840 B, sha256 `1281fb7b9816bd919f9073093ceafcb3b1804143fc206bfc34b704170076240e` | same | V |
| tar.gz | `Archipelago_0.6.8_linux-x86_64.tar.gz`, 122,271,814 B, sha256 `c7ac311d8fe9c4d9c933f64be2c0b8742621e3e96b43697173157d1225017270` | same | V |
| Asset selection | Always match by regex, never by position. Use `^Setup\.Archipelago\.(.+)\.exe$`, `^Archipelago_(.+)_linux-x86_64\.AppImage$` and `^Archipelago_(.+)_linux-x86_64\.tar\.gz$`. Release 0.6.7 also shipped `archipelago-0.6.7-arm64-v8a-debug.apk`. | releases API | V |
| RC naming trap | Windows RC: `Setup.Archipelago.0.6.8-RC1.exe`. The Linux RC assets reuse the final file names. The RC tag is `0.6.8-rc1` with `prerelease=true`. So use `/releases/latest` together with `tag_name`, never the file name. | releases API | V |
| Integrity | Every asset has `digest: "sha256:<hex>"`. The Linux assets have GitHub build attestations (`GET /repos/ArchipelagoMW/Archipelago/attestations/sha256:<digest>` returns 1). The Windows Setup has none (404); `release.yml` says Windows is "usually built by hand". | gh api; `.github/workflows/release.yml:44,90-98,108,161-168` | V |
| Installed-version sources | (1) `<install>/manifest.json`, shaped `{"buildtime":"YYYY-MM-DD HH:MM:SS+00:00","hashes":{},"version":[0,6,8]}`. (2) Uninstall key DisplayName `Archipelago 0.6.8`. (3) FileVersion of `ArchipelagoLauncher.exe`. (4) The AppImage file name. (5) On Linux, `~/.local/share/Archipelago/manifest.json`, which records the last AppImage version run. (6) The Launcher title `Archipelago Launcher <ver>`. `Utils.__version__` is compiled into `lib/library.zip`, so it is not practical to read. | `setup.py:280-299,447`; `Utils.py:58,197-208`; `Launcher.py:136` | L |
| Build toolchain | cx_Freeze 8.6.4, Python ~3.12.7, `optimize=1` (asserts stripped). Linux builds run on ubuntu-22.04, so the minimum glibc is probably 2.35. | `setup.py:25,668`; `release.yml:43,113,125-132` | L |
| Download share (0.6.7) | Windows exe 282,131; AppImage 17,052; tar.gz 14,818; APK 11,032. Windows is about 87% of desktop installs. | releases API | V |
| No self-update in core | The only GitHub release lookups are the build-time SNI download and a few worlds (messenger, saving_princess, sc2). | grep `releases/latest` | V |

### 1.2 Windows installer (Inno Setup)

- **Build (V).** CI runs `choco install innosetup --version=6.2.2`, then `python setup.py build_exe --yes`, then `iscc.exe inno_setup.iss /DNO_SIGNTOOL`. `setup.py` generates `setup.ini` (`[Data] source_path=..., min_windows=6.2.9200`) and `installdelete.iss`. Sources: `release.yml:61-88`, `setup.py:449-456`.
- **AppId (V, real install 2026-10-17).** `{918BA46A-FAB8-460C-9DFF-AE691E1C865B}}`, unchanged since at least 0.5.1. The `.iss` writes `{{…}}`: `{{` is Inno's escape for `{`, but `}}` stays two braces.
  - Uninstall key: `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{918BA46A-FAB8-460C-9DFF-AE691E1C865B}}_is1` (two closing braces, as the 0.6.8 installer wrote it), in the **native 64-bit view** (`ArchitecturesInstallIn64BitMode=x64 arm64`).
  - Values: `InstallLocation`, `Inno Setup: App Path`, `DisplayName` (= AppVerName `Archipelago X.Y.Z`), `UninstallString`, `QuietUninstallString`.
  - `DisplayVersion` is absent, because AppVersion is not set (**V**, real 0.6.8 install).
  - Source: `inno_setup.iss:15,16-19,28`.
- **Install dir (V).** `DefaultDirName={commonappdata}\Archipelago` resolves to `C:\ProgramData\Archipelago`.
  - `[Dirs]` sets `setntfscompression` and `Permissions: everyone-modify users-modify authusers-modify`.
  - Because of these permissions, `Utils.user_path()` resolves to the install dir.
  - Source: `inno_setup.iss:20-22,56-57`.
- **Elevation (L).** `PrivilegesRequired` is unset, so it defaults to `admin`. `PrivilegesRequiredOverridesAllowed` is unset, so `/CURRENTUSER` and `/ALLUSERS` do nothing. HKCR writes go to `HKLM\Software\Classes`, and shortcuts go to the common Start Menu and the Public Desktop.
- **Requirements (V).** `MinVersion=6.2.9200`; x64 and arm64. VC++ x64 redist runs with `/passive /norestart` when `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64` `Version` is below `v14.38.33130`. That shows a small window **even under /VERYSILENT**, and its exit code is ignored. Source: `inno_setup.iss:30,42,62,73,237-254`.
- **Tasks (V).** Both are checked by default, and `UsePreviousTasks` and `UsePreviousAppDir` are both on (Inno defaults).
  - `desktopicon` creates `{commondesktop}\Archipelago Launcher.lnk` and `Archipelago Folder.lnk`.
  - `deletelib` is shown only if `{app}\lib` exists. It runs `DelTree({app}\lib)` at ssInstall. It exists since 0.6.2.
  - Source: `inno_setup.iss:47-49,68-69,256-268`.
- **No `[Components]` since 0.6.3 (V).** `/COMPONENTS=` and `/TYPE=` are no-ops. The generic guide's "you will be asked which components" is outdated.
- **Recommended silent install** (switches V; end-to-end behaviour U):
  `Setup.Archipelago.0.6.8.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CLOSEAPPLICATIONS /TASKS="deletelib" /LOG="<our log path>"`
  - Add `/DIR="..."` only for a custom location.
  - `/TASKS="desktopicon,deletelib"` to keep the icons; a `!` prefix deselects a task.
  - Other useful switches: `/NOCANCEL`, `/FORCECLOSEAPPLICATIONS`, `/NORESTARTAPPLICATIONS`, `/LANG`, `/NOICONS`.
  - Source: jrsoftware.org/ishelp `topic_setupcmdline.htm`.
- **Exit codes (V).**

  | Code | Meaning |
  |---|---|
  | 0 | Success |
  | 1 | Initialization failed |
  | 2 | Cancelled before install |
  | 3 | Fatal error between phases |
  | 4 | Fatal error during install |
  | 5 | Cancelled during install |
  | 6 | Killed by debugger |
  | 7 | "Preparing to Install" says it cannot proceed |
  | 8 | Same as 7, and a restart is needed |

- **[Run] steps (V).** (1) vc_redist when needed. (2) `{app}\ArchipelagoLauncher --update_settings`, with flags `runasoriginaluser runhidden` and status "Updating host.yaml...". (3) Optional launch of the Launcher, skipped in silent mode (`skipifsilent`). Source: `inno_setup.iss:71-75`.
- **[InstallDelete] (V).** Runs before files are copied. It deletes:
  - `{app}\*.exe` (**every exe in the root**);
  - `{app}\data\lua\connector_pkmn_rb.lua` and `connector_ff1.lua`;
  - `{app}\SNI\lua*`;
  - `{app}\lib\worlds\<module>`, for every world that now ships as an `.apworld`.
  - Source: `inno_setup.iss:80-85`, `setup.py:454-456`.
- **[Files] (V).** Copies the whole build dir with `ignoreversion recursesubdirs createallsubdirs`, excluding `*.sfc, *.log, data\sprites\alttpr, SNI`. SNI is copied separately to `{app}\SNI`. Shipped files are overwritten, including `Players\Templates\*.yaml`; files the installer does not ship are kept.
- **Uninstall (L).** The uninstaller is `{app}\unins000.exe` and accepts `/SILENT /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG`. `[UninstallDelete]` only has `dirifempty {app}`, so `host.yaml`, `Players\`, `output\`, `custom_worlds\` and `logs\` stay on disk.
- **Logging (L).** `SetupLogging=yes` writes `%TEMP%\Setup Log YYYY-MM-DD #NNN.txt` on every install. WizardStyle is modern; compression is lzma2 solid.
- **URI handler (V).** `HKCR\archipelago`, whose default value is `Archipegalo Protocol` (typo in source).
  - `URL Protocol` is an empty value.
  - `DefaultIcon` is `{app}\ArchipelagoLauncher.exe,0`.
  - `shell\open\command` is `"{app}\ArchipelagoLauncher.exe" "%1"`.
  - Source: `inno_setup.iss:230-233`.
- **File associations:** see the suffix map in section 1.11.

### 1.3 Linux packaging

- **AppImage (V).** The whole build is copied into `AppDir/opt/Archipelago/`.
  - `archipelago.desktop` contains `Name=Archipelago`, `Exec=opt/Archipelago/ArchipelagoLauncher`, `Type=Application`, `Categories=Game`, `Icon=archipelago`. There is **no MimeType** line. Source: `setup.py:466-583`.
  - **AppRun** runs `opt/Archipelago/ArchipelagoLauncher` by default.
    - `--executable=NAME` or `--executable NAME` as the first argument picks another program.
    - A NAME without `/` resolves to `opt/Archipelago/NAME`; a NAME with `/` is taken relative to `$APPDIR`.
    - It prepends `$APPDIR/opt/Archipelago/lib` to `LD_LIBRARY_PATH`, then runs `$APPDIR/$exe "$@"`.
    - Example: `./Archipelago_0.6.8_linux-x86_64.AppImage --executable=ArchipelagoServer /abs/AP_x.zip`. Source: `setup.py:500-521,551-553`.
  - It is built with the PopTracker fork of appimagetool (`r-2025-11-18`) and `type2-runtime` (`r-2025-11-07`). The exact FUSE requirement is **unknown** (see C6). Source: `release.yml:14-18,133-140`.
- **tar.gz (V/L).** Built with `tar -cv Archipelago | gzip -8`. It extracts to a single top folder `Archipelago/` with the same layout as the Windows root; the executables have no extension.
  - `lib/` bundles `libssl.so*`, `libcrypto.so*`, `libffi.so` and `libcrypt.so`.
  - `SNI/sni` has mode 755.
  - Source: `release.yml:152-157`, `setup.py:333-336,554-557`.
- **No desktop integration (V).** Linux registers neither `archipelago://` nor any file type: nothing calls `xdg-mime`, and the desktop file has no MimeType.
  - The Launcher's per-component "Add shortcut on desktop" uses pyshortcuts with `startmenu=False`.
  - Inside the AppImage, the shortcut's script is `$ARGV0` and the working dir is `~`.
  - Source: `Launcher.py:79-92`, `setup.py:485-498`.
- **Dialogs and terminals (V).**
  - Dialogs use `kdialog`, then `zenity`, then tkinter as a fallback.
  - CLI components launched from the GUI open a terminal, searched in this order: `x-terminal-emulator`, `konsole`, `alacritty`, `kitty`, `gnome-terminal`, `cosmic-term`, `ptyxis`, `xterm`.
  - Child processes get the environment with `LD_LIBRARY_PATH` removed (`env_cleared_lib_path`).
  - On Windows, the terminal is opened with `start "Running Archipelago" <exe>`.
  - Source: `Utils.py:752-990`.
- **Known Linux bugs (V):**
  - #5347 and #5845: the AppImage does not start (0.6.3; Fedora 42 / Gear Lever).
  - #6443: `ArchipelagoGenerate command not found` (0.6.7 AppImage).
  - #4640: no terminal for Host/Generate output.
  - #6492 and #5866 (open): the clipboard expects X11, so paste fails under Wayland.
  - **#5863 (open): BizHawk gets a garbled `/tmp/.mount_*` connector path.**
  - #5848 (open): the patched `.sfc` opens in the web browser.
  - #6109 (open): SNIClient hangs the Launcher on Fedora/GNOME.

### 1.4 Path resolution and on-disk layout

Rules, all **V**, from `Utils.py:134-222`, `worlds/__init__.py:20-25` and `settings.py:812-907`:
- `local_path()` is the folder of `sys.argv[0]`, i.e. the exe's folder. In the AppImage that is `$APPDIR/opt/Archipelago`, inside the read-only mount.
- `user_path()` returns `local_path()` if `os.access(local_path(), W_OK)` is true and the app is not a frozen macOS build. Otherwise it returns `home_path()`.
  - On Linux, `home_path()` is `$XDG_DATA_HOME/Archipelago` (default `~/.local/share/Archipelago`, created mode 0700). If a legacy `~/Archipelago` exists, it is moved there and `~/Archipelago` becomes a symlink.
  - On Windows, `home_path()` simply returns `local_path()`, so there is no fallback there.
- When `user_path != local_path`, then on first use, or whenever `<home>/manifest.json` differs from the install's copy, AP copies `Players/`, `data/sprites/` and `data/lua/` into home (overwriting shipped files). It also copies `manifest.json` and creates `<home>/worlds`.
- The custom worlds folder is `user_path('worlds')` when `user_path != local_path`, otherwise `user_path('custom_worlds')`. If it cannot be created, `user_folder = None`, and installing an APWorld raises "Custom Worlds directory appears to not be writable."
- `cache_path()` is `platformdirs.user_cache_dir('Archipelago', False)` (**L**). It holds `datapackage/<game>/<checksum>.json` and `common.json`, which stores a per-machine `uuid`.

| Item | Windows installer (default) | Linux tar.gz in a writable dir | Linux AppImage |
|---|---|---|---|
| Program files | `C:\ProgramData\Archipelago\` | `<dir>/Archipelago/` | `$APPDIR/opt/Archipelago` (read-only mount) |
| user_path | the install dir | the install dir | `~/.local/share/Archipelago` |
| Settings | `<install>\host.yaml` (or `options.yaml`) | `<dir>/Archipelago/host.yaml` | `~/.local/share/Archipelago/host.yaml` |
| Player YAMLs | `<install>\Players\` (`Templates\`, `Templates\Presets\`) | `.../Players/` | `~/.local/share/Archipelago/Players/` |
| Output | `<install>\output\` | `.../output/` | `~/.local/share/Archipelago/output/` |
| Custom worlds | `<install>\custom_worlds\` | `.../custom_worlds/` | `~/.local/share/Archipelago/worlds/` |
| Core worlds | `<install>\lib\worlds\*.apworld` plus 11 loose folders | `.../lib/worlds/` | inside the mount |
| Logs | `<install>\logs\<Name>_YYYY_MM_DD_HH_MM_SS.txt` (`.txt` older than 7 days deleted at start) | same | `~/.local/share/Archipelago/logs/` |
| Cache | `%LOCALAPPDATA%\Archipelago\Cache` | `~/.cache/Archipelago` | `~/.cache/Archipelago` |
| SNI | `<install>\SNI\sni.exe` | `.../SNI/sni` | inside the mount |

Other user-path files: `_persistent_storage.yaml` (Launcher favorites, adjuster settings), `data/user.kv` (UI style override), `datapackage_export.json`, and ROM-derived files (`basepatch.sfc`, `ZOOTDEC.z64`, `factorio/`, `Undertale/`). Sources: `Utils.py:327-356,542-611`, `kvui.py:1443`.

**Settings-file resolution (V; `settings.py:885-907`).** **Exactly one file** is loaded, the first one found:
1. If `cwd != local_path()`: `./options.yaml`, then `./host.yaml`.
2. `user_path/options.yaml`.
3. `user_path/host.yaml`.
4. Otherwise a new `user_path/host.yaml` is created.

The loaded file is saved back to **the same path**, atomically (`.tmp` then rename) and through atexit, when the settings are "changed". That happens when a key is missing, when a world group is loaded for the first time, or when a ROM is picked through the browse dialog.

Path settings resolve against **user_path**: `output_path`, `player_files_path` and the ROM files. `sni_path` resolves against local_path. When a required Path setting is read and the file is missing, `Group.__getattribute__` opens a file browser unless `settings.no_gui` is set. Only WebHost and the tests set `no_gui`.

**host.yaml groups (V).** The fixed groups are `general_options`, `server_options`, `generator`, `sni_options` and `bizhawkclient_options`, plus one lazily loaded group per world named `<world folder>_options`. Worlds that override the name: `lttp_options` (ALttP), `ffr_options` (FF1), `sml2_options`, `messenger_settings`, `pokemon_emerald_settings`, `saving_princess_settings`, `yugioh06_settings`. SMZ3 reads `sm_options.rom_file` and `lttp_options.rom_file`.

**Defaults (V; `settings.py:515-741`):**
- **general_options:** `output_path: output`.
- **generator:**
  - `player_files_path: Players`
  - `players: 0`
  - `allow_quantity: false`
  - `weights_file_path: weights.yaml`
  - `meta_file_path: meta.yaml`
  - `spoiler: 3`
  - `race: 0`
  - `plando_options: "bosses, connections, texts"` (**items OFF**)
  - `panic_method: swap`
  - `loglevel: info`
- **server_options:**
  - `host: null`, `port: 38281`
  - `password: null`, `server_password: null`
  - `multidata: null`, `savefile: null`, `disable_save: false`
  - `disable_item_cheat: false` (so **!getitem is ON by default**)
  - `location_check_points: 1`, `hint_cost: 10`
  - `release_mode: auto`, `collect_mode: auto`, `remaining_mode: goal`, `countdown_mode: auto`
  - `auto_shutdown: 0`, `compatibility: 2`, `log_network: 0`
- **sni_options:** `sni_path: SNI`, plus `snes_rom_start`.
- **bizhawkclient_options:** `emuhawk_path: null` (required; `.exe` appended on Windows), `rom_start: true`.

### 1.5 Executables and CLIs

**Frozen executables (L; `setup.py:186-202`, `worlds/LauncherComponents.py:345-394`).** There is one per component that has a `script_name`; the name is `'Archipelago'+script_name`, plus `.exe` on Windows:
- `ArchipelagoLauncher`, `ArchipelagoServer` (MultiServer), `ArchipelagoGenerate`, `ArchipelagoOptionsCreator`, `ArchipelagoTextClient`
- `ArchipelagoLttPAdjuster`, `ArchipelagoOoTClient`, `ArchipelagoOoTAdjuster`, `ArchipelagoZelda1Client`, `ArchipelagoChecksFinderClient`, `ArchipelagoZillionClient`, `ArchipelagoMMBN3Client`, `ArchipelagoSNIClient`, `ArchipelagoBizHawkClient`, `ArchipelagoAdventureClient`, `ArchipelagoAHITClient`, `ArchipelagoUndertaleClient`
- Windows only: `ArchipelagoLauncherDebug.exe`, a console copy of the Launcher.

**Console vs GUI subsystem on Windows (V).** Everything is built with `base='gui'`, which means no console and `sys.stdout is None`. The exceptions are the `cli=True` components `ArchipelagoServer` and `ArchipelagoGenerate`, which are console apps. To capture stdout or use `--help`, use `ArchipelagoLauncherDebug.exe`. Linux has no such distinction.

**Launcher CLI (V; `Launcher.py:35-64,405-456`):**
```
ArchipelagoLauncher [-h] [--update_settings] [Patch|Game|Component|url] [args ...] [-- component args]
```
- `--update_settings` runs `get_settings().save()`. That loads or creates the settings file, adds every missing key including all world sections, then exits without opening the GUI.
- `identify()` first tests each component's `file_identifier` (a suffix match), then matches `display_name` or `script_name`. Examples:
  - `ArchipelagoLauncher "Generate Template Options" -- --skip_open_folder` (the `--` passthrough is **L**)
  - `"Text Client"`, `Generate`, `"Open host.yaml"`, `"Browse Files"`, `"Export Datapackage"`
  - `"BizHawk Client"`, `"SNI Client"`, `"Install APWorld" <path>`
- **`.archipelago` and `.zip` arguments are claimed by the Host component** (`SuffixIdentifier('.archipelago','.zip')`). Never pass a Factorio or KH slot `.zip` to the Launcher.
- An `.apworld` argument runs Install APWorld, which pops a **blocking messagebox**.
- An `archipelago://` argument goes to `handle_uri`. It reads `queries['game'][0]` without a guard, so a URL **without `?game=` raises KeyError**. If components with `supports_uri=True` match the game (APQuest, The Messenger, Saving Princess, Starcraft 2, TUNIC), the Launcher shows a picker; otherwise it opens the Text Client.
- Script components such as Generate and Host run as a **blocking** `subprocess.run([<local_path>/<frozen_name>, *args])`.
- **Every Launcher CLI call imports the whole `worlds` package first**, which takes several seconds. Source: `worlds/__init__.py:108-139`.

**ArchipelagoGenerate (V; `Generate.py:26-75`).** Defaults come from host.yaml `generator`:
- `--weights_file_path` (a path or an `https:`/`file:` URL), `--sameoptions`, `--player_files_path`
- `--seed INT`, `--multi INT` (min 1), `--spoiler 0-3`
- `--outputpath`, resolved against **cwd** when relative
- `--allow_quantity`, `--race`, `--meta_file_path`, `--log_level`, `--log_time`, `--csv_output`
- `--plando "bosses, items, texts, connections"`, `--skip_prog_balancing`
- `--skip_output` and `--spoiler_only`, which are mutually exclusive; `--spoiler_only` with `--spoiler 0` is an error.
- There is **no flag that disables GUI dialogs**.

**ArchipelagoServer (V; `MultiServer.py:2700-2765`):**
- Positional `multidata` (`.archipelago` or `.zip`).
- Connection and saving: `--host`, `--port` (38281), `--server_password`, `--password`, `--savefile`, `--disable_save`, `--cert`, `--cert_key` (TLS).
- Logging: `--loglevel {debug,info,warning,error,critical}`, `--logtime`, `--log_network`.
- Game rules: `--location_check_points`, `--hint_cost` (percent of the slot's locations; 0 = free), `--disable_item_cheat`.
- Modes:
  - `--release_mode` and `--collect_mode`: `{auto,enabled,disabled,goal,auto-enabled}`.
  - `--countdown_mode {enabled,disabled,auto}`; auto means rooms under 30 slots.
  - `--remaining_mode {enabled,disabled,goal}`.
- Other: `--auto_shutdown SECONDS`, `--use_embedded_options`, `--compatibility` (0 = exact version match only; 1 and 2 are equivalent in code).
- The mode flags use `nargs='?'`, so a flag without a value sets None. **Always pass explicit values.**

**ArchipelagoTextClient (V; `CommonClient.py:1179-1255`):**
- Arguments: `--connect host:port`, `--password`, `--name`, an optional positional `archipelago://` URL, and `--nogui`. `--nogui` exists only when stdout exists, so it is **absent on the Windows GUI exe**.
- An address without a scheme becomes `ws://`, and `archipelago://` is rewritten to `ws://`. The default port is 38281, and `user:pass@` sets the slot name and password.
- If the `ws://` handshake fails with InvalidMessage, the client retries with `wss://`.

### 1.6 Generation

- **Player file discovery (V; `Generate.py:125-167`).** Generate reads every **top-level** regular file in `player_files_path`, with any extension, except:
  - names starting with `.`;
  - names ending in `.ini`;
  - the weights file and the meta file.

  Subfolders such as `Players/Templates` are ignored. Files are sorted case-insensitively, which sets the slot numbers. Each `---` document is one slot, repeated by `quantity` when allow_quantity is on. A README or zip dropped into the folder breaks generation.
- **Slot names (V; `Generate.py:251-292,365-391`).**
  - Placeholders: `{number}`, `{NUMBER}`, `{player}`, `{PLAYER}`, plus the legacy `%number%` and `%player%`.
  - Names are stripped and truncated to **16 characters after substitution**.
  - The name `Archipelago` is forbidden, and names must be **unique case-insensitively**.
  - If no name is given, the file stem is used.
  - A numeric YAML name such as `name: 123` crashes Generate.
- **Seed (V).** `--seed` or a random 20-digit integer. `seed_name` is a deterministic 20-digit string. `--race` reseeds from time and sets `race_mode`.
- **Output (V; `Main.py:30-32,223-391`).** The result is `<outputpath>/AP_<seed_name>.zip`, which contains:
  - `AP_<seed>.archipelago` (the multidata);
  - `AP_<seed>_Spoiler.txt` when spoiler > 0;
  - per-player files named `AP_<seed>_P<n>_<file-safe name, spaces→_>.<ext>`.

  `--csv_output` writes `generate_<seed>.csv` next to the zip.
- **`.archipelago` format (V).**
  - Byte 0 is the format version (3), followed by a zlib-compressed restricted pickle.
  - Keys: `slot_data`, `slot_info`, `connect_names`, `locations`, `checks_in_area`, `server_options`, `er_hint_data`, `precollected_items`, `precollected_hints`, `version`, `tags`, `minimum_versions`, `seed_name`, `spheres`, `datapackage`, `race_mode`.
  - **`server_options` holds the generating machine's host.yaml server_options in plaintext, `password` and `server_password` included.**
- **Spoiler header (V).** It contains `Players: N`, then `Player <n>: <name>` / `Game: <game>` for multiworlds. A 1-player seed has no `Player 1:` line. This gives slot names without parsing the pickle.
- **Progress lines on stdout (V).** Use these to drive a progress bar:
  - `Archipelago (<ver>) logging initialized on ...`
  - `P<n> Weights: <file> >> <description>`
  - `Generating for N players, <seed_name> Seed <seed> with plando: <flags>`
  - `Found N World Types:`
  - `Creating MultiWorld.`
  - `Creating Items.`
  - `Calculating Access Rules.`
  - `Running Item Plando.`
  - `Running Pre Main Fill.`
  - `Filling the multiworld with N items.`
  - `Current fill step (<name>) at X/Y items placed.` (every 1000 items)
  - `Balancing multiworld progression for N Players.` or `Progression balancing skipped.`
  - `Running pre-output steps.`
  - `Beginning output...`
  - `Generating output files (i/n).`
  - `Calculating playthrough.`
  - `Creating final archive at <abs path>`
  - `Done. Enjoy. Total Time: <s>`

  Any step over 1 s also logs `Took X seconds in <method> ...`. Sources: `Main.py:52-68,111-222,374-391`, `Fill.py:930-936`.
- **Errors (V).** The exception text lands on **stderr**; the final `<Type>: ...` line can span many lines. The excepthook writes the full traceback to the log file. Messages to translate:
  - `Encountered N error(s) in player files ... File <f> is invalid. Please fix your yaml.`
  - YAML syntax errors, shown with a caret.
  - `No world found to handle game X. Did you mean 'Y' (Z% sure)?`
  - `No game options for selected game "X" found.`
  - `Quantity greater than 1 is deactivated by host settings.`
  - `Settings reports required version of generator is at least ...`
  - `Settings reports required plando module ... which is not enabled.`
  - `Names have to be unique`
  - FillError: `Game appears as unbeatable. Aborting.`, `No more spots to place N items`, `Not enough locations for progression items`, `Unable to fill all locations.` A FillError appends every placement to its message, so it can be megabytes long.
- **Hang trap (V; `Generate.py:661-677`).** Generate calls `atexit.register(input, "Press enter to close.")` and unregisters it only after success. **On any failure it blocks reading stdin.** Spawn it with stdin set to DEVNULL.
- **Exit code (L).** 0 on success; non-zero (1) on an uncaught exception.
- **Generation-time ROMs (V).** These worlds call `stage_assert_generate`, so the **host** needs the ROM:
  - ALttP, OoT, Secret of Evermore, Super Mario World
  - TLoZ, Lufia II Ancient Cave, MMBN3, Yoshi's Island
  - Hashes are in section 1.11. ALttP race mode also imports xxtea.

  A missing ROM path opens a native file dialog: tk on Windows; kdialog, zenity or tk on Linux. Headless runs fail with `FileNotFoundError('<path> does not exist, but <Group>.<key> is required')`. The MD5 is checked on **every** access since 0.6.8 (#5854); a mismatch raises `ValueError('File hash does not match for <path>')`. SNESRomPath skips a 512-byte header when `size % 1024 == 512`.
- **Plando (V).** `PlandoOptions` IntFlag: items=1, connections=2, texts=4, bosses=8. **Items are OFF by default locally**, and disabled plando sections are dropped with only a warning.
- **Scale (V).** WebHost uses `JOB_TIME=600 s`, a 4 GiB memory limit and `MAX_ROLL=20`; the docs say the website caps at 30 players. Spoiler level 3 (the default) adds path computation.

### 1.7 Local server (MultiServer)

- **Option precedence (V; `MultiServer.py:283-292,600-602,772-884`).** CLI arguments win, and their defaults come from host.yaml. `--use_embedded_options` then overwrites the simple options with the values baked into the multidata. Finally, an **existing `.apsave` overwrites them all again** (passwords, hint_cost, all modes, item_cheat, compatibility). To change these on a resumed game, use `/option <name> <value>` or a new `--savefile`.
- **Boolean flags cannot be turned off from the CLI (V).** `disable_save`, `disable_item_cheat`, `logtime`, `log_network`, and on the generator side `race`, `allow_quantity` and `log_time` are argparse `store_true` flags whose defaults come from host.yaml. If host.yaml sets one to true, the CLI cannot turn it off.
- **Loading (V).**
  - A `.zip` is searched for its first `*.archipelago` entry; otherwise `No .archipelago found in archive.`
  - Format byte > 3 raises `VersionException('Incompatible multidata.')`.
  - `Supplied Multidata (.archipelago) requires a server of at least version ...`
  - Without a multidata path, the server opens a file dialog; with no tkinter it logs `Pass a multidata filename on command line to run headless.` and exits 1.
- **Startup log (V/L).**
  1. `Loading embedded data package for game <game>`.
  2. `No save data found, starting a new game` (logged at ERROR, but a normal fresh start) or `Loaded save file with N received items for M players`.
  3. `Hosting game at <ip>:<port> (No password|Password: <pw>)`. **This line is logged BEFORE the bind.**
  4. The real readiness signal is the websockets 13.1 INFO line `server listening on <ip>:<port>`, once per socket (**L**).

  An occupied port raises OSError after the Hosting line (WinError 10048 or errno 98), and the process exits non-zero.
- **Public IP lookup (V).** Without `--host`, the server does HTTPS GETs to `https://checkip.amazonaws.com/`, then `https://v4.ident.me` (10 s timeout each, cert verification disabled). That adds up to 20 s when offline. `--host <addr>` binds only that address: `0.0.0.0` drops IPv6, and a LAN IP excludes localhost.
- **Saves (V).**
  - Default path: `<multidata minus extension>.apsave` (e.g. `output/AP_<seed>.apsave`).
  - A background save runs every 60 s at a deterministic second, only when dirty. The atexit handler always saves on a clean exit, and `/save` forces a save.
  - **A hard kill (TerminateProcess/SIGKILL) skips the atexit save and can lose about 60 s.**
  - A mismatched save is logged as `This savegame does not appear to match the loaded multiworld.`; the server then starts fresh and **overwrites** the old file at exit.
- **Console on stdin (V).** A daemon thread reads lines. Lines starting with `/` are commands; other text is broadcast as `[Server]: <text>`. **On EOF it spins every 10 ms and never exits**, so closing stdin does not stop the server. Commands:
  - `/help`, `/license`, `/options` (**prints passwords**), `/save`, `/players`, `/status [tag]`, `/exit`
  - raw: `/alias`, `/collect`, `/release`, `/allow_release`, `/forbid_release`
  - `/countdown [s≤3600]`, `/send <player> <item>`, `/send_multiple <n≤100> <player> <item>`, `/send_location`
  - `/hint`, `/hint_location`, `/option <name> <value>` (`null`/`none` clears a password), `/datastore`
  - Non-raw commands are shlex-split, so quote multi-word names.
- **Player commands (V).** Players use `!help`, `!players`, `!status`, `!release`, `!collect`, `!countdown`, `!remaining`, `!missing`, `!checked`, `!alias`, `!getitem`, `!hint`, `!hint_location`. Remote admin is `!admin login <server_password>` followed by `!admin /<cmd>`; it is disabled when no server_password is set.
- **Shutdown (V).**
  - `/exit` triggers the atexit save.
  - On Linux, SIGINT and SIGTERM are handled through `loop.add_signal_handler`.
  - On Windows a windowless child cannot reliably receive SIGINT, so **send `/exit\n` on stdin**.
  - `auto_shutdown` counts only **new location checks** as activity, so connected-but-idle rooms still shut down.
- **stdout buffering (V/U).** Command results use `print()`. With a piped stdout they are block-buffered and appear late. Possible fixes: a PTY (ConPTY / openpty), `PYTHONUNBUFFERED=1` (untested with cx_Freeze), or a Tracker WebSocket client.
- **Parseable events (V).**
  - `Notice (all): <name> (Team #1) playing|tracking|hinting|viewing <game> has joined. Client(x.y.z), [tags].`
  - `... has left the game.`
  - `(Team #1) <finder> sent <item> to <receiver> (<location>)`
  - `... has completed their goal.`
  - `Team #1 has completed all of their games! Congratulations!`
  - `A client connection was refused due to: {...}`. **This line includes the password the client sent, in plaintext.**
- **Protocol (V).** WebSocket text frames, each a JSON list of `{"cmd":...}` objects.
  - The server sends RoomInfo; the client sends Connect `{password, game, name, uuid, version{major,minor,build,class:"Version"}, items_handling, tags, slot_data}`.
  - The server answers Connected or ConnectionRefused with errors `InvalidSlot`, `InvalidGame`, `IncompatibleVersion`, `InvalidPassword` or `InvalidItemsHandling`.
  - Slot lookup is **case-sensitive**.
  - **A client with tags `Tracker`, `TextOnly` or `HintGame` and `game: ""` can connect to any slot** (minimum version 0.5.0). That gives a passive dashboard.
  - Read-only datastore keys: `_read_hints_<team>_<slot>`, `_read_client_status_<team>_<slot>`, `_read_slot_data_<slot>`, `_read_race_mode`, `_read_item_name_groups_<game>`, `_read_location_name_groups_<game>`. `SetNotify` on them pushes updates.
- **Networking (V).** AP has **no UPnP, NAT-PMP or PCP code**. It uses one TCP port (WebSocket) and no UDP. On Windows, the first bind on 0.0.0.0 may trigger the Defender Firewall prompt for `ArchipelagoServer.exe`.

### 1.8 archipelago.gg WebHost

The live site runs 0.6.8 behind `nginx/1.24.0` and gunicorn, with Flask-Compress serving **zstd** to clients that advertise it. There is no rate limiting in the code (Flask-Limiter is listed in the requirements but never imported). `robots.txt` disallows crawlers.

| Method + path | Purpose / response | CORS |
|---|---|---|
| `POST /api/generate` | Web generation (core worlds only). Accepts JSON (`Content-Type: application/json` required, otherwise 400 "No options found") as `{"weights":{key: dict or YAML text}, race, hint_cost, release_mode, collect_mode, remaining_mode, countdown_mode, item_cheat, spoiler, server_password, plando_*}`, or multipart with repeated `file` fields (.yaml .yml .json .txt .zip). Returns 201 `{text, detail:<uuid>, encoded:<suuid>, wait_api_url, url}`; 400 `{text, detail:{file: true or error}}`; 409 `{"text":"Max size of multiworld exceeded","detail":MAX_ROLL}`; 500. | no |
| `GET /api/status/<suuid>` | 201 done, 202 running, 404 not found, 500 failed. The error text is available only on the HTML of `/wait/<suuid>`. Failed rows can later flip to 404. | no |
| `POST /uploads` | Multipart field `file`, a `.zip` or `.archipelago`. Success is a 302 to `/seed/<suuid>`. Errors come back as 200 HTML in `<div class="user-message">`, as flash messages stored in the cookie. ROM extensions are rejected; a bug turns that case into a 500. Seeds with custom worlds are allowed. | no |
| `GET /new_room/<seed suuid>` | Creates a **new** room on every call and auto-starts it. Returns 302 to `/room/<room suuid>`. The owner is the session. | no |
| `GET /room/<room>` | HTML page. **Wakes the room** if it has been idle for more than 60 s. Shows `/connect host:port` (regex `/connect ([\w:.\-]+)`) and `archipelago://{name}:None@HOST:port?game=...&room=...` links. `?update` keeps the request light. | n/a |
| `POST /room/<room>` | Form field `cmd` sends a server console command, owner only; non-owners are silently ignored. Commands are drained about every 5 s. | no |
| `GET /log/<room>` | Owner only (403 otherwise), `text/plain`. `Range: bytes=N-` returns 206 with the tail. | no |
| `GET /api/room_status/<room>` | `{tracker, players:[[name,game]], last_port (0 = never started, -1 = error), last_activity, timeout (7200), downloads:[{slot, download}]}`. The download paths are **relative**. There is **no host field**, the call **does not wake** the room, and a 404 is HTML. | `*` |
| `GET /dl_patch/<room>/<slot db id>` | Patch file whose `archipelago.json` `server` is rewritten to `HOST:last_port` (null if no port yet). File name: `P<player>_<name>_<room><ext>`. | |
| `GET /slot_file/<room>/<player>` | Raw slot file for Factorio, OoT, VVVVVV, Zillion, SM64, DS3, KH2 and FFMQ only. | |
| `GET /dl_spoiler/<seed>` | Spoiler, with **no ownership check**. | |
| `GET /api/tracker/<t>` | Live tracker (60 s cache): aliases, player_items_received, player_checks_done, total_checks_done, hints, activity_timers, connection_timers, player_status (ClientStatus 0/5/10/20/30). | `*` |
| `GET /api/static_tracker/<t>`, `/api/slot_data_tracker/<t>` | 300 s cache: groups, datapackage `{game:{checksum,version}}`, player_locations_total, player_game, and slot_data. | `*` |
| `GET /api/datapackage`, `/api/datapackage_checksum`, `/api/datapackage/<checksum>` | The full package is 11 MB raw, about 1.1 MB as zstd. The checksum map covers 82 games including "Archipelago" and is 4,877 B. The per-checksum endpoint also covers custom games that came from uploaded seeds. | `*` |
| `GET /api/get_rooms`, `/api/get_seeds` | Rooms and seeds of the session cookie. | no |
| `GET /session`, `GET /session/<uuid4>` | Show the session identity, or **replace** it with another UUID4 (to restore ownership on another device). The UUID acts as a bearer credential. | |
| `GET /user-content`, `GET /disown_seed/<s>`, `GET /disown_room/<r>` | Lists own content. The two disown routes are **state-changing GETs**: never prefetch them. | |
| `POST /generate[/<race>]`, `POST /check` | Web form generation (302 to `/wait/`) and YAML check (HTML; full validation for core worlds only). | |
| `GET /games/<game>/option-presets` | JSON `{preset: {option: value or "random"}}`. | no |
| `GET /static/generated/configs/<file-safe game>.yaml`, `.../Presets/<game> - <preset>.yaml` | Weighted YAML templates. Served as `application/octet-stream` with a UTF-8 BOM, `requires: version: 0.6.8`, generated with `generate_hidden=True`. | |
| `GET /static/generated/docs/<game>/<file>.md`, `/tutorial/<Game>/<link>`, `/games/<g>/player-options`, `/games/<g>/weighted-options`, `/games` (`<details data-game=...>`, 81 visible) | Docs and option pages. The player-options HTML can reach about 6 MB per game. | |

**Identity (V).** The `session` cookie is a Flask signed cookie holding `_id`.
- It is created on **any** request, `/api/*` included.
- It is permanent for 31 days, refreshed on each response, and HttpOnly, with no Secure or SameSite attribute.
- An suuid is the URL-safe base64 of the 16 UUID bytes with padding stripped (22 characters).

**Lifecycle (V).**
- The autohost loop polls every 0.1 s; hoster = `room.id.int % HOSTERS`.
- A room shuts down after `timeout` (7200 s) without client activity. After that it does not restart on its own; it restarts when someone visits `/room/<id>`.
- A room first tries its previous `last_port`; otherwise it picks a random port from `GAME_PORTS` (49152-65535). **The port can change.**
- Rooms are deleted only when disowned, or when `ROOM_AUTO_DELETE > 0` (default 0).

**Room options (V).** Rooms use the multidata's embedded server options. Uploaded locally generated seeds therefore **honor the local `password` and `server_password`**.

**Web API traps (V):**
- `race='true'` in form mode raises a 500.
- Any non-empty `plando_*` value, including `'false'`, enables that module; only an empty string disables it.
- **Omitting `server_password` sets the admin password to the literal string `"None"`.**
- 404s on room_status and tracker are HTML, not JSON.
- The absolute URLs returned by `/api/generate` may use `http://`.
- `MAX_ROLL` counts uploaded files or weights entries for `/api/generate`, but rolled players for `/generate`.

**Limits in code** (production values are private):
- `MAX_CONTENT_LENGTH` 64 MiB; `MAX_FORM_MEMORY_SIZE` 2 MiB
- `MAX_ROLL` 20 (the docs say 30)
- `GENERATORS` 8; `HOSTERS` 8; `JOB_TIME` 600 s
- `MAX_ROOM_TIMEOUT` 259200 s

### 1.9 Player YAML and options schema

- **Loading (V; `Generate.py:302-325`, `Utils.py:247-263`).**
  - Files are decoded as `utf-8-sig` (BOM accepted) and parsed with `UniqueKeyLoader`, built on CSafeLoader. That is **YAML 1.1**: unquoted `yes/no/on/off` are booleans, `0755` is octal, and `1:20` is a base-60 integer.
  - A duplicate key, or both `key` and `+key` in one mapping, raises KeyError.
  - Merge keys (`<<`) probably fail (**L**).
  - An empty game section `Game:` (null) crashes generation; write `{}` instead.
- **Root keys (V).** `name`, `description`, `game`, `requires`, `quantity`, `triggers`, `linked_options`, `progression_balancing`, `accessibility`, plus **one section per game** whose name matches the game exactly. Any other PerGameCommonOptions key at the root raises an error. Unknown root keys are ignored. Unknown keys inside a game section only log a warning.
- **`get_choice` (V).**
  - Missing key: the option's default.
  - List: a uniform random pick.
  - Scalar: used as-is.
  - Dict: a weighted pick, with weights converted by `int()` (so 0.5 becomes 0).
  - All-zero weights raise `RuntimeError`.
- **`supports_weighting` (V).**
  - **False** for OptionDict, OptionCounter, ItemDict, StartInventory, OptionList, ItemLinks, OptionSet, ItemSet, LocationSet, PlandoTexts, PlandoConnections and PlandoItems. A dict given to a set option silently becomes the set of its keys.
  - **True** for Toggle, Choice, TextChoice, PlandoBosses, Range, NamedRange and FreeText.
- **Value rules (V; `Options.py`).**
  - **Toggle:** bools and ints, the strings `off/0/false/none/null/no/disabled` and `on/1/true/yes/enabled`, and `random`. A null value crashes.
  - **Choice:** names and aliases, case-insensitive; an int only if it is a valid option id; `random`. `true`/`false` are auto-aliased only when the choice has `on`/`off`.
  - **Range:** ints or strings only, **floats rejected**. Accepted strings: `random`, `random-low`, `random-middle`, `random-high`, `random-range-A-B`, `random-range-{low,middle,high}-A-B`, `low`, `high`, `default`.
  - **NamedRange:** adds `special_range_names`, which may lie outside the range.
  - **Bug:** negative bounds in random-range are mis-parsed. `random-range--60-60` always gives 60, and the ALttP template emits exactly that string.
  - **OptionSet / ItemSet / LocationSet:** a list or a comma string. A single `random...` string means "pick N random entries". Group names are expanded, including `Everything` and `Everywhere`.
  - **ItemDict / start_inventory:** item **group names are NOT expanded** here.
  - **OptionCounter:** integer values within min/max.
- **`requires` (V).**
  - `version` must be a quoted 3-part `"X.Y.Z"`; `0.7` or a 4-part version crashes.
  - `plando` must be a subset of the enabled plando modules.
  - `game: {Game: "x.y.z" or {min, max}}` is checked against the installed `world_version`; games that are not installed are skipped silently.
- **Common options (V).**
  - Every world has `progression_balancing` (0-99, default 50, plus `disabled`/`normal`/`extreme`) and `accessibility` (`full`, `minimal`, sometimes `items`).
  - PerGameCommonOptions adds `local_items`, `non_local_items`, `start_hints`, `start_inventory`, `start_location_hints`, `exclude_locations`, `priority_locations`, `item_links` and `plando_items`.
  - Opt-in per world: `start_inventory_from_pool` (31 core worlds) and `death_link` (36 core worlds).
- **Complex options (V).**
  - `item_links`: a list of `{name, item_pool, exclude?, replacement_item (key required), local_items?, non_local_items?, link_replacement?, skip_if_solo?}`.
  - `plando_items`: blocks with `items`/`item`, `locations`/`location`, `world`, `from_pool`, `force`, `count`, `percentage`.
  - `plando_connections` and `plando_texts`: see `Options.py:1104-1353`.
  - `triggers`: a list of `{option_category, option_name, option_result, percentage, options}`, compared with typed `==`. Template Toggles use **string** keys `'true'`, so a trigger written with the YAML bool `true` never fires.
  - `linked_options`: root only; `percentage` is required.
  - `meta.yaml` needs `meta_description`.
- **Templates (V; `Options.py:1812-1896`, `data/options.yaml`).**
  - `generate_yaml_templates(target, generate_hidden)` **first deletes every `*.yaml`** in `Players/Templates` and `Players/Templates/Presets`.
  - It writes `<file-safe game>.yaml` and `Presets/<game> - <preset>.yaml` as utf-8-sig.
  - Hidden worlds are skipped locally.
  - **The first world that fails aborts all remaining worlds.**
  - Run headless with `ArchipelagoLauncherDebug.exe "Generate Template Options" -- --skip_open_folder` (**L**).
- **Template layout (V).** The format is deterministic:
  - Header: `name: Player{number}`, `description`, `game`, `requires.version` (and `requires.game` when world_version is not 0.0.0).
  - Groups are marked by a `# Group #` banner; options are 2-space keys followed by `# ` doc lines.
  - Range options add `# Minimum value is N` and `# Maximum value is M`.
  - NamedRange options add `# equivalent to N`.
  - The default value carries weight 50; the others carry 0.
- **What templates lack (V):**
  - the valid keys of sets and lists;
  - aliases;
  - item and location names;
  - counter min/max;
  - the exact class, e.g. Toggle vs a 2-value Choice, or TextChoice vs Choice;
  - display names;
  - rich_text;
  - hidden options and Removed options.

  For example, TUNIC's `entrance_rando` is a TextChoice but renders like a Choice.
- **Other schema sources (V):**
  - Site `option-presets` JSON.
  - `/api/datapackage` for names and groups.
  - player-options HTML: `select` choices, range min/max, `data-tooltip` docs.
  - AP 0.6.8's **Options Creator** (Kivy): simple_ui options only, single game, no weights.
  - Prior art: ArchipelagoWizard's `wizard.apworld`, which dumps an exact `dumped-options.json` (type, choices, aliases, min/max, items, locations, presets).
- **Option groups (V).** `Game Options` comes first, then the world's own groups, then `Item & Location Options` (start_collapsed). Visibility flags: template=1, simple_ui=2, complex_ui=4, spoiler=8.

### 1.10 APWorlds and catalogs

- **Format (V; `docs/apworld specification.md`).** An apworld is a zip named `<module>.apworld`. It contains `<module>/__init__.py`, and the module name is **case-sensitive and must equal the file stem**. `rhythm_doctor-v0.0.11.apworld` therefore fails to import. The spec says names "must be lower case", yet uppercase apworlds such as `LostKingdoms2.apworld` are distributed (U).
- **Manifest (V).** `archipelago.json` sits at the zip root or under `<module>/`.
  - `game` (str) is required.
  - Optional: `world_version`, `minimum_ap_version`, `maximum_ap_version` (each exactly `N.N.N`) and `authors`.
  - Packaged apworlds also need `version` and `compatible_version`; a `compatible_version` above 7 is rejected.
  - **A missing or invalid manifest only logs a warning before 0.7.0, and becomes FATAL from 0.7.0** (messagebox + `sys.exit(1)`).
  - A corrupt zip (BadZipFile) is already fatal in 0.6.x and blocks **every** AP process.
- **Scan (V).** Only the **top level** of `(user_folder, local_folder)` is scanned, with no recursion. Names starting with `_` or `.` are skipped. Folders count only with `__init__.py`; files count only if they end in `.apworld`.
- **Load order (V; `worlds/__init__.py:131-139,203-242`):**
  - Loose folder worlds load first. These include 11 core worlds: ALttP, Adventure, Archipelago, Lufia II AC, Meritous, OoT, Overcooked! 2, Raft, SM64, VVVVVV, Wargroove. **They can never be overridden.**
  - Apworlds outside their min/max core versions are rejected and recorded in `failed_world_loads`.
  - The rest are sorted by `world_version`, highest first. **Only the first per game loads.** Duplicates are skipped with only a log line, **not reported as failures**.
  - A ties probably goes to the custom file (**L**).
  - Core apworlds in frozen builds are pinned `min = max = core version`, so they cannot be copied between AP versions.
- **Install APWorld (V; `LauncherComponents.py:135-214`).** Checks:
  - the `.apworld` suffix;
  - exactly one top-level directory whose name appears in the file stem;
  - `<dir>/__init__.py`.

  It then copies the file to `<user_folder>/<dir>.apworld`, hot-loads it or asks for a restart, and shows a modal messagebox. **It does not check the manifest versions.**
  - Entry points: `ArchipelagoLauncher <file>.apworld`, a drag-and-drop, or a Windows double-click (ProgID `ArchipelagoWorlddata`).
  - There is **no uninstall UI**. To remove or disable a world: delete the file, rename it with a leading `_`/`.`, change its extension, or move it out of the folder.
- **Frozen AP never pip-installs (V).** An apworld that needs a third-party package must vendor it. `.pyc` files compiled for another Python version are ignored.
- **Changes in 0.6.8 (V).**
  - New "Failed World Loads" dialog (#6058).
  - Gauntlet Legends added to core; **DKC3 removed** from core (#6097).
  - Minecraft was already removed in 0.6.2.
- **Docs warning (V):** "Installed APWorlds are able to run custom code on your computer whenever you open Archipelago." Source: `worlds/generic/docs/setup_en.md:148-149`.
- **Catalog sources:**
  - **ionium-ap/Archipelago-index (V).** Active (pushed 2026-10-16), no LICENSE file; its UI is `https://ap-lobby.ionium.us/worlds`. Its lobby JSON API requires admin.
    - Contents: 630 `index/*.toml` files (83 supported core, 61 disabled, 21 tagged `ad`). `index.lock` holds **sha256 for 499 worlds** (two spot checks matched). `index.toml` sets `archipelago_version='0.6.7'` and has `[bases."0.6.7"]` and `[bases."0.6.8"]`.
    - TOML keys: `name` (= manifest game), `display_name`, `home`, `tags`, `supported`, `disabled`, `default_version` (`latest`, `latest_supported`, `disabled` or a semver), `default_url` with `{{version}}`, `[versions]`, `[releases] "x.y.z" = {min_ap_version, max_ap_version, url}`, and `[base."<semver req>"]` overrides.
    - Inclusion criteria: fuzzer failure rate under 1%, no ROM needed to generate, no remote resources. This is quality vetting, **not a security audit**.
    - Fetching: the repo tarball is about 30 MB, so use `GET https://api.github.com/repos/ionium-ap/Archipelago-index/git/trees/main?recursive=1` (1002 entries) plus `raw.githubusercontent.com/.../index/<file>.toml` (`max-age=300`, ETag).
  - **Eijebong/Archipelago-index and Archipelago-lobby (V)** were **archived** on 2026-04-25. The author cited burnout, more than 140 open PRs and security concerns. `ap-lobby.bananium.fr` now shows a "Goodbye" page.
  - **Miraheze wiki (V).** API at `https://archipelago.miraheze.org/w/api.php` (MediaWiki 1.46.2, PortableInfobox; CORS works with `origin=*`; licensed **CC BY-NC-SA 4.0**).
    - Bulk fetch in 2 requests: `?action=query&generator=categorymembers&gcmtitle=Category:Implementations&gcmnamespace=0&gcmlimit=500&prop=pageprops&ppprop=infoboxes&format=json&formatversion=2&origin=*`, then `gcmcontinue`. `pageprops.infoboxes` is a JSON string.
    - Infobox fields: `ap-status`, `ap-maintainer`, `ap-download`, `ap-setuplink`, `ap-repolink`, `ap-optionslink`, `ap-aidisclosure`, `ap-beta`, `boxart`, and others.
    - Coverage: 966 implementation pages; 881 have a download link (982 GitHub links, mostly `/releases/latest`); 907 unique repos.
    - Categories: `Core-verified implementations` (81), `Custom implementations` (882), `After Dark implementations` (63), `Implementations that require a ROM at generation` (16), `Implementations that are broken on Archipelago Main` (10), `Implementations with PopTracker` (226), and more.
  - **Community Google Sheet (V).** ID `1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw`, "Playable Worlds" tab `gid=58422002`, exported via `/export?format=csv&gid=58422002`.
    - About 914 rows. Columns: Game, Stability, PR Status, 18+/Unrated, Links & Downloads, Setup Guides, Support, Disclosures, Notes.
    - Stability: 376 Stable, 470 Unstable, 10 Broken on Main.
    - The format is free-form and was revamped in Aug 2026. GameSupportTracker already parses it.
- **GitHub release realities (V).** Sample of 60 wiki-linked repos: 52 have an `.apworld` at `/releases/latest`, but 5 of those belong to **another game** (multi-world forks use tag prefixes such as `drmario-v1.0.0` or `Tracker_v0.3.5`). 4 return 404 because they publish prereleases only; 4 have no apworld asset.
  - Release tags and `world_version` often disagree.
  - Some apworlds have no manifest, ship `.pyc` files or native DLLs.
  - Assets carry `digest: sha256:<hex>`.
- **Rate limits (V).** Unauthenticated GitHub REST allows 60 requests/hour, and **304 responses still count**; authenticated is 5000/hour. Undocumented fallbacks: `HEAD github.com/{o}/{r}/releases/latest` returns a 302 to the tag; `releases.atom`; `releases/expanded_assets/<tag>`; `releases/latest/download/<asset>`.
- **Universal Tracker (V).** Ships as `tracker.apworld` from FarisTheAncient/Archipelago, tag `Tracker_v0.3.5`. It needs the player's YAML in Players and is not in the ionium index.

### 1.11 Clients, emulators, ROMs

- **Patch container (V; `worlds/Files.py`).** A zip containing `archipelago.json` with `compatible_version`, `version`, `server`, `player`, `player_name`, `game`, `patch_file_ending`; procedure patches add `base_checksum` (MD5 of the base ROM, a string or a list), `result_file_ending` and `procedure`. **This can be read natively, without Python**, to learn the game, slot, server and required ROM.
- **Patch output (V).** `Patch.create_rom_file` writes `splitext(patch)[0] + result_file_ending`, **next to the patch file**.
- **Suffix → handler (Windows associations, V; `inno_setup.iss:89-233`):**
  - `ArchipelagoSNIClient.exe`: `.aplttp .apsm .apsmw .apsmz3 .apsoe .apl2ac .apkdl3 .apyi .apeb`
  - `ArchipelagoBizHawkClient.exe`: `.apred .apblue .apemerald .apmlss .apcv64 .apcvcotm .apmm2 .apmm3 .apygo06`
  - `ArchipelagoOoTClient.exe`: `.apz5`
  - `ArchipelagoMMBN3Client.exe`: `.apbn3`
  - `ArchipelagoZelda1Client.exe`: `.aptloz`
  - `ArchipelagoAdventureClient.exe`: `.apadvn`
  - `ArchipelagoZillionClient.exe`: `.apzl`
  - `ArchipelagoLauncher.exe`: `.apladx .apcivvi .apgl .apworld`
  - `ArchipelagoServer.exe`: `.archipelago`
  - **Not associated:**
    - `.apsml2` (BizHawk Client)
    - `.aptww` (an input to wwrando)
    - legacy `.apz3` and `.apm3`
    - `.apmq` (patched on a website)
    - `.apsm64ex` and `.apv6` (fed to the game)
    - Factorio, KH1 and KH2 `.zip` slot files
    - DS3 `.json`
- **BizHawk Client flow (V; `worlds/_bizhawk/context.py:302-361`).** Run `ArchipelagoBizHawkClient <patch>`. It patches the ROM. If `rom_start` is true it then runs `[emuhawk_path, "--lua=<AP>/data/lua/connector_bizhawk_generic.lua", realpath(rom)]` with cwd set to AP. It **auto-connects to the manifest `server`**, and the Lua side listens on `127.0.0.1:43055-43059` (C8).
  - The connector refuses BizHawk older than 2.7 and warns above 2.11.
  - `rom_start` can also be a command string, which is split with shlex.
  - On Linux, `emuhawk_path` must point to `EmuHawkMono.sh`.
- **SNI Client flow (V; `SNIClient.py`).** It patches the ROM, then opens it according to `sni_options.snes_rom_start`:
  - `true` uses the OS default program;
  - a string must pass `os.path.isfile()` and is called as `[exe, rom]`, with **no arguments allowed**.

  It connects to SNI at `ws://localhost:23074` and auto-starts SNI from `sni_path`. An `.aplttp` pops a Tk prompt asking to reuse the last Adjuster settings. AP bundles SNI v0.0.100; upstream is v0.0.103.
- **Own-connector clients (V).** These treat `rom_start` like SNI (a bare exe path only):

  | Client | Lua connector | Port |
  |---|---|---|
  | OoT | `connector_oot.lua` | 28921 |
  | MMBN3 | `connector_mmbn3.lua` | 28922 |
  | TLoZ | `connector_tloz.lua` | 52980 |
  | Adventure | `connector_adventure.lua` | 17242+ |

  Adventure has a separate `rom_args` setting. LADX accepts a shlex command (RetroArch UDP 55355, or `connector_ladx_bizhawk.lua`).
- **OoT (V).** The client applies the `.zpf`, writes `<base>-decomp.z64`, then compresses it with `data/Compress/Compress(.exe|_ARM64)`. It **does not auto-connect**.
- **Upstream versions (V).**
  - BizHawk **2.11.1** (`BizHawk-2.11.1-win-x64.zip`, `BizHawk-2.11.1-linux-x64.tar.gz`). Since 2.10, Windows needs only `vc_redist.x64` (prereqs repo: `bizhawk_prereqs_v2.4.8_1.zip`). Linux needs Mono complete, OpenAL, Lua 5.4 and lsb_release; it is started with `EmuHawkMono.sh`, needs **absolute paths**, and has no Mupen64Plus.
  - PopTracker **0.35.4** (`poptracker_0-35-4_win64.zip`, `PopTracker-0.35.4-x86_64.AppImage`, which needs fuse2).
  - SNI **v0.0.103**.
- **PopTracker CLI (V).** `poptracker [--load-pack <uid>[:<ver>]] [--pack-variant v] --ap-host <host:port> --ap-slot <name> --ap-password <pw> [pack]`, plus `--install-pack`, `--list-packs`, `--list-installed`. Packs are searched in `EXEDIR/packs`, `HOME/PopTracker/packs`, `Documents/PopTracker/packs` and `CWD/packs`. The official community pack list has only 18 entries, so most AP packs come from GitHub releases.
- **RetroArch (V).** Enable `network_cmd_enable = "true"` and `network_cmd_port = "55355"` in `retroarch.cfg`. Cores: bsnes-mercury (SNES/SNI), SameBoy (LADX), Genesis Plus GX or SMS Plus GX (Zillion, Landstalker), Mupen64Plus-Next (Gauntlet Legends).
- **Tutorial URLs (V).** `https://archipelago.gg/tutorial/<Game Name>/<link>`. The link is `setup/en` for most games, `multiworld/en` for ALttP, SM, SMZ3, SoE, TLoZ and FF1, `guide/en` for Celeste 64, Celeste Open World and Paint, `landstalker_setup/en` and `wargroove/en`.

**Emulated-game matrix (V unless noted).** "Gen" means the ROM is also needed on the **host** at generation time. Tier: **Full** = one click once the ROM and emulator are known; **Assisted** = the app configures things but the user does some steps; **Guided** = instructions only.

| Game | Plat | Base ROM (MD5) | Emulator | AP client | Patch → out | host.yaml key | Tier |
|---|---|---|---|---|---|---|---|
| A Link to the Past | SNES | `Zelda no Densetsu - Kamigami no Triforce (Japan).sfc` JP1.0 `03a63945398191337e896e5771f77173` (Gen) | SNI: snes9x-nwa, snes9x-rr, bsnes-plus-nwa, BizHawk BSNESv115+, RetroArch 1.10.1+ bsnes-mercury, FXPak | SNI | .aplttp → .sfc | lttp_options.rom_file | Assisted |
| Super Metroid | SNES | `Super Metroid (JU).sfc` `21f3e98df4780ee1c667b84e57d88675` | SNI | SNI | .apsm → .sfc | sm_options.rom_file | Assisted |
| SMZ3 | SNES | SM JU + ALttP JP1.0 | SNI | SNI | .apsmz3 | sm_options + lttp_options | Assisted |
| Secret of Evermore | SNES | `(USA)` `6e9c94511d04fac6e0a1e582c170be3a` (Gen) | SNI | browser client evermizer.com/apclient | .apsoe | soe_options | Assisted |
| Super Mario World | SNES | `(USA)` `cdd3c8c37322978ca8669b34bc89c804` (Gen) | SNI | SNI | .apsmw | smw_options | Assisted |
| Kirby's Dream Land 3 | SNES | US `201e7658f6194458a3869dde36bf8ec2` / JP `b2f2d004ea640c3db66df958fce122b2` | snes9x-nwa/rr, BizHawk BSNES, bsnes-plus-nwa (**not RetroArch**) | SNI | .apkdl3 | kdl3_options | Assisted |
| Yoshi's Island | SNES | `(U)` 1.0 `cb472164c5a71ccd3739963390ec6a50` (Gen) | snes9x-rr/nwa, BizHawk (**not RetroArch or FXPak**) | SNI | .apyi | yoshisisland_options | Assisted |
| Lufia II Ancient Cave | SNES | `(USA)` `6efc477d6203ed2b3b9133c1cd9e9c5d` (Gen) | SNI | SNI | .apl2ac | lufia2ac_options | Assisted |
| EarthBound | SNES | `a864b2e5c141d2dec1c4cbed75a42a85` / VC `6d71ccc8e2afda15d011348291afdf4f` | snes9x-rr/nwa, BizHawk, RetroArch 1.10.3+ | SNI | .apeb | earthbound_options (L) | Assisted |
| FF Mystic Quest | SNES | `(U)` V1.0/1.1 | snes9x-rr, BizHawk, RetroArch | SNI (manual) | .apmq patched at ap.ffmqrando.net | n/a | Guided |
| Pokemon Red/Blue | GB | Red `3d45c1ee9abd5738df46d2bdda8b57dc` / Blue `50927e843568814f7ed45ec4f944bd8b` | BizHawk | BizHawk | .apred/.apblue → .gb | pokemon_rb_options.red_rom_file / blue_rom_file | **Full** |
| Pokemon Emerald | GBA | `605b89b67018abcea91e693a4dd25be3` | BizHawk 2.7+ | BizHawk | .apemerald → .gba | pokemon_emerald_settings.rom_file | **Full** |
| Mario & Luigi SS | GBA | `4b1a5897d89d9e74ec7f630eefdfd435` | BizHawk | BizHawk | .apmlss | mlss_options (L) | **Full** |
| Castlevania 64 | N64 | US 1.0 `1cc5cf3b4d29d8c3ade957648b529dc1` | BizHawk 2.7+ (Controller Pak) | BizHawk | .apcv64 → .z64 | cv64_options | **Full** (Linux N64 U) |
| CV Circle of the Moon | GBA | `50a1089600603a94e15ecf287f8d5a1f` / `87a1bd6577b6702f97a60fc55772ad74` | BizHawk 2.7+ | BizHawk | .apcvcotm | cvcotm_options | **Full** |
| Mega Man 2 | NES | `0527a0ee512f69e08b8db6dc97964632` / VC `0c78dfe8e90fb8f3eed022ff01126ad3` / LC `37f2c36ce7592f1e16b3434b3985c497` / `Proteus.exe` `b69fff40212b80c94f19e786d1efbf61` (iNES header skipped) | BizHawk 2.7+ | BizHawk | .apmm2 → .nes | mm2_options | **Full** |
| Mega Man 3 | NES | `4a53b6f58067d62c9a43404fe835dd5c` / LC `5266687de215e790b2008284402f3917` / VC `c50008f1ac86fae8d083232cdd3001a5` / Proteus.exe | BizHawk 2.7+ | BizHawk | .apmm3 | mm3_options | **Full** |
| Super Mario Land 2 | GB | `a8413347d5df8c9d14f97f0330d67bce` | BizHawk | BizHawk | .apsml2 (**not associated**) | sml2_options | **Full** |
| Yu-Gi-Oh! 2006 | GBA | EU `020411d3b08f5639eb8cb878283f84bf` / US `b8a7c976b28172995fe9e465d654297a` | BizHawk 2.7+ | BizHawk | .apygo06 | yugioh06_settings | **Full** |
| Final Fantasy | NES | ROM comes from finalfantasyrandomizer.com; no AP patch | BizHawk | BizHawk (manual) | n/a | ffr_options.display_msgs | Guided |
| MMBN3 | GBA | `6fe31df0144759b34ad666badaacc442` (Gen; Legacy Collection `rom_b_e.srl`) | BizHawk 2.7+, connector_mmbn3.lua | MMBN3 Client | .apbn3 | mmbn3_options | Assisted |
| Zelda 1 | NES | PRG0 `337bd6f1a1163df31bf2633665589ab0` (Gen) | BizHawk, connector_tloz.lua | Zelda 1 Client | .aptloz | tloz_options | Assisted |
| Adventure | 2600 | `ADVNTURE.BIN` `157bddb7192754a45372be196797f284` | BizHawk, connector_adventure.lua | Adventure Client | .apadvn | adventure_options (rom_start + rom_args) | Assisted |
| Ocarina of Time | N64 | US 1.0 `5bd1fe107bf8106b2ab6650abecd54d6` (byteswapped `6697768a7a7df2dd27a692a2638ea90b`, decompressed `05f0f3ebacbc8df9243b6148ffe4792f`) (Gen) | BizHawk 2.10+, connector_oot.lua, expansion slot | OoT Client (no auto-connect) | .apz5 → .z64 | oot_options | Assisted |
| Links Awakening DX | GBC | `07c211479386825042efb4ad31bb525f` | RetroArch 1.10.3+ SameBoy, or BizHawk 2.8+ | LADX Client | .apladx → .gbc | ladx_options | Assisted |
| Zillion | SMS | `d4bf9e7bcf9a48da53785d2ae7bc4270` | RetroArch 1.10.3+ Genesis Plus GX / SMS Plus GX | Zillion Client | .apzl → .sms | zillion_options (rom_start `retroarch`) | Assisted |
| Gauntlet Legends | N64 | `9cb963e8b71f18568f78ec1af120362e` | RetroArch Mupen64Plus-Next only; client hard-codes `retroarch.exe` (Windows) | GL Client | .apgl → .z64 | gl_options | Assisted (Win) |
| The Wind Waker | GC | NTSC-U ISO | Dolphin + tanjo3/wwrando `ap_2` build | TWW Client | .aptww is an input to wwrando | n/a | Guided |
| Landstalker | Genesis | US ROM | RetroArch/BizHawk Genesis Plus GX | `randstalker_archipelago.exe` (Win) | n/a | n/a | Guided |
| Faxanadu / SM64EX | NES / PC port | ROM copied into Daxanadu / `baserom.us.z64` | Daxanadu.exe / SM64AP-Launcher build | in-game / CLI flags | n/a / .apsm64ex | n/a | Guided |

**PC games (V):**

| Mechanism | Games | What the app can do |
|---|---|---|
| Config file the app could write | Celeste 64 (`AP.json {"Url","SlotName","Password"}`), Meritous (`meritous-ap.json`), DLCQuest (`ArchipelagoConnectionInfo.json`) | Write the file natively |
| CLI-flag launch | DOOM/DOOM II (`crispy-apdoom -game doom -apserver h:p -applayer slot [-password]`), Heretic, Aquaria (`--name --server --password`), VVVVVV (`-v6ap_name -v6ap_ip -v6ap_passwd` or `-v6ap_file`), SM64EX (`--sm64ap_name --sm64ap_ip --sm64ap_passwd`) | Launch with arguments once the game path is known |
| File drop | Civ VI (unzip `.apcivvi` into `Documents/My Games/Sid Meier's Civilization VI/Mods/civilization_archipelago_mod`, Windows only), Factorio (slot mod zip into `%APPDATA%\Factorio\mods` or `~/.factorio/mods`; Space Age disabled; standalone Factorio 2.0 server) | Native handler |
| AP itself installs or patches | Undertale (`/auto_patch`), The Messenger, Saving Princess, Wargroove, SC2 (`/download_data`), Jak and Daxter (OpenGOAL), TUNIC (`tunic_options.game_path`) | Launch the AP component |
| Mod manager / loader | Hollow Knight (Lumafly one-click URL), Celeste Open World (Olympus), Stardew (SMAPI + mod 7.x matching the generator), RoR2 and Inscryption (Thunderstore/r2modman), Terraria, Lingo, AHIT (Steam Workshop), KH1 and KH2 (OpenKH), BepInEx/MelonLoader games (Subnautica, Hylics 2, BRC, Muse Dash, TUNIC), SA2B, Raft, Noita, Satisfactory, OSRS (RuneLite) | Guide plus links; respect maintainers' wishes |
| Companion exe or website | Witness, DS3, Shivers, Timespinner, Landstalker, FFMQ, FF1, Yacht Dice / Paint (web), APQuest (built in) | Guide |

**Platform limits (V).** Windows-only: KH2 (Pymem), Civ6, Choo-Choo Charles, the Landstalker client, Muse Dash, Overcooked 2, and Gauntlet Legends (hard-coded paths). Undertale needs the Windows build through Proton. Subnautica and TUNIC on Linux need `WINEDLLOVERRIDES="winhttp=n,b"`. **The app must never download ROMs, ISOs or WADs.**

### 1.12 Ecosystem and competitors

| Tool | Stack / license | Relevant facts | Lesson for us |
|---|---|---|---|
| Official Launcher | Kivy/KivyMD, in core | Component list with search and favorites; drag-and-drop patch or apworld; archipelago:// picker; desktop shortcuts. Issue #4507 calls it "a brick wall" and notes users juggle launcher, server, YAML editor, file explorer, client and emulator. | Our value is guided Setup / Host / Join flows. |
| Options Creator (since 0.6.5) | Kivy, in core | Single game, simple_ui options, export only. | We add weights, multi-game, validation and custom worlds. |
| Archipelago Setup Tool | Unity/C#, MIT, Windows only | v2.2.3 (2026-10-07), claims 142 games. About 170 downloads per release; 5 stars; 207 MB installer. Guesses paths from a hard-coded config; **rehosts** apworlds, DLLs, UE4SS and snes9x-nwa. **Stardew maintainer asked for removal (issue #9).** SmartScreen warning. | Don't rehost; download from official URLs; honor opt-outs; sign the binary. |
| Zephyr | Tauri 2 + Svelte 5 + Rust, GPL-3.0 | Randomizer panel: JSON-schema YAML builder, generate, host locally and on archipelago.gg, apworld panel. 27 stars; about 129 downloads. **Forked runtime plus Python venv; patches SNIClient.py and host.yaml.** Remote host flow: uploads → new_room → room_status → scrape the tracker link; probably no cookie store. Issue #20: it ignored the user's existing custom_worlds. | Tauri works; use the official build; reuse the user's custom_worlds; keep the session cookie. |
| PelagoHaven | Tauri + React | Prototype; the README is still the template. | Space is open. |
| MultiworldGG | GPL-3.0 fork of AP | Bundles community worlds, versions itself 0.7.273, has its own lobbies. | A separate ecosystem; don't mix it with official installs. |
| GameSupportTracker | Python, 11 stars | Parses the community sheet; imports Steam and Playnite libraries; shows PopTracker availability and the latest GitHub release. | "Which of my games are playable" is a desirable feature. |
| ArchipelagoWizard | C++/wx, Windows, last push 2025-04 | `wizard.apworld` dumps an exact option schema. | Prior art for a Tier-3 schema exporter. |
| SpYaml, small web editors | Various | Parse only files still shaped like templates; few users. | Low competition for a strong YAML editor. |
| PopTracker | C++, GPL-3.0, 195 stars | CLI automation flags. Win zip has 48,534 downloads. | Integrate; don't replace. |
| Universal Tracker | apworld | `Tracker_v0.3.5`: 1,857 downloads in about 5 days. | One-click install is valuable. |
| Cheese Trackers | Rust + Vue | Async room tracker with slot claims, BK status, notes, Discord pings. | Link to it rather than rebuilding it. |
| Axolotl, HydraTextClient, Remote, Topher's web client, HintMachine, AP Checklist Tracker | Various | Alternative clients. | Optional links. |
| bridgeipelago, AST (ast-bot.com, FR/EN), AginahBot | Discord bots | AST's self-hosted mode manages YAMLs and apworlds. | French-speaking demand exists. |
| AsyncTools (official) | Python | Mystery filler YAMLs; batch `ArchipelagoGenerate.exe --spoiler 0 --multi N`. | Async organizer patterns. |
| Naxomega French guide | Docs | Says the AP software is English-only; the host must install the exact apworld of each unofficial game; recommends website hosting. | FR localisation plus an "apworld parity" check. |

The official Discord has more than 140,000 members (`discord.gg/8Z65BR2`).

### 1.13 Branding cues (V/L)

- **archipelago.gg:**
  - Logo `#316B84` (deep teal); nav links `#2F6B83`, uppercase LondrinaSolid-Light; body font Lexend Deca; dark-theme links `#FFEF00`.
  - Themed backgrounds: ocean averages `#3667B1`, grass `#3FB24A`; panels are "island" cards.
  - The imagery is **"Copyright 2022 LegendaryLinux, all rights reserved"** and must not be reused. The code is MIT. The fonts are open (Google Fonts).
- **App icon:** six pastel circles: `#C97682`, `#75C275`, `#CA94C2`, `#D9A07D`, `#767EBD`, `#EEE391`. Kivy defaults: Dark theme, Lightsteelblue palette.
- **Item colors players recognise:**
  - Progression: plum `#AF99EF`
  - Useful: slateblue `#6D8BE8`
  - Trap: salmon `#FA8072`
  - Filler: cyan `#00EEEE`
  - Own name: magenta `#EE00EE`
  - Other players: `#FAFAD2`
  - Location: `#00FF7F`
- **PopTracker accessibility colors:** red = not accessible, yellow = out of logic, green = in logic, blue = scout only, grey = collected.

---

## 2. Contradictions between researchers, and their resolution

| # | Conflict | Resolution |
|---|---|---|
| C1 | **Installer signing.** `ecosystem-ux`: the installer "is signed (SignTool)". `install-layout`: CI builds with `/DNO_SIGNTOOL`; the release is hand-built and its signing is unknown (setup.py references a signtool sha1 `6df76fe776b82869a5693ddcb1b04589cffa6faf`). | **Unresolved.** `inno_setup.iss` *supports* signing, but nobody has checked the 0.6.8 binary. Always verify sha256 against the API `digest`; check Authenticode when a signature is present. Test with `Get-AuthenticodeSignature` once a download is approved. |
| C2 | **Is host.yaml overwritten on upgrade?** The official guide (repeated by `ecosystem-ux`, `clients-emulators` and `generate-host`) says yes. `install-layout`'s code reading says host.yaml is not shipped (gitignored, not in `extra_data`), so Inno never replaces it, and `--update_settings` only adds missing keys. | **Code wins, but still marked U.** The guide is probably stale (like other stale docs). The app backs up `host.yaml` and `options.yaml` before any install either way. Confirm in a VM. |
| C3 | **"Put persistent overrides in options.yaml"** (`install-layout`, `generate-host`) vs the actual lookup semantics. | **Clarified (V, `settings.py:885-907`).** options.yaml does not layer on top of host.yaml; it **replaces** it, because the first file found is the only one loaded, and missing keys are then filled with defaults and saved back. The app must never create a partial `user_path/options.yaml`. It edits whichever file AP will load, using the same algorithm. For per-session overrides it spawns AP with **cwd = a session folder containing a complete settings file** (cwd lookup applies when cwd ≠ install dir). That is also the only way to switch off store_true flags that host.yaml sets to true. |
| C4 | **Is there a maintained apworld index or lobby?** `ecosystem-ux`: none; Eijebong's index and lobby are archived. `apworld-ecosystem`: `ionium-ap/Archipelago-index` is active (pushed 2026-10-16, 630 TOMLs, 499 locked hashes, bases 0.6.7 and 0.6.8), with a lobby at `ap-lobby.ionium.us`. | **`apworld-ecosystem` is right** (verified via gh api; GitHub search tends to miss forks). Bananium's lobby is dead; ionium's lobby exists but its JSON API is admin-only. The ionium index is the primary curated source. |
| C5 | **Which community catalog?** `apworld-ecosystem` could not find the old sheet and used the Miraheze wiki (966 pages). `ecosystem-ux` found the sheet (`1iuzDTOA...`, gid 58422002, about 914 rows). Category names also differ: "Implementations with PopTracker" (226) vs `Category:Games_with_PopTracker` (used by GameSupportTracker). Page counts differ too: 3422 pages / 1091 articles vs "about 1,592 main-namespace pages". | **Both sources are valid and complementary.** Primary: ionium index (hashes, AP-version ranges) plus wiki API (structured, CORS, status and links). Optional: the sheet for its Stability column, parsed defensively. Discover category names at runtime with `list=allcategories` rather than hard-coding them. The page-count gap is redirects and namespaces; it does not matter. |
| C6 | **Linux distribution format.** `install-layout`: prefer the AppImage (one file to replace, data in XDG) and fall back to tar.gz without FUSE. `ecosystem-ux`: prefer tar.gz in per-version folders, avoiding FUSE and the `/tmp/.mount_*` bug #5863. But **a tar.gz in a writable dir keeps user data inside the install folder** (`user_path == local_path`), so per-version folders would split host.yaml, Players and custom_worlds between versions. FUSE: `ecosystem-ux` says the AppImage needs FUSE2 (true for PopTracker's AppImage); `install-layout` says the type2-runtime requirement is unknown. | **Proposed default: tar.gz** extracted to an app-owned folder, in one of two modes. **(a)** One stable folder, updated in place by mirroring Inno: delete `lib/` and the root executables, then extract over. **(b, experimental)** Remove write permission on the extracted top folder (`chmod a-w`). AP's own `os.access(local_path, W_OK)` check then sends user data to `~/.local/share/Archipelago`, as with the AppImage. That gives side-by-side versions sharing one data dir, with no FUSE and no mount paths. (b) must be tested: root bypasses W_OK, and some code may write to local_path. Support existing AppImages too. The AppImage's FUSE needs stay **unresolved**. |
| C7 | **Website player cap.** The guide says 30; the code's `MAX_ROLL` default is 20. `/api/generate` counts files or weights entries; `/generate` counts players. | **Unresolved** (the production config is private). Read the live limit from a 409's `detail` field. Route sessions with more than 20 players to local generation plus upload. |
| C8 | **BizHawk connector ports:** 43055-43059 (`clients-emulators`, `_bizhawk/__init__.py`) vs 43055-43060 (`ecosystem-ux`, `connector_bizhawk_generic.lua:292-294`). | Minor. Localhost only, so no firewall impact. Use 43055-43060 for "port busy" diagnostics. |
| C9 | **BizHawk minimum version.** Game guides say 2.3.1+ (Pokemon R/B, TLoZ, Adventure); the generic connector refuses anything below 2.7 and warns above 2.11; the OoT guide requires 2.10+. | Install a pinned **BizHawk 2.11.1**, which satisfies every constraint. Re-check on each AP release. |
| C10 | **Side-by-side AP versions.** `ecosystem-ux` recommends a version manager. `install-layout`: the Inno installer has one AppId, `UsePreviousAppDir`, and global file associations and URI. | **Windows: one installed version in v1.** Side-by-side is an open question; it is feasible on Linux through C6(b). |
| C11 | **Lower-case apworld names.** The spec requires them, yet `LostKingdoms2.apworld` and `TerraNil.apworld` are distributed and listed. | **Unresolved for frozen Python 3.12.** Never change the case. The target name is always `<inner folder>.apworld`. |
| C12 | **Hosting priority.** The French guide and `ecosystem-ux` favour archipelago.gg hosting; `generate-host` focuses on local hosting. | A product choice, not a factual conflict. **Default to archipelago.gg for internet play** (no ports, no CGNAT problems), local hosting for LAN, and local hosting plus a networking helper for power users. |

---

## 3. What can be automated vs what must be guided

Levels:
- **Auto**: no user action beyond a click or consent.
- **Assisted**: the app does the work, but needs one human input (a file, a UAC prompt, a choice).
- **Guided**: only instructions and links, because a third-party tool, website or legal boundary is involved.

### 3.1 Organizer / host journey

| Step | Level | How (grounded in facts) | Human-only part |
|---|---|---|---|
| Install or upgrade AP (Windows) | Assisted | `GET /releases/latest` → pick the asset by regex → download → check sha256 against `digest` → close `Archipelago*.exe` → back up the settings file and `custom_worlds` → `ShellExecuteEx` with verb `runas` running the Setup with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CLOSEAPPLICATIONS /TASKS="deletelib" /LOG=...` → map exit codes 0-8 → tail the log for progress. Then run `ArchipelagoLauncherDebug.exe --update_settings`. | One UAC prompt; a small vc_redist window may appear |
| Install or upgrade AP (Linux) | Auto | Download the tar.gz, verify sha256 (optionally `gh attestation verify`), extract, and apply the update strategy from C6. Write `~/.local/share/applications/archipelago.desktop` with `MimeType=x-scheme-handler/archipelago;` (plus apworld/archipelago MIME XML), then `xdg-mime default ...` and `update-desktop-database`. | None (no root needed) |
| Detect the existing install and its state | Auto | Uninstall key (64-bit view), `manifest.json`, the HKCR command, and the default path. Resolve user_path, custom worlds, the settings file in use, the cache dir, and running AP processes. | None |
| Get YAMLs from players | Assisted | Drag-and-drop inbox (`.yaml`, `.yml`, `.zip`, multi-document); an export/share flow on the player side. No relay server in v1. | Players must send their files (Discord, etc.) |
| Validate YAMLs | Auto | Port `roll_settings` checks without rolling, plus the schema (see section 4). Check names (16 characters, unique case-insensitively, not "Archipelago"), `requires`, game section present, unknown games and missing apworlds. | Fixing a bad YAML may need its author |
| Install the custom apworlds the YAMLs need | Assisted | Map `game:` to the index entry (`name` = manifest game) → download from the official URL → check sha256 from `index.lock` or the GitHub `digest` → validate the zip and manifest → copy atomically to `custom_worlds/<folder>.apworld`. | **Explicit trust confirmation** (arbitrary code); unindexed worlds are guided |
| Provide generation-time ROMs | Assisted (once) | ROM vault: MD5 match (strip the 512-byte SNES header), copy to `user_path/<default name>` or write the absolute path to `<key>.rom_file`. | The user supplies their own dump |
| Generate | Auto | Spawn `ArchipelagoGenerate` with cwd = the session folder (which holds a complete settings file), `--player_files_path <ws>/players --outputpath <ws>/output --spoiler N [--seed] [--race] [--plando ...]`, `stdin=DEVNULL`, `CREATE_NO_WINDOW`, UTF-8 decoding. Parse the progress lines; success = exit 0 plus the `Creating final archive at` line. | None |
| Host on archipelago.gg | Auto after consent | Keep a cookie jar and an identity UUID4 (stored in the keychain, rebound with `GET /session/<uuid>`) → `POST /uploads` without following redirects → read `Location: /seed/<id>` → `GET /new_room/<id>` → `/room/<id>` → `GET /room/<id>?update` → poll `/api/room_status` until `last_port > 0` (-1 means error) → show `archipelago.gg:<port>`. | Consent to upload (passwords are baked into the zip) |
| Host locally (LAN) | Auto | Pick a free port → spawn `ArchipelagoServer <abs zip> --port P` with every mode flag set explicitly and `--disable_item_cheat` → keep a stdin pipe → wait for `server listening on` → list the localhost and LAN IPs. | Possibly the Windows Firewall prompt |
| Host locally (internet) | Assisted to Guided | Try UPnP-IGD / NAT-PMP / PCP for the TCP port, find the public IP ourselves, detect CGNAT (router WAN IP ≠ public IP), run a reachability probe, and add a firewall rule (`netsh advfirewall ...`, UAC plus consent). When it fails: offer archipelago.gg, Tailscale/ZeroTier, or playit.gg/ngrok TCP. | Router admin, CGNAT, tunnel accounts |
| Share join info | Auto | Copy-ready text: host:port, slot, password, and `archipelago://<urlenc slot>:<urlenc pw>@host:port?game=<urlenc game>` (always with `game`). For a site room, the room URL is enough. For local hosting, extract each player's file from `AP_<seed>.zip` into per-player folders. | Sending the text or files |
| Run the session | Auto | Console UI over stdin (`/players`, `/status`, `/send`, `/release`, `/collect`, `/countdown`, `/option`, `/save`). Event feed from `Notice` lines; later a Tracker WebSocket client. On the site: `POST /room/<id> cmd` and `/log` with Range. | None |
| Stop or resume | Auto | `/exit\n` (never kill) → `.apsave` is flushed. Resume = same zip and same `--savefile` (warn that the save overrides the options). | None |

### 3.2 Player journey

| Step | Level | How | Human-only part |
|---|---|---|---|
| Install AP | Assisted (Win: UAC) / Auto (Linux) | Same as the organizer flow. | UAC |
| Create a YAML | Assisted | Editor fed by local templates (`Generate Template Options -- --skip_open_folder`), site presets and the datapackage. YAML 1.1-safe writer. | Choices |
| Install the apworld for their own custom game | Assisted | Same as the organizer flow (needed for client components and Universal Tracker). | Trust confirmation |
| Join a room | Auto | Paste a room URL or click an `archipelago://` link → `GET /api/room_status/<room>` → pick a slot → download `https://archipelago.gg` + `download` (after `last_port > 0` so `server` is filled in) into a writable per-room work folder. | Choosing the slot |
| Provide the ROM | Assisted (once) | Read `base_checksum` from the patch manifest → find it in the ROM vault → otherwise ask once, verify, and remember. | Owning the dump |
| Emulator, BizHawk games | Auto on Windows / Assisted on Linux | Download BizHawk 2.11.1 from TASEmulators; on Windows check vc_redist; on Linux check mono, openal, lua5.4 and lsb_release and prompt for the package install. Set `bizhawkclient_options.emuhawk_path` (`EmuHawkMono.sh` on Linux) and `rom_start: true`. | Installing Linux packages |
| Patch, launch, connect (BizHawk worlds: Pokemon R/B, Emerald, MLSS, CV64, CotM, MM2, MM3, SML2, YGO06) | **Auto** | Run `ArchipelagoBizHawkClient <patch>` (AppImage: `--executable=ArchipelagoBizHawkClient`). It patches, launches EmuHawk with the connector, and auto-connects using `server`. | None |
| OoT, TLoZ, MMBN3, Adventure, and SNI games | Assisted | Wrapper script (`.bat`/`.sh`) that starts the emulator with `--lua=<connector>` and is set as `rom_start` / `snes_rom_start` (**U**: untested). Adventure has native `rom_args`. SNI is auto-started by the client. Manual connect for OoT. | Emulator choice; some games need manual connect |
| LADX, Zillion, Gauntlet Legends (RetroArch) | Assisted | Write `network_cmd_enable/port` to `retroarch.cfg`, check the cores, set `rom_start`. GL is Windows-only. | Installing RetroArch |
| FFMQ, FF1, TWW, Landstalker, SM64EX, KH1/KH2, mod-manager PC games | Guided | Tutorial links (`/tutorial/<Game>/<link>`), official installer links (Lumafly one-click, Thunderstore, Workshop), version checks (Stardew 7.x, wwrando ap_2). | Third-party sites and tools |
| PC games with config files or CLI flags | Assisted | Write `AP.json` / `meritous-ap.json` / `ArchipelagoConnectionInfo.json`, or launch with flags once the game path is set. Civ6 and Factorio file drops. | Locating the game |
| Tracker | Assisted | Download PopTracker, install the pack from its GitHub release into `Documents/PopTracker/packs`, launch `--load-pack <uid> --ap-host --ap-slot --ap-password`. Or install the Universal Tracker apworld. | Pack availability per game |
| Text client / hints | Auto | `ArchipelagoTextClient --connect host:port --name N --password P`. | None |

---

## 4. Recommended feature set (ranked by value/effort)

### 4.1 Ranking

| Rank | Feature | Value | Effort | Phase |
|---|---|---|---|---|
| 1 | AP install and update manager (Win + Linux), including detection | Very high | M | **MVP** |
| 2 | "Doctor": environment scan (paths, versions, settings file in use, running processes, broken or manifest-less apworlds, port usage) | High | S | **MVP** |
| 3 | Session wizard: YAML inbox → validation → local Generate with live progress and friendly errors | Very high | M-L | **MVP** |
| 4 | Local hosting: port picker, readiness, console, share links, safe stop and resume | Very high | M | **MVP** |
| 5 | One-click archipelago.gg hosting (upload, room, owner identity, wake, console, log) | Very high | M | **MVP** (behind consent; ask the maintainers) |
| 6 | Join flow: room URL / `archipelago://` / patch drop → download → patch and launch | Very high | M | **MVP** |
| 7 | ROM vault (MD5 table + `base_checksum`, settings fill) | High | S | **MVP** |
| 8 | BizHawk autopilot (download, prerequisites, `emuhawk_path`) | High | M | **MVP** |
| 9 | APWorld manager: install from file or URL with validation, list with manifest data, conflict prediction, disable/remove, backups; ionium catalog browser | High | M | **MVP** (catalog browser may slip to v1.1) |
| 10 | Linux desktop integration (URI + MIME), and the missing Windows associations (`.apsml2`, `.aptww`) | High (Linux) | S | **MVP** |
| 11 | FR/EN localisation and a polished UI | High | M | **MVP** |
| 12 | Visual YAML editor (template-derived schema, simple and weighted modes, presets, autocomplete) | High | L | v1.1 |
| 13 | NAT helper: UPnP/NAT-PMP/PCP, CGNAT detection, reachability test, firewall rule, tunnel guidance | High | M-L | v1.1 |
| 14 | Live dashboard: stdout events → Tracker WebSocket client; site `/api/tracker` for site rooms | Med-High | M | v1.1 |
| 15 | PopTracker and Universal Tracker integration | Medium | M | v1.2 |
| 16 | SNI, RetroArch and wrapper-script helpers | Medium | M | v1.2 |
| 17 | APWorld update notifications and an aggregated `catalog.json` (GitHub Action + Pages) | Medium | M | v1.2 |
| 18 | PC-game helpers (Factorio, Civ6, config-file and CLI games) | Medium | L (per game) | v2 |
| 19 | Advanced YAML: triggers, item_links and plando editors; opt-in deep-schema exporter apworld | Medium | XL | v2 |
| 20 | Cloud generation through `/api/generate` | Low-Med | S | v2 (local generation covers it) |
| 21 | Side-by-side AP versions | Low-Med | L | v2 / open question |

### 4.2 Architecture (cross-cutting)

- **Shell.** Tauri 2: a Rust core plus a web UI (Svelte or React). Zephyr and PelagoHaven prove the stack, and it yields small binaries.
  - Windows: an NSIS **per-user** installer, so the app itself needs no admin rights. Code-sign it.
  - Linux: AppImage plus deb/rpm. Flatpak is deferred: its sandbox complicates spawning AP and running `xdg-mime`.
  - **Never install our files inside the AP root**: `[InstallDelete]` wipes `{app}\*.exe`.
- **Process runner (Rust).**
  - Set cwd explicitly: either the session folder with a complete settings file, or user_path. Never inherit a random cwd, because a stray `host.yaml` there would be picked up.
  - Generate: `stdin=null`. Server: stdin piped and kept open. Windows: `creation_flags(0x08000000)` (CREATE_NO_WINDOW).
  - Decode output as UTF-8 and handle prompt lines without a newline.
  - Strip `PYTHONHOME`, `PYTHONPATH` and (when we are an AppImage) `LD_LIBRARY_PATH`.
  - Use `ArchipelagoLauncherDebug.exe` whenever stdout is needed on Windows.
  - Never run AP elevated.
  - Prefer a ConPTY or openpty for the server if the buffering test fails.
- **Settings service.** Reimplement AP's lookup to know which file AP loads, and edit it with a comment-preserving YAML 1.1 library. In TypeScript, use the npm `yaml` package with `version: '1.1'`. Only edit while no AP process is running. Take a backup before every write.
- **HTTP (Rust reqwest).**
  - Persistent cookie store, redirects disabled for `/uploads`, `/new_room` and `/generate`.
  - Send `Accept-Encoding: gzip, br`, or enable zstd decoding.
  - Use a descriptive User-Agent and respect the cache timers.
  - Normalise relative paths and `http://` URLs to `https://archipelago.gg`.
  - Check the status code before parsing JSON (404s are HTML).
- **Secrets.** Store the archipelago.gg identity UUID and server passwords in the OS keychain (`keyring` crate: Windows Credential Manager, libsecret). Never log them; redact them from support bundles.
- **Data shipped with the app** (versioned per AP release, updatable remotely):
  - AppId, asset regexes, exe names;
  - suffix → component map, settings_key map;
  - ROM MD5 table (section 1.11);
  - tutorial-link map, log-line regexes, error-to-advice catalogue.

### 4.3 Technical approach per MVP feature

1. **Install and update manager.**
   - Windows: the sequence in 3.1. Detection order: uninstall key (64-bit) → `manifest.json` → `HKCR\archipelago\shell\open\command` → `ArchipelagoLauncher.exe` FileVersion → `C:\ProgramData\Archipelago` exists. Pass `/TASKS` explicitly, because Inno remembers previous choices.
   - Before an upgrade, quarantine corrupt or invalid custom apworlds. Otherwise the silent `--update_settings` step can block on a hidden messagebox.
   - Linux: the C6 strategy. Verify sha256, optionally the attestation.
   - Show "installed X / latest Y" by comparing against `/releases/latest`.
2. **Doctor.**
   - Resolve user_path, custom worlds and cache.
   - List apworlds by reading every `archipelago.json` statically (no code runs): game, world_version, min/max, missing manifest → "will break in 0.7.0".
   - Predict which file AP will load per game (highest world_version wins; loose core worlds always win).
   - Detect running `Archipelago*` processes and port 38281 in use.
   - Check the BizHawk version range.
   - Produce a one-click anonymised support bundle (logs from `user_path/logs`, with passwords redacted).
3. **Session wizard.**
   - Each session has an isolated workspace: `players/`, `output/`, and a complete `host.yaml` used as the cwd settings file.
   - Accept `.yaml`, `.yml`, zips and multi-document files; drop non-YAML files.
   - Validators follow section 1.9: YAML 1.1 parse with duplicate keys; `requires` format; name rules; `game` matches an installed world (exact case) with fuzzy suggestions; a section for every game with weight > 0; no `+`/`-` keys outside triggers; `quantity` vs allow_quantity; plando items vs `plando_options`.
   - Presets:

     | Preset | Settings |
     |---|---|
     | Casual sync | `--disable_item_cheat`, hint_cost 10, release/collect auto, spoiler 2 for more than 10 players |
     | Async | auto_shutdown 0 |
     | Race | `--race`, spoiler 0, compatibility 0 |

   - Progress UI from the stdout stage lines. Errors come from the stderr tail starting at the last `<Type>: ` line, truncated (FillError can be huge), with a link to the full log.
4. **Local hosting.**
   - Free-port check, spawn the server, wait for `server listening on` (with a timeout fallback on `Hosting game at` plus a TCP connect probe).
   - Address cards: localhost, LAN IPv4s, and the public IP from our own lookup.
   - Console. Stop with `/exit`. Explicit `--savefile`, so read-only multidata locations work.
5. **archipelago.gg hosting.**
   - Flow as in 3.1. Show a consent dialog stating that the zip contains the host.yaml `password`/`server_password` in plaintext, and offer to set them deliberately.
   - "Open as owner in browser" via `/session/<uuid>`. Console via `POST /room/<id> cmd`; log tail via `/log` with Range.
   - "Wake room" via `GET /room/<id>?update`, then re-read `last_port`. Never retry `/new_room` blindly.
6. **Join flow.**
   - Room URL → `room_status` → slot picker → download → read the patch manifest → route by suffix:
     - BizHawk suffixes → `ArchipelagoBizHawkClient`
     - SNI suffixes → `ArchipelagoSNIClient`
     - `.apz5`, `.apbn3`, `.aptloz`, `.apadvn`, `.apzl` → their own clients
     - `.apladx`, `.apgl`, `.apcivvi` → Launcher
     - **Never send a `.zip` to the Launcher.**
   - `archipelago://` handler: validate `?game=`, then either pass the URL to the Launcher or call `ArchipelagoTextClient --connect`.
   - For a stale patch `server` field, refresh it from `room_status` (the room's port may have changed).
7. **ROM vault.** The user picks a ROM folder; the app hashes candidates.
   - Header rules: for SNES, strip 512 bytes when `size % 1024 == 512`; for MM2/MM3, strip the 16-byte iNES header.
   - Match against the table and against `base_checksum`, then write the settings key or copy to the default name.
   - Never download, link or share ROMs.
8. **BizHawk autopilot.**
   - Pinned 2.11.1 from `github.com/TASEmulators/BizHawk/releases`, installed into an app-owned folder. Windows: check vc_redist, fall back to the BizHawk-Prereqs installer. Linux: dependency checks.
   - Set `emuhawk_path` and `rom_start`.
   - On Linux tar.gz installs, the connector path is stable, which avoids #5863.
9. **APWorld manager.** Validation as AP does it, plus the manifest checks AP skips:
   - one top-level folder, `__init__.py`;
   - target name `<folder>.apworld` (rename versioned assets);
   - `compatible_version ≤ 7`;
   - installed core version within `[min, max]`;
   - the game is not already provided by a higher `world_version`.

   Download to temp → verify the hash → atomic rename. Guard against zip bombs and path traversal; read the zip, never extract or execute. Disable a world by moving it to an app folder outside the scan path.
   - Catalog: ionium trees API + raw TOML + `index.lock`, filtered by the user's AP base, joined to the wiki dump by `owner/repo` (about 400 matches) for status, maintainer and setup link.
   - Trust tiers: Core / Indexed+hash / Wiki-linked release / Unknown file.
   - Release extras (client mods, templates, Setup exes from forks) are never auto-run.
10. **Desktop integration.**
    - Linux: a `.desktop` entry with `Exec=<launcher> %u`, `MimeType=x-scheme-handler/archipelago;application/x-apworld;...`, a shared-mime-info XML for `*.apworld` and `*.archipelago`, and an icon.
    - Windows: per-user (HKCU) associations only for the suffixes AP misses, and only with consent.
11. **Localisation and UI.**
    - FR/EN from day one; upstream is English-only and French tools show demand.
    - Original logo and illustrations: an islands-and-ocean feel with `#316B84`, an ocean blue near `#3667B1`, a yellow accent near `#FFEF00`, and a six-pastel accent set. Lexend Deca body; a chunky display face (avoid copying Londrina for identity).
    - Use AP's item colors in feeds. Label the app clearly as "Unofficial companion for Archipelago".

### 4.4 v1.1+ approaches (short)

- **YAML editor.** A tiered schema:
  - **T0:** static apworld manifests.
  - **T1:** local templates, regenerated headlessly and parsed with the deterministic line rules in 1.9.
  - **T2:** site `option-presets` plus the datapackage (per-checksum) for autocomplete.
  - **T3:** an opt-in exporter apworld modelled on ArchipelagoWizard.

  Internal schema per option: `kind`, `default`, `choices`, `aliases`, `range`, `specialRangeNames`, `validKeys`, verify flags, `counter{min,max}`, `visibility`, `confidence: exact|inferred`. The writer quotes YAML 1.1 ambiguous scalars, emits ints, writes `{}` for empty sections, never emits negative random-range, and writes `requires.version` as a quoted string.
- **NAT helper.** UPnP-IGD (e.g. the Rust `igd-next` crate), plus NAT-PMP/PCP, a lease removed on stop, a CGNAT heuristic, and a reachability check. Tunnel guides for Tailscale and playit.gg.
- **Dashboard.** Connect as `tags:["Tracker"]`, `game:""`, `items_handling:0`, `Get`/`SetNotify` on `_read_client_status_0_<slot>` and `_read_hints_0_<slot>`. For site rooms, poll `/api/tracker` no faster than every 60 s and `/api/static_tracker` no faster than every 300 s.
- **Catalog service.** A scheduled GitHub Action builds `catalog.json` from the ionium index, the wiki infoboxes and GitHub release metadata (authenticated) and publishes it on Pages. Clients then make 1 request, which avoids the 60 req/h limit. Keep a live fallback and a remotely updated per-world opt-out list.

---

## 5. Risks and pitfalls

### Security and trust
- **APWorlds run arbitrary Python** with the user's privileges every time most AP processes start (Launcher, Generate, clients, `--update_settings`, template generation). The ionium criteria are about quality, not security. Static keyword scans cannot tell a legitimate client (subprocess, ctypes, DLLs, `.pyc`) from malware. Mitigations: an explicit trust prompt showing source, author and sha256; hash pinning; no silent auto-update; an informational content summary that does not claim to prove safety.
- **`C:\ProgramData\Archipelago` is everyone-modify.** Any local user or process can drop code into `custom_worlds` or `lib` that will run when someone else launches AP. Mention this in the Doctor. Never run AP elevated.
- **Credentials leak through several channels:**
  - the `.archipelago` zip bakes `password`/`server_password` in plaintext;
  - server log lines for refused connections include the sent password;
  - `/options` prints the passwords;
  - the site identity UUID works as a login+password;
  - the WebHost room links use `:None@`.

  Redact these in logs, support bundles and shared console views.
- **Legal and community.** Never download or link ROMs, ISOs or WADs. Do not rehost apworlds, mods or emulators. Respect maintainers' opt-outs (the Stardew precedent).
  - Wiki content is CC BY-NC-SA 4.0: attribution, non-commercial, share-alike.
  - The ionium index has no license: fetch it at runtime with attribution, and ask permission.
  - archipelago.gg imagery is all rights reserved.

### Privileges and installation
- The AP installer always needs admin (one UAC prompt). `/CURRENTUSER` has no effect.
- The vc_redist window appears even in silent mode and may require a reboot.
- `deletelib` wipes `lib/` (anything users placed in `lib/worlds`, such as core overrides).
- `[InstallDelete]` removes all root `*.exe`.
- `Players/Templates` is overwritten on install and wiped by template regeneration. Users must keep their YAMLs directly in `Players/`.
- Uninstalling leaves user data behind. A "clean uninstall" must delete it explicitly, after confirmation.
- `os.access` on Windows ignores ACLs. An install in a non-writable custom folder breaks user_path, and there is no home fallback.

### Linux and AppImage quirks
- The FUSE requirement is unknown (type2-runtime).
- **The AppImage install dir is read-only and the `/tmp/.mount_*` path leaks into BizHawk arguments (#5863).**
- No URI or MIME registration.
- Terminal-emulator detection fails on some systems.
- The clipboard is X11-only, so paste fails under Wayland.
- `--appimage-extract-and-run` makes user_path a **temporary folder**, which can lose data. Never use it.
- The BizHawk Linux build needs Mono and other system packages, and has no N64 core.
- Distro reports: the AppImage fails to start (#5347, #5845); the SNIClient hangs (#6109).

### Process control traps
- **Generate blocks forever on `Press enter to close.`** if stdin is an open pipe.
- Missing ROMs open **hidden native file dialogs** from child processes, and there is no `--no-gui` flag.
- A corrupt apworld pops a blocking messagebox.
- Install APWorld through the Launcher blocks on a modal messagebox.
- The server ignores EOF on stdin. Killing it loses up to 60 s of progress. Windows cannot send SIGINT to a windowless child, so use `/exit`.
- The Launcher CLI takes several seconds per call (it imports all worlds).
- Server stdout is block-buffered when piped.
- `Hosting game at` is logged before the bind.

### Networking
- AP has no UPnP. CGNAT is common.
- Windows Firewall prompts on the first bind.
- Without `--host`, the server makes outbound IP lookups (up to 20 s when offline). `--host` restricts the bind to one address family or interface.
- `auto_shutdown` ignores connections that make no checks.

### archipelago.gg API
- The service is volunteer-run. `robots.txt` disallows crawlers, the production limits and rate limits are unknown, and automated upload or creation may not be welcome. **Ask in the Discord before shipping**, and use a descriptive User-Agent and backoff.
- Rooms are not idempotent. Disown routes are GETs with side effects.
- Ports change after a room sleeps.
- Losing the cookie means losing owner access.
- Field traps: `race='true'` gives a 500; omitting `server_password` gives the admin password `"None"`; any `plando_*` value enables the module; 404s are HTML; relative and `http://` URLs.
- Uploading a ROM inside the zip gives a 500.
- Web generation supports core worlds only, has a 20-30 player cap, and a 600 s time limit.

### Rate limits
- GitHub: 60 requests/hour unauthenticated, and 304 responses still count. Use a catalog service or an optional token.
- WebHost: tracker data no faster than 60 s; static tracker and slot data no faster than 300 s.
- The datapackage is 11 MB raw: use per-checksum fetches.

### Version mismatch
- Generator and server versions must be compatible (`minimum_versions.server`; `IncompatibleVersion`).
- Apworlds are filtered by `min`/`max_ap_version`. Core apworlds are pinned to their exact core version.
- **AP 0.7.0 will make missing or invalid manifests fatal.**
- Some world mods must match the generator version (Stardew mod 7.x, wwrando ap_2, OpenKH mod order).
- DKC3 left core in 0.6.8; Minecraft left in 0.6.2.
- The site's templates and presets track the site's AP version, not the local one.
- MultiworldGG seeds and apworlds are a separate ecosystem.

### Data loss
- AP rewrites settings files at exit. Concurrent edits by our app can be lost, so only edit while AP is not running.
- An existing `.apsave` silently overrides the new server options.
- A mismatched save is overwritten at exit.
- Template regeneration deletes the Templates YAMLs.

### UX and trust
- SmartScreen warnings and antivirus false positives (`sni.exe` flagged by Kaspersky, #5467) scare first-time users. Code-sign the app and explain false positives in plain language.
- Several official docs are stale: the components page, `~/Archipelago` for the AppImage, and "host.yaml is overwritten". Don't copy their claims into the UI.

---

## 6. Open questions needing a decision or a test

### Product decisions
1. **Scope:** official Archipelago only, or MultiworldGG too? Recommended: official only for v1.
2. **archipelago.gg automation:** may a third-party app upload seeds and create rooms automatically? This needs maintainer approval: a Discord request, a User-Agent convention, and expected limits. Until then, keep it behind explicit per-action consent, or fall back to "open the upload page in the browser".
3. **Linux strategy:** tar.gz mode (a) in-place vs (b) read-only shared-data; whether to keep AppImage support; deb/rpm/Flatpak packaging of our own app.
4. **Windows multi-version support:** keep a single AP version in v1?
5. **Catalog:** the ionium index and the wiki at runtime, or our own aggregated `catalog.json` service? Who maintains the overrides (tag prefixes for multi-world forks, wiki-to-module mapping)? Licensing and permission from ionium and the sheet maintainers.
6. **After Dark (18+) worlds:** hidden by default, with an opt-in?
7. **Core-world overrides** (moving `lib/worlds` files aside): offer it, given that it is fragile and impossible on the AppImage?
8. **YAML collection without a backend:** file exchange only, a lightweight relay, or integration with AST or Cheese Trackers?
9. **Tier-3 schema exporter apworld:** placing our own Python in the user's worlds folder. Opt-in only? What is a minimal valid manifest for 0.6.8 and 0.7.0 without registering a fake game?
10. **Code-signing budget** (OV vs EV) and the app's name and branding.
11. **Undocumented GitHub endpoints and an optional user token** as rate-limit fallbacks: acceptable?
12. **Default generation presets:** spoiler level and item-cheat default.

### Empirical tests needed (in a VM, on real installs)
1. Silent install of `Setup.Archipelago.0.6.8.exe`: exit codes, the vc_redist window, `deletelib`, UAC, `DisplayVersion` in the uninstall key, the Authenticode signature, `ArchipelagoLauncher.exe` FileVersion (`0.6.8.0`?). Also whether host.yaml survives an upgrade untouched (C2).
2. Actual file listings of the installer, tar.gz and AppImage: `Players/Templates/Presets`, `python3*.dll`, and that no `host.yaml` is shipped.
3. The FUSE requirements of the type2-runtime AppImage (Ubuntu 24.04, Steam Deck).
4. The C6(b) read-only tar.gz trick: user_path switches to XDG, and nothing writes to local_path.
5. `ArchipelagoLauncherDebug.exe "Generate Template Options" -- --skip_open_folder` runs headless with a meaningful exit code; the AppImage equivalent works without a display.
6. Whether the frozen server honours `PYTHONUNBUFFERED`; whether `server listening on` reaches stdout at loglevel info; exit codes of Generate and Server.
7. Generation time and RAM for 1, 5, 20 and 50 players on 0.6.8.
8. Whether `room_status.last_port` updates within 1-3 s after a wake.
9. Uppercase apworld names in frozen Python 3.12; merge keys under `UniqueKeyLoader`; writing an `.apsave` next to a read-only multidata.
10. OoT (Ares64) on BizHawk Linux; `.bat`/`.sh` wrappers as `rom_start` from the frozen clients; BizHawk `config.ini` keys; PopTracker pack uids per game; whether Civ6 gets its arguments through the Launcher.
11. Any world other than the 8 generation-time ROM worlds that reads a required Path setting during generation.

### Third-party or timeline
1. archipelago.gg production values: `MAX_ROLL`, `JOB_TIME`, room and seed retention (`ROOM_AUTO_DELETE`), `GAME_PORTS`, any CDN or bot protection, and whether rooms use TLS.
2. The AP 0.7.0 release date: manifest enforcement means a migration UX (scan, fix or quarantine) must ship before it.
3. Long-term maintenance of the ionium index; a stable JSON export, if the maintainers are willing.
4. Maintainer opt-out list: which world authors do not want automated installs (precedent: Stardew).
