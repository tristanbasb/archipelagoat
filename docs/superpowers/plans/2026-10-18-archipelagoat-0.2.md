# ArchipelaGOAT 0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ArchipelaGOAT 0.2.0: game covers, check estimates and exact per-player check counts with balancing proposals, automatic Découverte / Standard / Complet profiles, and a one-dialog "Jeu prêt" flow.

**Architecture:** Seven new main/core modules (`covers`, `checks/datapackage`, `checks/pickle` + `checks/multidata`, `checks/measure`, `checks/balance`, `profiles`, `ready`), each a factory taking the injected `CoreContext` plus explicit deps, exposed through `defineService` services and typed `channel()` IPC like v1. The renderer gains `GameCover`, a Checks panel in the session check step, a profile section in the Studio preset menu and the "Jeu prêt" dialog. Exact counts come from throwaway single-player `ArchipelagoGenerate` runs whose `.archipelago` multidata is decoded by a data-only pickle reader.

**Tech Stack:** Electron 44, electron-vite 6, React 19, TypeScript 6.0, zod 4, Zustand 5, TanStack Query 5, i18next, Vitest 5 (projects unit / renderer / integration), Playwright 1.64, yauzl/yazl, node:zlib.

**Spec:** `docs/superpowers/specs/2026-10-18-archipelagoat-0.2-design.md` (builds on `docs/superpowers/specs/2026-10-16-archipelagoat-design.md`).

## Global Constraints

- Branch `feat/0.2` in its own worktree; one commit per task with identity `tristan <73985102+tristanbasb@users.noreply.github.com>`; never push, merge into `main` or tag without the user's explicit request. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Target Archipelago **0.6.8**; multidata format byte **3**.
- Cover hosts: exactly `static.wikitide.net` and `upload.wikimedia.org`, https only; image ≤ **2 MB** (2 \* 1024 \* 1024 bytes); signature PNG / JPEG / WebP / GIF; download timeout **20 s**; ≤ **4** concurrent downloads; cache ≤ **100 MB**, least recently viewed evicted first.
- Datapackage: `https://archipelago.gg/api/datapackage`, refreshed at most **weekly**, ≤ **32 MB**, keep only `{ max, checksum }` per game.
- Pickle reader: protocols 2–5, closed opcode list (spec §3.3), globals never resolved, depth ≤ **64**, inflate `maxOutputLength` **256 MB**.
- Measure: `--spoiler 0 --seed <seed> --skip_prog_balancing`, seeds **42** (fixed) or **42, 1337, 2026** for weighted YAMLs, timeout **2 min**, ≤ **2** concurrent, temp dirs `dataRoot/tmp/measure-<uuid>/` removed after each run and at startup.
- Balance: off-target beyond **±25 %**; targets short **0.6 ×** median, medium = median, long **1.5 ×** median, or a number; ≤ **12** single-option variants per player; ≤ **3** combined changes.
- Profiles: Découverte aims at **50–60 %** of Standard's checks; easy choices `easy, casual, beginner, normal, none, off, no_glitches, vanilla`; `death_link` off in all three.
- Common options never touched by balance or profiles: `progression_balancing, accessibility, local_items, non_local_items, start_inventory, start_inventory_from_pool, start_hints, start_location_hints, exclude_locations, priority_locations, item_links, plando_items, plando_connections, plando_texts, death_link` (death_link only set off by profiles).
- New error codes `CHECKS_NO_SCHEMA`, `MEASURE_TIMEOUT`, `MULTIDATA_UNREADABLE` (`{ reason }`); every code translated FR + EN (short title and help maps) with an action in `src/renderer/src/lib/errors.ts`.
- New task kinds `measure` (stages `prepare, generate, read, done`) and `ready` (stages `download, inspect, install, templates, profile, validate, deliver, done`); every stage listed in `src/renderer/src/lib/task-stages.ts` and translated.
- All UI strings FR + EN, same typography as the existing files (typographic apostrophe, U+00A0 before `: ; ! ?` in French).
- Unit and renderer tests never touch the network; real data only through fixtures. The app never executes an APWorld itself, never rehosts third-party files, never provides a ROM, never uploads to archipelago.gg without the user's consent.
- Gates after every task: focused tests, `npm run typecheck`, `npx eslint <changed files>`; after each wave: `npm test` (80 % coverage gate on `src/main/core/**`), `npm run test:integration`.

## Review Focus

- **Game name mismatch**: a catalog entry or wiki page titled "Pokémon Emerald" and a YAML `game: Pokemon Emerald` (accents, case, punctuation) must still find the cover and the estimate. → Task 3 test `covers resolve a game whose name differs only in accents or punctuation`.
- **Several players in one YAML file** (multi-document files are normal): each document is its own row and its own measure. → Task 7 test `measures each document of a multi-document player file separately`.
- **`game:` itself weighted among several games** (`game: { A Short Hike: 1, Hollow Knight: 1 }`): the row shows the game as random and a range over the three seeds instead of failing. → Task 7 test `a YAML whose game is weighted is measured on three seeds and reported as a range`.
- **A player whose world is not installed, or Archipelago missing**: the other players are still measured; that row shows the translated reason. → Task 7 test `a missing world only fails its own row`.
- **Cancelling "Jeu prêt" after the install step**: the world stays installed, no YAML is delivered, "Réessayer" restarts at the failed or cancelled step. → Task 12 test `cancel after install keeps the world and delivers nothing; retry resumes at the profile step`.

---

## Wave 1 — covers and estimates

### Task 1: Player name setting

**Files:**
- Modify: `src/shared/types.ts` (AppConfig), `src/main/core/config.ts`, `src/renderer/src/features/settings/DisplayPanels.tsx` (or the panel holding general preferences), `src/renderer/src/features/settings/i18n.{fr,en}.json`
- Test: `tests/unit/main/config.test.ts` (or the existing config test file), `tests/renderer/settings.test.tsx`

**Interfaces:**
- Produces: `AppConfig.playerName: string` (default `''`, trimmed, ≤ 16 characters — Archipelago's slot name limit), `AppConfig.readyDestination: 'session' | 'file' | 'studio'` (default `'session'`).

- [ ] **Step 1: Write the failing tests** — config: `defaults playerName to '' and readyDestination to 'session'`; `rejects a playerName longer than 16 characters` (setConfig throws INVALID_INPUT); renderer: `edits the player name from the settings` (type "Tristan", expect `app:setConfig` called with `{ playerName: 'Tristan' }`).
- [ ] **Step 2: Run them** — `npx vitest run --project unit tests/unit/main/config.test.ts` and `npx vitest run --project renderer tests/renderer/settings.test.tsx`; expected FAIL.
- [ ] **Step 3: Implement** the two fields in the config schema and defaults, and a "Nom du joueur / Player name" text field with help "Utilisé pour les YAML créés par l'app / Used in the YAML files the app creates".
- [ ] **Step 4: Run the tests** — expected PASS; typecheck and eslint clean.
- [ ] **Step 5: Commit** — `feat(settings): player name and last ready destination`.

### Task 2: Cover URLs in the catalog

**Files:**
- Modify: `src/main/core/worlds/catalog.ts`, `src/shared/types.ts` (CatalogEntry)
- Test: `tests/unit/worlds/catalog.test.ts` (real wiki fixtures in `tests/fixtures/catalog/`)

**Interfaces:**
- Produces: `WikiPage.cover: string | null`; `CatalogEntry.cover: string | null` (absolute https URL of the 300 px thumbnail, else the original); `SAVED_VERSION` incremented (older catalog.json dropped and refetched).

- [ ] **Step 1: Write the failing tests** — `reads the boxart thumbnail of an infobox` (a fixture page with a `media` item: `cover === 'https://static.wikitide.net/archipelagowiki/thumb/…/300px-….jpg'`, protocol-relative `//` made `https:`); `a page without media has cover null`; `index entries joined to a wiki page carry its cover, wiki entries too`; `the saved catalog of the previous version is dropped`.
- [ ] **Step 2: Run them** — `npx vitest run --project unit tests/unit/worlds/catalog.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** `infoboxCover(raw: unknown): string | null` next to `infoboxFields` (first `media` item with `isImage: true`, `source: 'boxart'` preferred; `thumbnail` else `url`; only web URLs); thread it through `parseWikiPages`, `joinCatalog`, the zod schema of the saved file.
- [ ] **Step 4: Run the tests** — expected PASS.
- [ ] **Step 5: Commit** — `feat(catalog): cover URL from the wiki infobox`.

### Task 3: Covers service, cache and `goat-cover://`

**Files:**
- Create: `src/main/core/covers/covers.ts`, `src/main/services/covers.service.ts`, `src/main/ipc/covers.ts`, `src/shared/ipc/covers.ts`
- Modify: `src/shared/ipc/index.ts`, `src/main/index.ts` (scheme registration before `app.ready`, handler after), `src/main/core/worlds/catalog.ts` (Catalog gains `lookupCover`), `src/renderer/index.html` (CSP)
- Test: `tests/unit/covers/covers.test.ts`, `tests/unit/worlds/catalog.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry.cover` (Task 2), `compactKey` and `nameKey` from `catalog.ts`.
- Produces:
  - `Catalog.lookupCover(game: string): { url: string; afterDark: boolean } | null` — exact game, else `nameKey`, else `compactKey` match.
  - `imageTypeOf(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' | null`
  - `interface Covers { urlFor(game: string): Promise<string | null>; serve(key: string): Promise<{ bytes: Buffer; mime: string } | null> }`
  - `createCovers(ctx: CoreContext, deps: { lookupCover: Catalog['lookupCover']; now?: () => number; maxCacheBytes?: number }): Covers` (`maxCacheBytes` defaults to 100 MB) — `urlFor` returns `goat-cover://<key>` once the file is in `dataRoot/covers/`, downloading it on first ask; `key` = sha256 hex of the remote URL + extension.
  - Channel `'covers:get': channel(z.strictObject({ game: nonEmpty }))<{ url: string | null }>()`.

- [ ] **Step 1: Write the failing tests** —
  - `imageTypeOf recognises PNG, JPEG, WebP and GIF signatures and nothing else` (HTML bytes → null).
  - `downloads only https URLs on static.wikitide.net and upload.wikimedia.org` (`http://`, `https://evil.example/x.png`, `https://static.wikitide.net.evil.example/x.png` → null, no request made).
  - `rejects a body over 2 MB or without an image signature` (fake http returns 2 MB + 1 bytes; returns HTML with `content-type: image/png`) → null, nothing cached.
  - `serves a cached cover without asking the network again` (second `urlFor` makes no request).
  - `evicts the least recently viewed covers above the cache limit` (deps `maxCacheBytes: 1000`, three 400-byte covers viewed in order → the first one is gone).
  - `does not serve an After Dark cover unless showAfterDark`.
  - `serve refuses keys that are not a cached file name` (`../catalog/catalog.json`, `x/..`, unknown hex → null).
  - `covers resolve a game whose name differs only in accents or punctuation` (Review Focus: `lookupCover('Pokemon Emerald')` finds the entry "Pokémon Emerald").
- [ ] **Step 2: Run them** — `npx vitest run --project unit tests/unit/covers tests/unit/worlds/catalog.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** the module with the Global Constraints values (a `p-limit(4)` queue, `ctx.http.fetchRaw` with an AbortController at 20 s, streamed size cap), `covers/index.json` `{ [key]: { url, bytes, lastViewed } }`, the service, the handler, `protocol.registerSchemesAsPrivileged([{ scheme: 'goat-cover', privileges: { standard: true, secure: true } }])` and `protocol.handle('goat-cover', …)` answering 404 for a null `serve`. CSP `img-src 'self' data: goat-cover:` — first grep that nothing else loads `https://static.wikitide.net` or `https://archipelago.miraheze.org` images (only links are expected).
- [ ] **Step 4: Run the tests** — expected PASS; `npm run build` still passes `check-preload`.
- [ ] **Step 5: Commit** — `feat(covers): cached wiki covers served through goat-cover://`.

### Task 4: `GameCover` everywhere

**Files:**
- Create: `src/renderer/src/features/worlds/GameCover.tsx`, `GameCover.css`
- Modify: `CatalogGrid.tsx`, `InstalledList.tsx`, `src/renderer/src/features/session/StepPlayers.tsx`, `StepCheck.tsx`, `src/renderer/src/features/studio/GamePicker.tsx`, wiki credits strings (About panel and catalog footer mention images)
- Test: `tests/renderer/game-cover.test.tsx`, existing `worlds.test.tsx`, `session-wizard.test.tsx`

**Interfaces:**
- Consumes: `covers:get` (Task 3).
- Produces: `GameCover({ game, size = 'sm' | 'md' | 'lg', className }: GameCoverProps): JSX.Element` — fixed 3:4 ratio, `loading="lazy"`, alt `""` (decorative, the game name is next to it), falls back to `<GameSprite name={game} />` when the url is null or the image fails (`onError`).

- [ ] **Step 1: Write the failing tests** — `shows the cover returned by covers:get`; `falls back to the sprite when covers:get answers null`; `falls back to the sprite when the image fails to load` (fire `error` on the img); `catalog cards, installed rows, session players and the Studio picker render a GameCover` (one assertion per screen in the existing test files).
- [ ] **Step 2: Run them** — `npx vitest run --project renderer tests/renderer/game-cover.test.tsx tests/renderer/worlds.test.tsx tests/renderer/session-wizard.test.tsx`; expected FAIL.
- [ ] **Step 3: Implement** with `useIpcQuery('covers:get', { game })` (staleTime Infinity) and replace the `GameSprite` uses.
- [ ] **Step 4: Run the tests** — expected PASS.
- [ ] **Step 5: Commit** — `feat(ui): game covers with the pixel sprite as fallback`.

### Task 5: Check estimates from the datapackage

**Files:**
- Create: `src/main/core/checks/datapackage.ts`, `src/main/services/checks.service.ts`, `src/main/ipc/checks.ts`, `src/shared/ipc/checks.ts`, `tests/fixtures/checks/datapackage-excerpt.json` (real answer trimmed to 3 games, `location_name_to_id` kept whole for Hollow Knight)
- Modify: `src/shared/types.ts`, `src/shared/ipc/index.ts`, `CatalogGrid.tsx`, worlds i18n
- Test: `tests/unit/checks/datapackage.test.ts`, `tests/renderer/worlds.test.tsx`

**Interfaces:**
- Produces:
  - `type ProfileId = 'discovery' | 'standard' | 'complete'`; `type ProfileCounts = Partial<Record<ProfileId, number>>`; `interface GameEstimate { max: number | null; profiles: ProfileCounts | null }`.
  - `parseDatapackage(json: unknown): Record<string, { max: number; checksum: string | null }>` (throws `HTTP_ERROR` for a wrong shape).
  - `interface CheckEstimates { maxFor(game: string): number | null; refresh(force?: boolean): Promise<void>; addFromMultidata(dp: Record<string, { max: number; checksum: string | null }>): Promise<void> }`; `createCheckEstimates(ctx: CoreContext, deps?: { now?: () => number }): CheckEstimates` — file `dataRoot/checks/datapackage.json`.
  - Channel `'checks:estimate': channel(z.strictObject({ games: z.array(nonEmpty).max(2000) }))<Record<string, GameEstimate>>()` — `profiles` is null until Task 10.

- [ ] **Step 1: Write the failing tests** — `counts the locations of each game` (`Hollow Knight` → 740 from the fixture); `refreshes at most once a week` (second refresh within 7 days makes no request; after 7 days one request with the ETag); `refuses a datapackage over 32 MB`; `keeps the previous table when the refresh fails`; `addFromMultidata adds custom games and keeps the larger table entry per checksum`; renderer: `a card shows "jusqu'à 740 checks" for Hollow Knight` and nothing when `max` is null.
- [ ] **Step 2: Run them**; expected FAIL.
- [ ] **Step 3: Implement**; the refresh runs in the background at the first `checks:estimate` of a run (never blocks the answer).
- [ ] **Step 4: Run the tests** — expected PASS. Run `npm test` and `npm run test:integration` (end of wave 1).
- [ ] **Step 5: Commit** — `feat(checks): location estimates from the datapackage`.

## Wave 2 — exact counts, balancing, profiles

### Task 6: Pickle reader and multidata summary

**Files:**
- Create: `src/main/core/checks/pickle.ts`, `src/main/core/checks/multidata.ts`, `tests/helpers/make-pickle.mjs` (+ `.d.mts`), `tests/fixtures/multidata/hk-ash-0.6.8.archipelago` (real file: Hollow Knight "Knight" + A Short Hike "Claire", seed 42, AP 0.6.8, ~15 KB). Copy it from `C:\Users\tristan\AppData\Local\Temp\claude\F--archipelagoat\ad5e3b95-def0-407c-95a4-84d4bd8b15ca\scratchpad\gen\out\x\AP_02053695854357871005.archipelago`; if that file is gone, regenerate it: copy the 0.6.8 templates `Hollow Knight.yaml` (name `Knight`) and `A Short Hike.yaml` (name `Claire`) into an empty folder and run `C:\ProgramData\Archipelago\ArchipelagoGenerate.exe --player_files_path <folder> --outputpath <out> --spoiler 1 --seed 42` with stdin closed, then take the `.archipelago` from the zip.
- Modify: `src/shared/codes.ts` (+ FR/EN for `MULTIDATA_UNREADABLE`), `tests/helpers/make-patch.mjs` (`makeSeedZip` writes a pickled multidata through `make-pickle.mjs`)
- Test: `tests/unit/checks/pickle.test.ts`, `tests/unit/checks/multidata.test.ts`

**Interfaces:**
- Produces:
  - `type PickleValue = null | boolean | number | bigint | string | Uint8Array | PickleValue[] | { tuple: PickleValue[] } | Map<PickleValue, PickleValue> | Set<PickleValue> | { global: { module: string; name: string } } | { object: { class: PickleValue; args: PickleValue; state: PickleValue } }`
  - `unpickle(bytes: Uint8Array, limits?: { maxDepth?: number }): PickleValue` — throws `MULTIDATA_UNREADABLE { reason: 'opcode' | 'truncated' | 'depth' }`.
  - `interface MultidataSummary { version: number; slots: { slot: number; name: string; game: string; checks: number }[]; datapackage: Record<string, { max: number; checksum: string | null }> }`
  - `readMultidata(bytes: Uint8Array): MultidataSummary` (reasons `version`, `size`, `shape`); `readMultidataFromZip(zipPath: string): Promise<MultidataSummary>` (the single `*.archipelago` entry).
  - Test helper `pickleMultidata(input: { slots: { name: string; game: string; checks: number }[] }): Buffer` — format byte 3 + zlib(protocol-4 pickle with `locations`, `slot_info` as `NetUtils.NetworkSlot` NEWOBJ objects, `connect_names`, `datapackage`).

- [ ] **Step 1: Write the failing tests** —
  - `reads the real AP 0.6.8 multidata` → slots `[{ slot: 1, name: 'Claire', game: 'A Short Hike', checks: 131 }, { slot: 2, name: 'Knight', game: 'Hollow Knight', checks: 203 }]` and `datapackage['Hollow Knight'].max === 740`.
  - `round-trips the test helper's multidata`.
  - `rejects an unknown format byte` (byte 4 → reason `version`); `rejects a zlib bomb` (inflate over the limit → `size`); `rejects a truncated pickle` (`truncated`); `rejects opcodes outside the list` (`INST`, `OBJ`, `PERSID`, `EXT1` → `opcode`); `never resolves a global` (`GLOBAL os system` + `REDUCE` yields a `{ object }` value and nothing runs); `rejects nesting deeper than 64` (`depth`); `rejects a pickle without locations` (`shape`).
- [ ] **Step 2: Run them** — `npx vitest run --project unit tests/unit/checks`; expected FAIL.
- [ ] **Step 3: Implement** the stack machine over the opcode list of spec §3.3 (memo as an array, MARK stack, frames ignored), then the summary (`locations` Map keyed by slot int → size; `slot_info` objects' `args.tuple[0..1]` = name, game; fallback `connect_names`).
- [ ] **Step 4: Run the tests** — expected PASS; existing generate/join tests still pass with the pickled `makeSeedZip`.
- [ ] **Step 5: Commit** — `feat(checks): data-only pickle reader for the .archipelago multidata`.

### Task 7: Exact measures

**Files:**
- Create: `src/main/core/checks/measure.ts`, `tests/integration/measure.test.ts`
- Modify: `src/main/core/ap/generate.ts` (export `runProcess`, `ProcessRun`, `romPathsOf`; add `buildMeasureArgs`; after a successful generation call the `onGenerated` hook), `src/main/services/checks.service.ts`, `src/main/services/generator.service.ts`, `src/shared/types.ts` (TaskKind `measure`), `src/shared/ipc/checks.ts`, `src/shared/codes.ts` (`MEASURE_TIMEOUT`), `src/renderer/src/lib/task-stages.ts`, i18n, `tests/fake-ap/ArchipelagoGenerate.mjs` (when `--spoiler 0` and `--skip_prog_balancing` are both present, write a zip whose multidata has one slot per YAML in `--player_files_path`, checks from `FAKE_CHECKS` JSON env `{ [game]: number }`, default 100)
- Test: `tests/unit/checks/measure.test.ts`, `tests/unit/ap/generate.test.ts`

**Interfaces:**
- Consumes: `readMultidataFromZip` (Task 6), `CheckEstimates.addFromMultidata` (Task 5), `buildSessionSettingsEntries`, `writeSessionHostYaml`, `SessionStore.loadPlayers`, `matchApError` / `extractGenerationError`.
- Produces:
  - `buildMeasureArgs(ws: { players: string; output: string }, seed: number): string[]` = `['--player_files_path', players, '--outputpath', output, '--spoiler', '0', '--seed', String(seed), '--skip_prog_balancing']`.
  - `isWeighted(doc: unknown, game: string): boolean` — `game` or any option of that game's section has more than one non-zero weight, or a `random*` value.
  - `interface PlayerMeasure { checks: number | null; range: [number, number] | null; error: AppErrorData | null }`
  - `interface SessionChecks { measuredAt: string; players: { fileId: string; docIndex: number; name: string; game: string | null; checks: number | null; range: [number, number] | null; source: 'measure' | 'generation' | 'estimate'; error: AppErrorData | null }[] }`
  - `interface Measurer { measureDoc(input: { sessionId: string | null; game: string; yamlText: string; task: TaskHandle }): Promise<PlayerMeasure>; measureSession(sessionId: string, task: TaskHandle): Promise<SessionChecks>; lastSession(sessionId: string): Promise<SessionChecks | null>; fromGeneration(sessionId: string, zipPath: string): Promise<void> }`; `createMeasurer(ctx: CoreContext, deps: { locator; settings; sessions: Pick<SessionStore, 'loadPlayers' | 'getSecrets' | 'get'>; estimates: CheckEstimates; spawn?: …; now?: () => number }): Measurer` — cache `dataRoot/checks/measures.json`, last results `dataRoot/checks/sessions/<sessionId>.json`.
  - Channels `'checks:measureSession': channel(z.strictObject({ sessionId: nonEmpty }))<TaskRef>()` (result `SessionChecks`), `'checks:lastSession': channel(z.strictObject({ sessionId: nonEmpty }))<SessionChecks | null>()`.

- [ ] **Step 1: Write the failing tests** (unit, fake spawn writing a `pickleMultidata` zip) —
  - `measures one document with --spoiler 0, seed 42 and --skip_prog_balancing in a temp dir it removes`.
  - `uses the cache for an identical YAML, world version and seed` (second call spawns nothing).
  - `a weighted YAML is measured on seeds 42, 1337 and 2026 and reported as a range`.
  - `a YAML whose game is weighted is measured on three seeds and reported as a range` (Review Focus; `game` null in the row).
  - `measures each document of a multi-document player file separately` (Review Focus).
  - `runs at most two measures at once`.
  - `a missing world only fails its own row` (Review Focus; generation error output → that row's `error.code === 'AP_WORLD_NOT_FOUND'`, others measured).
  - `a game needing a ROM at generation without one in the vault fails its row with AP_ROM_MISSING and keeps the estimate` (`source: 'estimate'`, `checks` = the datapackage max shown as "jusqu'à").
  - `times out after 2 minutes with MEASURE_TIMEOUT and kills the process`.
  - `cancelling stops the running generations and removes their folders`.
  - `fromGeneration stores the counts of the real multidata and feeds the estimates`.
  - `removes leftover measure folders at startup`.
  - generate.test: `buildMeasureArgs` exact array.
  - integration: `measures a session of two players with the fake Archipelago` (`FAKE_CHECKS={"A Short Hike":131,"Hollow Knight":203}` → 131 and 203).
- [ ] **Step 2: Run them** — `npx vitest run --project unit tests/unit/checks tests/unit/ap/generate.test.ts` and `npm run test:integration`; expected FAIL.
- [ ] **Step 3: Implement** — per document: split the file with `parsePlayerYaml`, render each doc alone (`renderPlayerYaml`), write `players/p.yaml`, write the settings file the same way `runGeneration` does (session rules and ROM paths when `sessionId`, default rules otherwise), `runProcess` with `stallMs` = 2 min and `buildMeasureArgs`, then `readMultidataFromZip`. The world version of the cache key is `installedGames().get(game)?.worldVersion ?? install.version`.
- [ ] **Step 4: Run the tests** — expected PASS.
- [ ] **Step 5: Commit** — `feat(checks): exact per-player check counts from test generations`.

### Task 8: Balancing proposals

**Files:**
- Create: `src/main/core/checks/balance.ts`
- Modify: `src/main/services/checks.service.ts`, `src/shared/ipc/checks.ts`, `src/shared/types.ts`
- Create: `src/shared/checks.ts`, `tests/fixtures/templates/A Short Hike.yaml` (copied from `C:\ProgramData\Archipelago\Players\Templates`, AP 0.6.8)
- Test: `tests/unit/checks/balance.test.ts` (schemas parsed from the real templates already in `tests/fixtures/templates/`: `Hollow Knight.yaml`, `Ocarina of Time.yaml`, `Stardew Valley.yaml`, plus `A Short Hike.yaml`)

**Interfaces:**
- Consumes: `Templates.getSchema` (`src/main/core/ap/templates.ts`), `Measurer.measureDoc` (Task 7), `parsePlayerYaml` / `renderPlayerYaml`, `SessionStore.readFile` / `replaceFile`.
- Produces:
  - `type BalanceTarget = { kind: 'median' } | { kind: 'short' } | { kind: 'long' } | { kind: 'count'; value: number }`
  - In `src/shared/checks.ts` (the Checks panel uses them too): `targetOf(counts: readonly number[], target: BalanceTarget): number` (median of counts; short ×0.6, long ×1.5, rounded); `isOffTarget(checks: number, target: number): boolean` (|checks − target| > 0.25 × target).
  - `sizeCandidates(schema: GameSchema): OptionSchema[]` (name patterns of spec §3.5, common options excluded).
  - `variantsToward(option: OptionSchema, current: unknown, direction: 'fewer' | 'more'): unknown[]`.
  - `interface OptionChange { key: string; from: unknown; to: unknown }`; `interface BalanceProposal { id: string; changes: OptionChange[]; checks: number; diff: string }`.
  - `proposeBalance(input: { schema: GameSchema; doc: EditorDoc; current: number; target: number; measure: (doc: EditorDoc) => Promise<number | null> }): Promise<BalanceProposal[]>` — ≤ 12 single variants, greedy combination ≤ 3, verified, ≤ 3 proposals sorted by distance to target; `[]` when nothing moves the count.
  - Channels `'checks:suggest': channel(z.strictObject({ sessionId: nonEmpty, fileId: nonEmpty, docIndex: z.number().int().min(0), target: BalanceTargetSchema }))<TaskRef>()` (result `BalanceProposal[]`, kept in memory 1 h), `'checks:apply': channel(z.strictObject({ sessionId: nonEmpty, fileId: nonEmpty, proposalId: nonEmpty }))<Session>()`.

- [ ] **Step 1: Write the failing tests** — `targetOf: median, short 0.6x, long 1.5x, count`; `isOffTarget at ±25 %` (100 vs 126 true, vs 125 false); `sizeCandidates of the real Hollow Knight template lists its RandomizeX toggles and leaves out the common options`; `variantsToward a toggle, a choice and a range`; `proposeBalance with a fake measurer reaches the target with at most 3 changes`; `measures at most 12 single variants`; `returns [] when no option changes the count`; `checks:apply rewrites only the changed options, keeps comments, and replaces the session file`; `an unknown or expired proposal id is NOT_FOUND`.
- [ ] **Step 2: Run them**; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** — expected PASS.
- [ ] **Step 5: Commit** — `feat(checks): balancing proposals measured option by option`.

### Task 9: Checks panel in the session check step

**Files:**
- Create: `src/renderer/src/features/session/ChecksPanel.tsx`, `ChecksPanel.css`
- Modify: `StepCheck.tsx`, `src/renderer/src/features/session/i18n.{fr,en}.json`
- Test: `tests/renderer/checks-panel.test.tsx`

**Interfaces:**
- Consumes: `checks:lastSession`, `checks:measureSession`, `checks:suggest`, `checks:apply`, `checks:estimate`, `GameCover`, task hooks of `src/renderer/src/stores/tasks.ts`.
- Produces: `ChecksPanel({ session }: { session: Session }): JSX.Element`.

- [ ] **Step 1: Write the failing tests** — `lists one row per player document with cover, name, game and the last counts`; `shows "jusqu'à N" estimates before any measure`; `Mesurer les checks starts a measure task and shows its progress`; `flags a player beyond ±25 % of the median and changes the target with the selector (court/moyen/long/nombre)`; `Proposer des réglages shows the proposals with their counts and diff`; `Appliquer calls checks:apply and refreshes the rows`; `a row in error shows the translated reason`; `a range is shown as "180–230"`.
- [ ] **Step 2: Run them** — `npx vitest run --project renderer tests/renderer/checks-panel.test.tsx`; expected FAIL.
- [ ] **Step 3: Implement** with the design system (`PixelPanel`, `Segmented`, `NeonButton`, `StatusPill`, `ProgressBar`, `Modal` for the diff).
- [ ] **Step 4: Run the tests** — expected PASS.
- [ ] **Step 5: Commit** — `feat(session): checks panel with measures and balancing`.

### Task 10: Profiles

**Files:**
- Create: `src/main/core/profiles/profiles.ts`, `src/main/services/profiles.service.ts`, `src/main/ipc/profiles.ts`, `src/shared/ipc/profiles.ts`
- Modify: `src/shared/types.ts`, `src/shared/ipc/index.ts`, `src/shared/codes.ts` (`CHECKS_NO_SCHEMA` + FR/EN), `src/main/services/checks.service.ts` (`checks:estimate` fills `profiles` from the cache), `src/main/services/worlds.service.ts` (after `confirm`, schedule `refine` of the installed game in the background)
- Test: `tests/unit/profiles/profiles.test.ts` (real templates in `tests/fixtures/templates/`)

**Interfaces:**
- Consumes: `Templates.getSchema`, `sizeCandidates` / `variantsToward` (Task 8), `Measurer.measureDoc` (Task 7), `validatePlayerDocs`, `renderPlayerYaml`, `AppConfig.playerName` (Task 1).
- Produces:
  - `interface GameProfile { id: ProfileId; changes: OptionChange[]; checks: number | null; range: [number, number] | null }`; `interface GameProfiles { game: string; profiles: GameProfile[]; measured: boolean }` (a profile equal to Standard is left out).
  - `heuristicProfiles(schema: GameSchema): GameProfiles`.
  - `interface Profiles { get(game: string): Promise<GameProfiles>; refine(game: string, task: TaskHandle): Promise<GameProfiles>; yamlFor(game: string, profile: ProfileId, playerName: string): Promise<string> }`; `createProfiles(ctx, deps: { templates: Pick<Templates, 'getSchema'>; measurer: Pick<Measurer, 'measureDoc'>; worldVersion: (game: string) => Promise<string | null> }): Profiles` — cache `dataRoot/profiles/<fileSafeName(game)>.json` keyed by game + world version + schema hash.
  - Channel `'profiles:get': channel(z.strictObject({ game: nonEmpty }))<GameProfiles>()`.

- [ ] **Step 1: Write the failing tests** (real 0.6.8 templates) — `Standard is the defaults with death_link off`; `Découverte on Hollow Knight turns size options toward fewer checks and keeps common options`; `Découverte picks the easiest recognised difficulty choice and zeroes traps` (Stardew Valley or Ocarina of Time template); `Complet turns size options toward more checks and keeps the default difficulty`; `refine keeps only changes whose measured effect goes the right way and aims at 50–60 % of Standard for Découverte` (fake measurer); `a profile equal to Standard is left out`; `a game without schema is CHECKS_NO_SCHEMA`; `yamlFor writes name, description "ArchipelaGOAT · Découverte", game and a section that validatePlayerDocs accepts`; `the cache is reused until the world version or the schema changes`; `checks:estimate returns the profile counts once refined`.
- [ ] **Step 2: Run them** — `npx vitest run --project unit tests/unit/profiles`; expected FAIL.
- [ ] **Step 3: Implement.** Empty `playerName` writes `Player{number}`.
- [ ] **Step 4: Run the tests** — expected PASS.
- [ ] **Step 5: Commit** — `feat(profiles): Découverte, Standard and Complet built from the option schema`.

### Task 11: Profiles in the Studio and on the cards

**Files:**
- Modify: `src/renderer/src/features/studio/PresetMenu.tsx` (+ CSS, i18n), the Studio screen that feeds it, `CatalogGrid.tsx`
- Test: `tests/renderer/studio.test.tsx` (or the existing Studio test file), `tests/renderer/worlds.test.tsx`

**Interfaces:**
- Consumes: `profiles:get` (Task 10), `checks:estimate` profile counts.

- [ ] **Step 1: Write the failing tests** — `the preset menu shows a "Profils ArchipelaGOAT" row above the game's presets, each with its change list as tooltip`; `choosing a profile loads its options into the draft`; `a card shows "Découverte ≈ 110 · Standard ≈ 203 · Complet ≈ 420" when counts are known and "non mesuré" otherwise`.
- [ ] **Step 2: Run them**; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** — expected PASS. Run `npm test` and `npm run test:integration` (end of wave 2).
- [ ] **Step 5: Commit** — `feat(ui): ArchipelaGOAT profiles in the Studio and on the catalog cards`.

## Wave 3 — "Jeu prêt"

### Task 12: Ready orchestration

**Files:**
- Create: `src/main/core/ready/ready.ts`, `src/main/services/ready.service.ts`, `src/main/ipc/ready.ts`, `src/shared/ipc/ready.ts`
- Modify: `src/shared/types.ts` (TaskKind `ready`), `src/shared/ipc/index.ts`, `src/renderer/src/lib/task-stages.ts`, i18n
- Test: `tests/unit/ready/ready.test.ts`

**Interfaces:**
- Consumes: `Catalog.lookup`, `WorldInstaller.prepare` / `confirm` (with its trust plan), `Templates.regenerate` / `getSchema`, `Profiles.get` / `yamlFor` (Task 10), `Measurer.measureDoc` (Task 7), `validatePlayerDocs`, `SessionStore.create` / `addText` / `list`, `assertUserPath`, `listApProcesses`.
- Produces:
  - `type ReadyDestination = { kind: 'session'; sessionId: string } | { kind: 'new-session'; name: string } | { kind: 'file'; path: string } | { kind: 'studio' }`
  - `interface ReadyPlan { planId: string; entryId: string; game: string; apInstalled: boolean; installed: boolean; updateAvailable: boolean; trust: TrustTier; needsTrustConsent: boolean; profiles: GameProfiles; sessions: { id: string; name: string }[]; notes: { romRequired: boolean; popTracker: boolean; setupUrl: string | null; apRunning: boolean } }` (`needsTrustConsent` true for `wiki-release` and `unknown`, false for `core` and `indexed-verified`).
  - `interface ReadyOutcome { game: string; profile: ProfileId; checks: number | null; text: string; delivered: { kind: 'session'; sessionId: string } | { kind: 'file'; path: string } | { kind: 'studio' }; restartNeeded: boolean }`
  - `interface Ready { prepare(entryId: string): Promise<ReadyPlan>; run(input: { planId: string; profile: ProfileId; playerName: string; destination: ReadyDestination; update: boolean; trustAccepted: boolean }, task: TaskHandle): Promise<ReadyOutcome> }` — plans in memory 1 h; a failed or cancelled run keeps its plan and the steps already done, so the same `run` resumes at the first step not done.
  - Channels `'ready:prepare': channel(z.strictObject({ entryId: nonEmpty }))<ReadyPlan>()`, `'ready:run': channel(ReadyRunSchema)<TaskRef>()` (result `ReadyOutcome`).

- [ ] **Step 1: Write the failing tests** (fakes for every dep) — `prepare reports a missing Archipelago without changing anything`; `an index world runs download, inspect, install, templates, profile, validate, deliver in order`; `a core or installed world skips the install steps; update installs the newer one`; `wiki-release and unknown worlds require trustAccepted (INVALID_INPUT otherwise); indexed-verified and core do not`; `regenerates the templates only when the game has none`; `the profile step measures once and a failed measure leaves checks null without failing`; `an invalid YAML stops at validate`; `delivers to an existing session, a new session, a file (path checked with assertUserPath) and the Studio (text only)`; `cancel after install keeps the world and delivers nothing; retry resumes at the profile step` (Review Focus); `restartNeeded is true when Archipelago programs run`.
- [ ] **Step 2: Run them** — `npx vitest run --project unit tests/unit/ready`; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** — expected PASS.
- [ ] **Step 5: Commit** — `feat(ready): one-task orchestration from catalog entry to delivered YAML`.

### Task 13: "Jeu prêt" dialog

**Files:**
- Create: `src/renderer/src/features/worlds/ReadyDialog.tsx`, `ReadyDialog.css`
- Modify: `CatalogGrid.tsx`, `InstalledList.tsx` (button "Jeu prêt"), worlds i18n
- Test: `tests/renderer/ready-dialog.test.tsx`

**Interfaces:**
- Consumes: `ready:prepare`, `ready:run`, `app:savePath` (file destination, default name `<joueur> - <jeu>.yaml`), `studio:parse` + `keepDraft(loadedDraft(keptDraft(), { kind: 'new' }, docs))` then navigate to `/studio` (Studio destination), `app:setConfig` (remember `readyDestination` and `playerName`), `GameCover`, `TrustBadge`, `PixelConfetti`.

- [ ] **Step 1: Write the failing tests** — `opens from a catalog card with cover, name, source and trust`; `an indexed-verified world shows one information line and the main button confirms`; `a wiki world shows the full warning and keeps the button disabled until the box is ticked`; `the profile segment shows each profile's checks and change list`; `the player name is prefilled from the settings`; `the destination defaults to the last one; "Nouvelle session" asks for a name`; `the file destination asks app:savePath before ready:run`; `progress shows the task stage; the end screen says "Prêt !" with actions and the À savoir notes (ROM requise, PopTracker, guide, redémarrer AP)`; `Studio destination loads the YAML in the Studio draft and navigates to /studio`; `a failure shows the translated error and Réessayer runs the same plan again`; `without Archipelago the dialog links to the install screen`.
- [ ] **Step 2: Run them**; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** — expected PASS.
- [ ] **Step 5: Commit** — `feat(ui): "Jeu prêt" dialog`.

### Task 14: End-to-end and screenshots

**Files:**
- Create: `tests/e2e/ready.spec.ts`
- Modify: `tests/e2e/helpers.ts` (seed a catalog with one core game and its cover served from a local fixture image through a fake cover host injected by env, never the network)
- Test: the spec itself

- [ ] **Step 1: Write the test** — `Jeu prêt on a core game with the fake Archipelago ends in a session with the player's YAML` (FR then EN), plus screenshots of the catalog with covers, the dialog, the end screen and the Checks panel after a fake measure, saved with the existing screenshot helper.
- [ ] **Step 2: Run it** — `npm run build && npm run test:e2e`; expected FAIL before the wiring is complete, PASS after.
- [ ] **Step 3: Fix what the run reveals** (only real defects; keep the e2e offline).
- [ ] **Step 4: Run the full gates** — `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, `npm run build`, `npm run test:e2e`; all PASS.
- [ ] **Step 5: Commit** — `test(e2e): one-click ready flow and 0.2 screenshots`.

### Task 15: Release preparation

**Files:**
- Modify: `package.json` (`version: 0.2.0`, `homepage: https://github.com/tristanbasb/archipelagoat`), `README.md` (FR + EN features: covers, checks and balancing, profiles, Jeu prêt; credits: wiki images), `docs/superpowers/specs/2026-10-16-archipelagoat-design.md` (one line in §1.4 / §9 pointing to the 0.2 spec), `src/renderer/src/features/settings/AboutPanel.tsx` (wiki credit mentions images)

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run** `npx prettier --check README.md docs package.json` and the full gates of Task 14 Step 4; all PASS.
- [ ] **Step 3: Commit** — `chore(release): 0.2.0`.

### Task 16: Real run (controller, with the user's consent)

Not a subagent task. On the user's Archipelago 0.6.8, after asking: open the catalog (covers visible, offline restart keeps them), measure a session of 4 real YAMLs (Hollow Knight, A Short Hike, Ocarina of Time, Stardew Valley), compare with the counts of a real generation of the same YAMLs (acceptance §10.3), apply one balancing proposal and re-measure, run "Jeu prêt" on a core game and on an index world into a session, generate and host locally. No upload to archipelago.gg. Write `docs/verification/<date>-0.2-real-run.md` (FR) with what was seen and any defect, fix defects in follow-up commits, then ask the user before merging, pushing, rebuilding binaries or tagging `v0.2.0`.
