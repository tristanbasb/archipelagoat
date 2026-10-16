# ArchipelaGOAT — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire ArchipelaGOAT, une app desktop Electron (Windows 10/11 + Linux) qui installe Archipelago, gère APWorlds, YAML, ROMs et BizHawk, génère et héberge des parties (local ou archipelago.gg) et fait rejoindre une partie en quelques clics, avec une interface « Arcade néon » FR/EN.

**Architecture:** Electron en trois couches. `src/main/core/` contient des services métier purs en TypeScript, testables sans Electron grâce à un `CoreContext` injecté. `src/main/ipc/` les expose via un contrat IPC typé unique (`src/shared/ipc/`), validé par zod. Le renderer React appelle uniquement `window.goat`. Les programmes Archipelago officiels sont pilotés en sous-processus, sans jamais être modifiés.

**Tech Stack:** Electron 44, electron-vite 6, Vite 8, React 19, TypeScript 6.0, Zustand 5, TanStack Query 5, i18next 26, Motion 14, zod 4, yaml 2 (YAML 1.1), yauzl/yazl, tar 7, smol-toml, tough-cookie 6, Vitest 5, Playwright 1.64, electron-builder 26.

**Spec:** [`docs/superpowers/specs/2026-10-16-archipelagoat-design.md`](../specs/2026-10-16-archipelagoat-design.md). Faits techniques : [`docs/research/archipelago-research-brief.md`](../../research/archipelago-research-brief.md) (cité « brief §x »). Les deux sont à lire avec ce plan.

---

## Global Constraints

- Versions : `electron@^44.8.0`, `electron-vite@^6.0.0`, `vite@^8.3.4`, `@vitejs/plugin-react@^6.1.2`, `react@^19.3.1`, `typescript@~6.0.3` (typescript-eslint 8.71 exige `<6.1`), `typescript-eslint@^8.71.2`, `eslint@^10`, `vitest@^5.0.5`, `@playwright/test@^1.64.1`, `electron-builder@^26.15.3`, `zod@^4.6.7`, `yaml@^2.9.1`. Outillage : Node ≥ 22.
- **Aucun module natif dans les dépendances runtime** (pas de node-gyp). Les devDependencies peuvent en avoir (ex. `sharp` pour les icônes).
- Cible Archipelago **0.6.8**, tolérant aux 0.6.x. Constantes AP exactes : spec §3 et brief §1.
- Plateformes : Windows 10/11 x64, Linux x64 (glibc ≥ 2.35).
- **Jamais** télécharger, lier ou partager de ROM/ISO/WAD. **Jamais** exécuter un APWorld depuis l'app. **Jamais** lancer AP en élevé (seul l'installateur officiel passe par UAC).
- Tout processus AP passe par `spawnAp` (Task 7) : `cwd` explicite, politique stdin explicite, env nettoyé. Fenêtre **cachée** pour les programmes console (`ArchipelagoGenerate`, `ArchipelagoServer`, `ArchipelagoLauncherDebug`), **visible** pour tous les clients (ce sont des apps GUI que l'utilisateur doit voir).
- **Rien n'est écrit dans le dossier d'AP**, sauf : le fichier de réglages effectif (Task 8), `custom_worlds/` (Task 10) et la régénération des templates par AP lui-même (Task 12).
- Le main ne produit **aucun texte destiné à l'utilisateur** : il renvoie des codes (`ErrorCode`, `IssueCode`, `DoctorCheckId`…) et le renderer les traduit. Chaque code a une entrée FR **et** EN.
- Les secrets passent par `SecretStore` (Task 2). Tout ce qui est loggé ou affiché passe par `redact` (Task 3).
- Copie UI : casse de phrase. Les MAJUSCULES arcade sont réservées aux étiquettes décoratives (`PLAYER 1`, `INSERT COIN`, `PRESS START`, `JOUER`). La mention « Compagnon non officiel pour Archipelago » apparaît dans À propos et sous le logo de l'écran de boot.
- `appId: com.archipelagoat.app`, `productName: ArchipelaGOAT`, User-Agent HTTP `ArchipelaGOAT/<version> (unofficial Archipelago companion)`.
- Variables d'environnement de test, honorées **seulement** si `!app.isPackaged || process.env.GOAT_E2E === '1'` : `GOAT_DATA_ROOT`, `GOAT_USER_DATA`, `GOAT_WEBHOST_URL`, `GOAT_FAKE_AP_DIR`, `GOAT_E2E_DIALOGS`.
- Après chaque tâche : `npm run typecheck && npm run lint && npm test` au vert, puis commit conventionnel terminé par la ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Données de référence d'AP : un clone en lecture seule du tag 0.6.8 (`git clone --depth 1 --branch 0.6.8 https://github.com/ArchipelagoMW/Archipelago.git <scratch>/ap-src`), à lire uniquement, jamais exécuté.

## Review Focus

1. **Chemins avec espaces, accents ou très longs** (ex. `C:\Users\Jérôme Dupont\OneDrive\Documents\…`) dans l'install AP, le dossier de données, les YAML. Tout spawn, toute écriture de réglages et tout zip doit fonctionner. → tests dans Tasks 7, 8 et 15.
2. **AP déjà installé et personnalisé** par l'utilisateur (son `host.yaml`/`options.yaml`, ses mondes custom, un programme AP ouvert). Rien ne doit être écrasé ni corrompu : écriture bloquée si AP tourne, sauvegarde systématique. → tests dans Tasks 8 et 9.
3. **Hors-ligne, GitHub limité (403), archipelago.gg indisponible.** L'app montre les données en cache et une erreur claire, jamais un spinner infini. → tests dans Tasks 5, 11 et 17.
4. **YAML réels de joueurs** : BOM, CRLF, tabulations, Windows-1252, multi-documents, noms exotiques ou > 16 caractères après `{number}`. On obtient des issues claires, jamais un crash. → tests dans Task 13.
5. **App fermée, plantée ou relancée** pendant une génération ou un serveur local. Pas de processus AP orphelin, sauvegarde du serveur écrite, la seconde instance transmet ses liens à la première. → tests dans Tasks 7, 16 et 21.

---

## Ordre d'exécution et parallélisme

Les tâches d'une même vague touchent des fichiers disjoints et peuvent s'exécuter en parallèle. Chaque tâche ne dépend que des **Interfaces** des tâches listées.

| Vague | Tâches | Dépend de |
|---|---|---|
| 0 | 1 | — |
| 1 | 2 | 1 |
| 2 | 3, 4, 22 | 2 |
| 3 | 5, 6, 7, 23 | 3, 4 (23 dépend de 22) |
| 4 | 8, 10 | 5, 6, 7 |
| 5 | 9, 11, 12, 18, 19 | 8, 10 |
| 6 | 13 | 12 |
| 7 | 14 | 11, 13, 18 |
| 8 | 15, 16, 17 | 14 |
| 9 | 20, 21 | 16, 17, 18, 19 |
| UI | 24 → 32 (en parallèle entre elles, dès la vague 4), **sauf 27**, qui attend la fusion de 13 (`src/shared/studio-model.ts`) | 23 (elles codent contre le contrat de la Task 2, sans attendre les services) |
| Final | 33 → 34 → 35 (séquentielles : 34 consomme le harness de 33, 35 la config Playwright de 34), puis 36 | tout |

**Câblage sans fichier partagé.** Chaque service s'enregistre dans son propre fichier `src/main/services/<nom>.service.ts`, via `defineService` + augmentation de l'interface `Services`. Ses handlers vivent dans `src/main/ipc/<domaine>.ts` (`export default register`). Les deux dossiers sont découverts par `import.meta.glob` (Task 2). Les hooks de cycle de vie (`ctx.lifecycle`) évitent de modifier `src/main/index.ts`. Résultat : deux tâches d'une même vague ne modifient jamais le même fichier.

---

## Phase A — Fondations

### Task 1: Scaffold Electron + outillage

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.gitignore`, `.editorconfig`, `vitest.config.ts`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`
- Test: `tests/unit/scaffold.test.ts`

**Interfaces:**
- Produces :
  - Alias de chemins : `@shared/*` → `src/shared/*`, `@main/*` → `src/main/*`, `@renderer/*` → `src/renderer/src/*` (dans electron-vite, vitest et les tsconfig).
  - Scripts npm : `dev`, `build`, `preview`, `typecheck`, `lint`, `format`, `test` (projets `unit` + `renderer`), `test:integration`, `test:e2e`, `dist:win`, `dist:linux`, `dist:linux:docker`, `icons`.
  - Projets Vitest : `unit` (`tests/unit/**/*.test.ts`, env node), `renderer` (`tests/renderer/**/*.test.tsx`, env jsdom), `integration` (`tests/integration/**/*.test.ts`, env node, timeout 60 s).
  - Sortie de build : `out/main/index.js`, `out/preload/index.js` (CJS, requis par `sandbox: true`), `out/renderer/index.html`.

- [ ] **Step 1: Écrire le test de scaffold**

```ts
// tests/unit/scaffold.test.ts
import pkg from '../../package.json'
it('identifies the app', () => {
  expect(pkg.name).toBe('archipelagoat')
  expect(pkg.productName).toBe('ArchipelaGOAT')
  expect(pkg.main).toBe('./out/main/index.js')
})
```

- [ ] **Step 2: Créer `package.json` et installer** les dépendances runtime (`react`, `react-dom`, `react-router-dom`, `zustand`, `@tanstack/react-query`, `i18next`, `react-i18next`, `motion`, `@fontsource/press-start-2p`, `@fontsource/jetbrains-mono`, `@tabler/icons-react`, `zod`, `yaml`, `yauzl`, `yazl`, `tar`, `smol-toml`, `tough-cookie`, `semver`, `p-limit`, `electron-updater`) et de dev (`electron`, `electron-vite`, `vite`, `@vitejs/plugin-react`, `typescript`, `@types/*`, `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `prettier`, `vitest`, `@vitest/coverage-v8`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@playwright/test`, `electron-builder`, `sharp`, `png-to-ico`). Versions : Global Constraints.
- [ ] **Step 3: Configurer** l'outillage. Prettier : `singleQuote`, `semi: false`, `printWidth: 110`.
  - **package.json sans `"type": "module"`** ; ESLint en `eslint.config.mjs` (flat config typescript-eslint recommended-type-checked + react-hooks).
  - **electron-vite** :
    - main : `build.externalizeDeps` par défaut ;
    - preload : `build: { externalizeDeps: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } } }`, car un preload sandboxé ne peut `require` que `electron` ;
    - renderer : React.
  - **tsconfig** (TypeScript 6 : `types` vaut `[]` par défaut, `baseUrl` est déprécié) :
    - `tsconfig.node.json` : `types: ["node", "electron-vite/node"]` ;
    - `tsconfig.web.json` : `types: ["vite/client"]` et libs DOM ;
    - `tsconfig.test.json` : `types: ["node", "vitest/globals"]` ;
    - partout : `strict: true`, `noUncheckedIndexedAccess: true`, `paths` **sans** `baseUrl`.
  - Les polices s'importent par leur fichier CSS (`@fontsource/press-start-2p/400.css`).
  - **Vitest** :
    - `test.globals: true` ;
    - projets et alias ci-dessus ;
    - le projet `renderer` charge `tests/renderer/setup.ts`, qui importe `@testing-library/jest-dom/vitest` (à ajouter aux devDependencies) et stubbe `matchMedia` (contrôlable), `ResizeObserver`, `AudioContext` et `HTMLCanvasElement.prototype.getContext` ;
    - couverture v8 avec **seuil 80 % sur `src/main/core/**`**, appliqué par `npm test`.
  - Script `scripts/check-preload.mjs`, lancé après `build` : échoue si `out/preload/index.js` contient un `require(` autre que `require("electron")`.
- [ ] **Step 4: Minimal app.** `src/main/index.ts` ouvre une `BrowserWindow` 1280×800 (min 1024×680), avec `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` et le preload. `App.tsx` affiche « ArchipelaGOAT ».
  - `src/renderer/index.html` porte la CSP en balise meta : `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; img-src 'self' data: https://static.wikitide.net https://archipelago.miraheze.org; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'">`.
  - Elle vaut en dev (Vite injecte le preamble React avant la meta) comme en `file://` packagé. **Pas** de CSP par `onHeadersReceived`.
- [ ] **Step 5: Vérifier** `npm run typecheck && npm run lint && npm test && npm run build`. Attendu : tout passe, et les trois fichiers `out/…` existent.
- [ ] **Step 6: Commit** `chore: scaffold electron-vite react typescript app`.

---

### Task 2: Contrat IPC, types partagés et infrastructure du main

**Files:**
- Create: `src/shared/types.ts`, `src/shared/errors.ts`, `src/shared/codes.ts`
- Create: `src/shared/ipc/contract.ts`, `src/shared/ipc/{app,tasks,ap,worlds,catalog,studio,session,server,webhost,join,vault,bizhawk,doctor,system}.ts`, `src/shared/ipc/events.ts`, `src/shared/ipc/index.ts`
- Create: `src/preload/index.ts` (remplace), `src/shared/goat-api.d.ts`
- Create: `src/main/core/context.ts`, `src/main/core/tasks.ts`, `src/main/core/events.ts`, `src/main/core/config.ts`, `src/main/core/secrets.ts`, `src/main/core/exec.ts`, `src/main/core/logger.ts`
- Create: `src/main/platform.ts`, `src/main/lifecycle.ts`, `src/main/ipc/registry.ts`, `src/main/ipc/index.ts`, `src/main/ipc/{app,tasks}.ts`
- Create: `src/main/services/registry.ts`, `src/main/services/index.ts`, `src/main/core/system/user-path.ts`, `src/shared/ipc/event-names.ts`
- Test: `tests/unit/main/services.test.ts`, `tests/unit/main/lifecycle.test.ts`, `tests/unit/main/user-path.test.ts`
- Modify: `src/main/index.ts`
- Test: `tests/unit/shared/ipc.test.ts`, `tests/unit/main/registry.test.ts`, `tests/unit/main/tasks.test.ts`, `tests/unit/main/config.test.ts`, `tests/unit/main/secrets.test.ts`

**Interfaces:**
- Produces : **tous les types, codes et canaux ci-dessous sont normatifs** ; les tâches suivantes les implémentent tels quels. Toute modification du contrat se fait dans cette tâche ou dans un commit dédié qui met à jour les deux côtés.

`src/shared/types.ts` :

```ts
export type OS = 'win32' | 'linux'
export type Lang = 'fr' | 'en'
export interface AppInfo { version: string; os: OS; locale: string; isPackaged: boolean; userData: string; dataRoot: string }
export interface AppConfig {
  language: Lang | 'auto'
  effects: { crt: boolean; glow: boolean; animations: boolean; sounds: boolean }
  showAfterDark: boolean; apPathOverride: string | null; desktopIcons: boolean
  integration: { linuxDesktop: boolean; winProtocol: boolean; winAssociations: boolean }
  allowPlaintextSecrets: boolean; firstRunDone: boolean; webhostUrl: string
}
export interface ApPaths { localPath: string; userPath: string; customWorlds: string; coreWorlds: string; players: string;
  templates: string; output: string; logs: string; cache: string; settingsFile: string }
export type ApInstallKind = 'windows-installer' | 'linux-managed' | 'linux-targz' | 'linux-appimage' | 'custom'
export interface ApInstall { kind: ApInstallKind; version: string | null; root: string; appImagePath: string | null; paths: ApPaths }
export interface ExeRef { command: string; argsPrefix: string[]; env?: Record<string, string> }
export interface ReleaseAsset { name: string; url: string; size: number; sha256: string | null }
export interface ApRelease { tag: string; version: string; publishedAt: string; notes: string;
  windows: ReleaseAsset | null; linuxTarGz: ReleaseAsset | null; appImage: ReleaseAsset | null }
export type TaskKind = 'ap-install' | 'ap-uninstall' | 'templates' | 'world-prepare' | 'generate' | 'webhost-host'
  | 'join-prepare' | 'rom-scan' | 'bizhawk-install'
export interface TaskRef { taskId: string }
export interface TaskProgress { taskId: string; kind: TaskKind; stage: string; percent: number | null; detail?: Record<string, string | number> }
export interface TaskLog { taskId: string; stream: 'stdout' | 'stderr' | 'app'; line: string }
export interface TaskDone { taskId: string; kind: TaskKind; result: unknown }
export interface TaskFailed { taskId: string; kind: TaskKind; error: AppErrorData }
export interface Issue { severity: 'error' | 'warning'; code: IssueCode; path?: string; params?: Record<string, string | number> }
export interface WorldManifest { game: string; worldVersion: string | null; minimumApVersion: string | null; maximumApVersion: string | null;
  authors: string[]; version: number | null; compatibleVersion: number | null }
export type WorldState = 'ok' | 'no-manifest' | 'incompatible' | 'corrupt' | 'shadowed' | 'core-loose' | 'disabled'
export interface WorldInfo { id: string; fileName: string; path: string; location: 'custom' | 'core' | 'disabled'; module: string;
  game: string | null; manifest: WorldManifest | null; states: WorldState[]; sizeBytes: number }
export type TrustTier = 'core' | 'indexed-verified' | 'wiki-release' | 'unknown'
export type WorldSource = { kind: 'file'; path: string } | { kind: 'url'; url: string } | { kind: 'catalog'; id: string }
export interface WorldInstallPlan { planId: string; source: WorldSource; module: string; targetFileName: string; manifest: WorldManifest | null;
  sha256: string; trust: TrustTier; homepage: string | null;
  conflicts: { worldId: string; version: string | null; winner: 'new' | 'existing' }[]; warnings: IssueCode[] }
export interface CatalogEntry { id: string; game: string; displayName: string; homepage: string | null; tags: string[]; supported: boolean;
  afterDark: boolean; requiresRomAtGeneration: boolean; hasPopTracker: boolean;
  wiki: { title: string; url: string; status: string | null; maintainer: string | null; setupUrl: string | null } | null;
  latest: { version: string; url: string; sha256: string | null } | null; installedVersion: string | null; trust: TrustTier }
export interface CatalogSnapshot { entries: CatalogEntry[]; fetchedAt: string | null; stale: boolean; errors: ErrorCode[] }
export type OptionKind = 'toggle' | 'choice' | 'text-choice' | 'range' | 'named-range' | 'list' | 'set' | 'dict' | 'free'
export interface OptionSchema { key: string; group: string; doc: string; kind: OptionKind; default: unknown; choices: string[];
  range: { min: number; max: number } | null; specialNames: Record<string, number>; confidence: 'exact' | 'inferred' }
export interface GameSchema { game: string; source: 'local' | 'site'; apVersion: string | null;
  groups: { name: string; options: OptionSchema[] }[]; presets: Record<string, Record<string, unknown>> }
export interface StudioGame { game: string; installed: boolean; schemaSource: 'local' | 'site' | 'none' }
export type OptionValue = { mode: 'value'; value: unknown } | { mode: 'weighted'; weights: Record<string, number> } | { mode: 'raw'; yaml: string }
export interface EditorDoc { name: string; description: string; game: string; requiresVersion: string | null;
  options: Record<string, OptionValue>; extraRoot: Record<string, unknown> }
export interface PlayerDoc { index: number; name: string | null; games: { game: string; weight: number }[]; issues: Issue[] }
export interface PlayerFile { id: string; originalName: string; storedName: string; docs: PlayerDoc[]; addedAt: string }
export type ReleaseMode = 'auto' | 'enabled' | 'disabled' | 'goal' | 'auto-enabled'
export interface Rules { preset: 'casual' | 'async' | 'race' | 'custom'; spoiler: 0 | 1 | 2 | 3; race: boolean; hintCost: number;
  locationCheckPoints: number; releaseMode: ReleaseMode; collectMode: ReleaseMode; remainingMode: 'enabled' | 'disabled' | 'goal';
  countdownMode: 'enabled' | 'disabled' | 'auto'; itemCheat: boolean; autoShutdown: number;
  plando: ('bosses' | 'items' | 'texts' | 'connections')[]; compatibility: 0 | 1 | 2 }
export interface Slot { slot: number; name: string; game: string; patchFile: string | null }
export interface Generation { seedName: string; zipPath: string; spoilerName: string | null; slots: Slot[]; durationS: number; logPath: string }
export type Hosting = { mode: 'local'; port: number; savefile: string } | { mode: 'web'; seedId: string; roomId: string; roomUrl: string; port: number | null }
export type SessionStatus = 'draft' | 'generated' | 'hosting' | 'finished'
export interface Session { id: string; name: string; createdAt: string; updatedAt: string; status: SessionStatus; players: PlayerFile[];
  rules: Rules; hasPassword: boolean; hasServerPassword: boolean; generation: Generation | null; hosting: Hosting | null; workspace: string }
export interface SessionSummary { id: string; name: string; status: SessionStatus; playerCount: number; updatedAt: string; hostingMode: 'local' | 'web' | null }
export interface RomNeed { game: string; settingsKey: string; status: 'ok' | 'missing' | 'bad-hash'; path: string | null; vaultPath: string | null }
// path = chemin absolu à écrire dans le host.yaml de session quand status === 'ok' (clé effective valide, sinon chemin du coffre)
export interface SessionValidation { files: { fileId: string; docs: PlayerDoc[] }[]; sessionIssues: Issue[];
  missingWorlds: { game: string; catalogId: string | null }[]; romNeeds: RomNeed[]; blocking: boolean }
export interface Address { kind: 'localhost' | 'lan' | 'public'; host: string; port: number }
export interface ServerState { sessionId: string; status: 'starting' | 'ready' | 'stopping' | 'stopped' | 'crashed'; port: number;
  addresses: Address[]; startedAt: string; resumedFromSave: boolean; error: AppErrorData | null }
export interface ServerEvent { ts: string; kind: 'join' | 'leave' | 'item' | 'goal' | 'all-goals' | 'chat' | 'output'; text: string;
  player?: string; receiver?: string; item?: string; location?: string }
export interface WebRoom { roomId: string; seedId: string; roomUrl: string; host: string; port: number | null; lastActivity: string | null;
  timeoutS: number | null; players: { name: string; game: string }[]; downloads: { slot: number; url: string }[]; trackerUrl: string | null }
export interface WebRoomRef { roomId: string; seedId: string | null; roomUrl: string; lastActivity: string | null }
export interface PatchManifest { game: string; player: number; playerName: string; server: string | null; patchFileEnding: string;
  baseChecksums: string[]; resultFileEnding: string | null; compatibleVersion: number | null; version: number | null }
export type ClientKind = 'bizhawk' | 'sni' | 'oot' | 'mmbn3' | 'tloz' | 'adventure' | 'zillion' | 'launcher' | 'text' | 'none'
export interface PatchRoute { suffix: string; client: ClientKind; exe: string | null; tier: 'full' | 'assisted' | 'guided' }
export type JoinTarget = { kind: 'room'; roomId: string }
  | { kind: 'address'; host: string; port: number; slot: string | null; password: string | null; game: string | null }
  | { kind: 'patch'; path: string }
export interface CheckItem { status: 'ok' | 'missing' | 'warning' | 'na'; code: string; params?: Record<string, string | number> }
export interface JoinPlan { planId: string; target: JoinTarget; slots: { name: string; game: string }[];
  slot: { name: string; game: string } | null; patchPath: string | null;
  manifest: PatchManifest | null; route: PatchRoute; connect: { host: string; port: number | null; slot: string | null; hasPassword: boolean };
  tutorialUrl: string | null; checklist: { ap: CheckItem; world: CheckItem; rom: CheckItem; emulator: CheckItem };
  warnings: Issue[]; ready: boolean }
export interface RomTableEntry { game: string; label: string; md5s: string[]; header: 'snes' | 'ines' | 'none'; settingsKey: string;
  requiredAtGeneration: boolean; extensions: string[] }
export interface RomRecord { path: string; size: number; mtimeMs: number; md5: string; game: string | null; label: string | null; settingsKey: string | null }
export interface VaultApplyResult { applied: { game: string; key: string; path: string }[]; skipped: { game: string; reason: ErrorCode }[] }
export interface BizhawkState { installed: boolean; managed: boolean; version: string | null; path: string | null; configuredInAp: boolean;
  prereqs: { name: string; ok: boolean; hint: string | null }[] }
export type DoctorSeverity = 'ok' | 'info' | 'warning' | 'error'
export interface DoctorCheck { id: DoctorCheckId; severity: DoctorSeverity; params: Record<string, string | number>;
  fix: { kind: 'auto' } | { kind: 'navigate'; to: string } | null }
export interface IntegrationState { linuxDesktop: boolean; winProtocol: boolean; winAssociations: boolean;
  available: { linuxDesktop: boolean; winProtocol: boolean; winAssociations: boolean } }
export interface OpenRequest { kind: 'uri' | 'file'; value: string }
export interface QuitRequest { requestId: string; runningServers: string[]; runningTasks: TaskKind[] }
export interface ServerHistory { events: ServerEvent[]; log: string[] }   // anneau des 500 derniers de chaque
```

`src/shared/codes.ts` (listes `as const` + types dérivés) :

- `ERROR_CODES` :
  - Génériques : `NOT_IMPLEMENTED INVALID_INPUT NOT_FOUND PATH_FORBIDDEN TASK_CANCELLED UNSUPPORTED_PLATFORM`.
  - AP et réglages : `AP_NOT_INSTALLED AP_RUNNING SETTINGS_LOCKED`.
  - Réseau : `NETWORK_OFFLINE GITHUB_RATE_LIMITED HTTP_ERROR`.
  - Téléchargement et installation : `DOWNLOAD_HASH_MISMATCH INSTALL_ELEVATION_DENIED INSTALL_FAILED`.
  - Mondes : `WORLD_INVALID WORLD_INCOMPATIBLE WORLD_CORRUPT_BLOCKING`.
  - YAML : `YAML_PARSE`.
  - Génération : `GENERATION_PREFLIGHT GENERATION_FAILED PROCESS_TIMEOUT`.
  - Serveur : `PORT_IN_USE SERVER_START_FAILED`.
  - archipelago.gg : `WEBHOST_UPLOAD_FAILED WEBHOST_ROOM_FAILED WEBHOST_UNAVAILABLE`.
  - Rejoindre et ROMs : `JOIN_BAD_INPUT PATCH_INVALID ROM_MISSING ROM_BAD_HASH`.
  - BizHawk et secrets : `BIZHAWK_PREREQ_MISSING SECRETS_UNAVAILABLE`.
  - Erreurs traduites d'AP : `AP_YAML_INVALID AP_WORLD_NOT_FOUND AP_NO_GAME_OPTIONS AP_QUANTITY_DISABLED AP_VERSION_REQUIRED AP_PLANDO_DISABLED AP_NAMES_NOT_UNIQUE AP_FILL_UNBEATABLE AP_FILL_NO_SPOTS AP_FILL_NOT_ENOUGH_LOCATIONS AP_FILL_FAILED AP_ROM_MISSING AP_ROM_HASH AP_MULTIDATA_INCOMPATIBLE AP_SERVER_TOO_OLD AP_NO_ARCHIPELAGO_IN_ZIP AP_PORT_IN_USE AP_UNKNOWN`.
- `ISSUE_CODES` :
  - YAML et encodage : `yaml-syntax duplicate-key encoding-fallback`.
  - Jeu : `no-game game-not-installed game-section-missing game-section-null`.
  - Nom : `name-too-long name-reserved name-numeric name-duplicate`.
  - `requires` : `requires-version-format requires-version-too-new requires-plando-disabled requires-game-version`.
  - Options : `option-unknown option-invalid-value option-float weights-all-zero quantity-disabled root-common-option plando-items-disabled`.
  - Fichiers et mondes : `not-yaml-file world-no-manifest world-version-conflict patch-server-stale`.
- `DOCTOR_CHECK_IDS` : `ap-installed ap-update settings-file worlds-corrupt worlds-no-manifest worlds-incompatible worlds-shadowed ap-processes port-38281 bizhawk disk-space programdata-acl glibc network`.
- `GENERATE_STAGE_IDS` : `init weights generating worlds creating items rules plando prefill fill balancing preoutput output output-files playthrough archive done`.
- `CHECK_CODES` (valeurs de `CheckItem.code`, traduites comme les autres) : `ap-ok ap-missing world-ok world-missing rom-ok rom-missing rom-bad-hash rom-apply-from-vault emulator-ok emulator-missing emulator-not-configured emulator-assisted na`.

`src/shared/rules.ts` (créé ici, car le renderer en a besoin pour l'assistant) : `RULE_PRESETS: Record<'casual' | 'async' | 'race', Rules>` (spec §3.13 : casual = item cheat off, hint_cost 10, release/collect auto, spoiler 3 ; async = idem + auto_shutdown 0 ; race = `race: true`, spoiler 0, compatibility 0) et `defaultRules(): Rules` (= casual). La Task 14 l'importe ; elle ne le redéfinit pas.

`src/shared/errors.ts` :
- `interface AppErrorData { code: ErrorCode; params?: Record<string, string | number>; detail?: string; logPath?: string }`.
- `class AppError extends Error` : `constructor(code, params?, opts?: { detail?; logPath?; cause? })` et `toData(): AppErrorData`. `message` = `"<code>"` suivi de `": <detail>"` si présent (les tests font `toThrow(/PATH_FORBIDDEN/)`).
- `isAppErrorData(x: unknown): x is AppErrorData`.
- `toAppErrorData(e: unknown): AppErrorData` : une erreur inconnue devient `{ code: 'AP_UNKNOWN', detail: String(e) }`.
- `class GoatError extends Error { code: ErrorCode; params?; detail?; logPath? }` : l'erreur levée côté renderer par `window.goat.invoke`.

`src/shared/ipc/contract.ts` :
- `channel<I extends z.ZodType>(input: I) => <O>() => ChannelDef<I, O>` (le type de sortie est fantôme).
- `type ChannelName`, `ChannelInput<C>` (= `z.input`), `ChannelOutput<C>`.
- `type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorData }`.

**Canaux** : un fichier par domaine, fusionnés dans `channels`. Les entrées sont des schémas zod stricts ; `void` = `z.undefined().optional()`.

| Canal | Entrée | Sortie | Implémenté par |
|---|---|---|---|
| `app:getInfo` | void | `AppInfo` | Task 2 |
| `app:getConfig` | void | `AppConfig` | Task 2 |
| `app:setConfig` | partiel profond d'`AppConfig` | `AppConfig` | Task 2 |
| `app:openPath` | `{path}` | void | Task 2 |
| `app:openExternal` | `{url}` (liste blanche) | void | Task 2 |
| `app:pickPaths` | `{mode:'file'\|'files'\|'directory', title?, filters?:{name,extensions[]}[]}` | `string[]` | Task 2 |
| `app:savePath` | `{defaultName, filters?}` | `string\|null` | Task 2 |
| `app:pendingOpenRequests` | void | `OpenRequest[]` | Task 21 (la Task 2 le laisse `NOT_IMPLEMENTED`) |
| `app:confirmQuit` | `{requestId, confirm:boolean}` | void | Task 2 |
| `app:setGithubToken` | `{token:string\|null}` | `{hasToken:boolean}` | Task 2 |
| `app:secretsStatus` | void | `{canEncrypt:boolean, hasGithubToken:boolean}` | Task 2 |
| `app:clearData` | `{targets:('downloads'\|'catalog'\|'logs')[]}` | void | Task 2 |
| `tasks:list` | void | `TaskProgress[]` | Task 2 |
| `tasks:cancel` | `{taskId}` | void | Task 2 |
| `ap:detect` | void | `ApInstall\|null` | Task 6 |
| `ap:latestRelease` | `{force?:boolean}` | `ApRelease` | Task 9 |
| `ap:install` | `{desktopIcons:boolean, customDir?:string}` | `TaskRef` → `ApInstall` | Task 9 |
| `ap:uninstall` | `{purgeUserData:boolean}` | `TaskRef` → `null` | Task 9 |
| `ap:setCustomPath` | `{path:string\|null}` | `ApInstall\|null` | Task 6 |
| `ap:processes` | void | `{pid:number,name:string}[]` | Task 7 |
| `ap:regenerateTemplates` | void | `TaskRef` → `{count:number}` | Task 12 |
| `worlds:list` | void | `WorldInfo[]` | Task 10 |
| `worlds:prepareInstall` | `{source: WorldSource}` | `TaskRef` → `WorldInstallPlan` | Task 10 |
| `worlds:confirmInstall` | `{planId}` | `{world: WorldInfo, restartNeeded: boolean}` | Task 10 |
| `worlds:setEnabled` | `{worldId, enabled:boolean}` | `WorldInfo` | Task 10 |
| `worlds:remove` | `{worldId}` | void | Task 10 |
| `catalog:list` | `{force?:boolean}` | `CatalogSnapshot` | Task 11 |
| `studio:games` | void | `StudioGame[]` | Task 12 |
| `studio:schema` | `{game}` | `GameSchema` | Task 12 |
| `studio:parse` | `{text}` | `{docs: EditorDoc[], issues: Issue[]}` | Task 13 |
| `studio:render` | `{doc: EditorDoc}` | `{text, issues: Issue[]}` | Task 13 |
| `studio:validate` | `{text, fileName?:string}` | `PlayerDoc[]` | Task 13 |
| `studio:open` | `{path?:string}` (absent : dialogue) | `{path, text}\|null` | Task 13 |
| `studio:save` | `{text, path:string\|null, suggestedName}` | `{path}\|null` | Task 13 |
| `session:list` | void | `SessionSummary[]` | Task 14 |
| `session:create` | `{name}` | `Session` | Task 14 |
| `session:get` | `{id}` | `Session` | Task 14 |
| `session:update` | `{id, name?, rules?: Rules}` | `Session` | Task 14 |
| `session:delete` | `{id}` | void | Task 14 |
| `session:addFiles` | `{id, paths:string[]}` | `{session: Session, ignored: string[]}` | Task 14 |
| `session:addText` | `{id, fileName, text}` | `Session` | Task 14 |
| `session:removeFile` | `{id, fileId}` | `Session` | Task 14 |
| `session:readFile` | `{id, fileId}` | `{text}` | Task 14 |
| `session:replaceFile` | `{id, fileId, text}` | `Session` | Task 14 |
| `session:getSecrets` | `{id}` | `{password:string\|null, serverPassword:string\|null}` | Task 14 |
| `session:setSecrets` | `{id, password?:string\|null, serverPassword?:string\|null}` | void | Task 14 |
| `session:validate` | `{id}` | `SessionValidation` | Task 14 |
| `session:generate` | `{id}` | `TaskRef` → `Generation` | Task 15 |
| `server:start` | `{sessionId}` | `ServerState` | Task 16 |
| `server:stop` | `{sessionId, force?:boolean}` | void | Task 16 |
| `server:command` | `{sessionId, command}` | void | Task 16 |
| `server:get` | `{sessionId}` | `ServerState\|null` | Task 16 |
| `server:history` | `{sessionId}` | `ServerHistory` | Task 16 |
| `webhost:host` | `{sessionId, consent: z.literal(true)}` | `TaskRef` → `WebRoom` | Task 17 |
| `webhost:room` | `{roomId}` | `WebRoom` | Task 17 |
| `webhost:wake` | `{roomId}` | `WebRoom` | Task 17 |
| `webhost:command` | `{roomId, command}` | void | Task 17 |
| `webhost:log` | `{roomId, fromByte:number}` | `{text, nextByte:number}` | Task 17 |
| `webhost:myRooms` | void | `WebRoomRef[]` | Task 17 |
| `webhost:openAsOwner` | `{roomId}` | void | Task 17 |
| `join:resolve` | `{input}` | `JoinTarget` | Task 20 |
| `join:prepare` | `{target: JoinTarget, slotName?:string}` | `TaskRef` → `JoinPlan` | Task 20 |
| `join:refresh` | `{planId}` | `JoinPlan` | Task 20 |
| `join:play` | `{planId}` | `{pid:number}` | Task 20 |
| `join:textClient` | `{host, port:number, slot, password?:string}` | `{pid:number}` | Task 20 |
| `vault:list` | void | `RomRecord[]` | Task 18 |
| `vault:scan` | `{paths:string[]}` | `TaskRef` → `RomRecord[]` | Task 18 |
| `vault:remove` | `{path}` | void | Task 18 |
| `vault:apply` | void | `VaultApplyResult` | Task 18 |
| `vault:table` | void | `RomTableEntry[]` | Task 18 |
| `bizhawk:state` | void | `BizhawkState` | Task 19 |
| `bizhawk:install` | void | `TaskRef` → `BizhawkState` | Task 19 |
| `bizhawk:setPath` | `{path:string\|null}` | `BizhawkState` | Task 19 |
| `bizhawk:configureAp` | void | `BizhawkState` | Task 19 |
| `doctor:run` | void | `DoctorCheck[]` | Task 21 |
| `doctor:fix` | `{checkId: DoctorCheckId}` | `DoctorCheck[]` | Task 21 |
| `doctor:supportBundle` | void | `{path}` | Task 21 |
| `system:integration` | void | `IntegrationState` | Task 21 |
| `system:setIntegration` | `{linuxDesktop?:boolean, winProtocol?:boolean, winAssociations?:boolean}` | `IntegrationState` | Task 21 |

**Événements** (`src/shared/ipc/events.ts`) :
- Tâches : `task:progress` `TaskProgress` · `task:log` `TaskLog` · `task:done` `TaskDone` · `task:failed` `TaskFailed`.
- Serveur local : `server:state` `ServerState` · `server:event` `{sessionId, event: ServerEvent}` · `server:log` `{sessionId, line}`.
- Divers : `app:openRequest` `OpenRequest` · `app:quitRequested` `QuitRequest` · `config:changed` `AppConfig` · `worlds:changed` `null` · `ap:installed` `ApInstall`.

**Main** :
- `src/main/core/context.ts` :
  - `interface CoreContext { platform: Platform; log: Logger; exec: ExecFn; http: Http; tasks: TaskManager; config: ConfigStore; secrets: SecretStore; bus: EventBus; lifecycle: Lifecycle; paths: AllowedPaths }`.
  - `interface Lifecycle` :
    - `onBeforeQuit(fn: () => Promise<void>, opts?: { phase: 'early' | 'late' }): void` : `before-quit` attend d'abord tous les `early` (ex. arrêt des serveurs par `/exit`), puis tous les `late` (ex. kill des processus restants), avec un timeout global de 20 s.
    - `onCloseRequested(fn: () => { servers: string[]; tasks: TaskKind[] }): void` : au clic sur fermer, si un serveur ou une tâche tourne, le main annule la fermeture et émet `app:quitRequested`. Le renderer répond par `app:confirmQuit`.
    - `onSecondInstance(fn: (argv: string[]) => void)` et `onOpenFile(fn: (path: string) => void)`.
    - `onWindowReady(fn: () => void)` : **rejoue immédiatement** si la fenêtre est déjà prête.
    - Implémenté par `src/main/lifecycle.ts`, branché une fois pour toutes dans `src/main/index.ts`.
  - `ctx.paths: AllowedPaths = { addAllowedRoots(provider: () => Promise<string[]>): void; isAllowed(p: string): Promise<boolean> }` : racines autorisées pour `app:openPath`. Par défaut : `dataRoot`, `userData`, `downloads` ; la Task 6 ajoute le dossier d'AP.
  - `assertUserPath(p, opts?: { mustExist?: boolean /* défaut true */; kind?: 'file' | 'dir'; exts?: string[]; access?: 'read' | 'write' /* défaut 'read' */ }): Promise<string>` (`src/main/core/system/user-path.ts`, créé ici) : refuse les chemins relatifs, UNC (`\\?\`, `\\.\`, `\\server`), les dossiers système (`%WINDIR%`, `/etc`, `/usr`, `/bin`, `/proc`, `/sys`), `C:\Program Files*` quand `access === 'write'`, et le dossier d'installation d'ArchipelaGOAT. Erreur `PATH_FORBIDDEN` ; chemin absent alors que `mustExist` → `NOT_FOUND`. Renvoie le chemin normalisé. **Chaque handler qui reçoit un chemin du renderer l'appelle** (Tasks 6, 10, 13, 14, 18, 19, 20).
  - `Http` est déclaré ici **exactement** comme la Task 5 l'implémente : `getJson<T>(url, opts?: { cacheKey?: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ data: T; fromCache: boolean }>`, `getText(url, opts?): Promise<{ data: string; fromCache: boolean }>`, `fetchRaw(url, init?: RequestInit & { timeoutMs?: number }): Promise<Response>`. Dans cette tâche, un stub qui lève `NOT_IMPLEMENTED`.
- `interface Platform` :
  - `os`, `appVersion`, `isPackaged`, `locale`.
  - `paths: { userData; dataRoot; temp; home; downloads; exe }`.
  - `canEncrypt()`, `encrypt(s): Buffer`, `decrypt(b): string`.
  - `openPath(p)`, `openExternal(url)`.
  - `showOpenDialog(opts): Promise<string[]>`, `showSaveDialog(opts): Promise<string|null>`.
  - `setProtocolClient(on: boolean): boolean`.
  - En mode E2E (`GOAT_E2E_DIALOGS` = chemin d'un fichier JSON contenant une file de réponses), les dialogues dépilent ce fichier au lieu d'ouvrir une fenêtre.
  - `dataRoot` : `%LOCALAPPDATA%\ArchipelaGOAT` sous Windows, `${XDG_DATA_HOME:-~/.local/share}/ArchipelaGOAT` sous Linux, surchargeable par `GOAT_DATA_ROOT`.
- `type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number | null; stdout: string; stderr: string }>`. Implémentation via `execFile`, `windowsHide`, UTF-8, sans shell.
- `createTaskManager(bus): TaskManager` :
  - `start<T>(kind, run: (t: TaskHandle) => Promise<T>): TaskRef`, `cancel(taskId)`, `list(): TaskProgress[]`.
  - `TaskHandle { id; signal: AbortSignal; progress(stage, percent?: number | null, detail?); log(stream, line) }`.
  - Publie les événements `task:*` ; une `AppError` levée devient `task:failed` avec son `toData()` ; une annulation devient `TASK_CANCELLED`.
- `createEventBus(): EventBus` : `{ emit<E>(name, payload); on<E>(name, cb): () => void }`. Le main relaie chaque événement vers toutes les fenêtres.
- `createConfigStore(file, os): ConfigStore` : `{ get(): AppConfig; update(patch: z.input<typeof AppConfigPatch>): AppConfig }`.
  - Fusion profonde, écriture atomique. Émet `config:changed`.
  - `defaultConfig(os)` exporté : language `'auto'`, effets tous `true` sauf `sounds: false`, `showAfterDark: false`, `integration: { linuxDesktop: os === 'linux', winProtocol: false, winAssociations: false }`, `webhostUrl: 'https://archipelago.gg'`.
  - zod 4 n'a plus `deepPartial` : `AppConfigPatch = z.strictObject({ language, effects: EffectsSchema.partial(), showAfterDark, desktopIcons, allowPlaintextSecrets, firstRunDone }).partial()`.
    - `apPathOverride` ne se modifie que par `ap:setCustomPath`, qui valide le chemin : sinon le renderer pourrait faire lancer des exécutables d'un dossier arbitraire.
    - `integration` ne se modifie que par `system:setIntegration`.
    - `webhostUrl` n'est pas modifiable par IPC ; `createConfigStore` l'écrase à l'exécution par `GOAT_WEBHOST_URL` quand l'env de test est autorisé (Global Constraints), sans le persister.
  - `ConfigStore` expose aussi `updateInternal(patch: Partial<AppConfig>)`, réservé au main (utilisé par les Tasks 6 et 21).
- `SecretStore` : `get` renvoie `null` si le déchiffrement est impossible (pas de keyring Linux), pour ne jamais bloquer le démarrage ; seul `set` lève `SECRETS_UNAVAILABLE`.
- `app:setGithubToken` stocke la clé `github.token` dans `SecretStore`. `app:clearData` vide `dataRoot/downloads`, `dataRoot/catalog` ou `dataRoot/logs`.
- `src/shared/ipc/event-names.ts` est la **seule** liste des noms d'événements (`EVENT_NAMES = [...] as const`) ; `events.ts` en dérive ses types de payload (`Record<EventName, …>`, vérifié par `satisfies`).
- `createSecretStore(file, platform, config): SecretStore` : `{ get(key): string | null; set(key, value: string | null): void; has(key): boolean }`. Si `!platform.canEncrypt()` et `!config.get().allowPlaintextSecrets`, lève `SECRETS_UNAVAILABLE`.
- `src/main/ipc/registry.ts` :
  - `registerHandler<C>(name: C, fn: (input: ChannelInput<C>, meta: { senderId: number }) => Promise<ChannelOutput<C>>)`.
  - `installIpc(ipcMain)` : chaque canal non enregistré répond `NOT_IMPLEMENTED`. Chaque entrée est validée par zod (`INVALID_INPUT` + chemin zod dans `detail`). Les exceptions sont enveloppées en `IpcResult`.
- `src/preload/index.ts` expose `window.goat = { invoke(channel, input), on(event, cb) → unsubscribe, os, pathForFile(file: File): string }`. `invoke` déballe `IpcResult` et lève un `GoatError`. `pathForFile` s'appuie sur `webUtils.getPathForFile`.
  - Le preload n'importe le contrat **qu'en `import type`**, plus une liste de noms d'événements sans zod (`src/shared/ipc/event-names.ts`). Ainsi aucune dépendance runtime n'y entre (cf. `scripts/check-preload.mjs`, Task 1). La validation se fait côté main.
- **Registre de services** (`src/main/services/registry.ts`) :
  - `interface Services {}` : vide ici, chaque tâche l'augmente par `declare module '@main/services/registry' { interface Services { locator: Locator } }`.
  - `defineService<K extends keyof Services>(name: K, factory: (ctx: CoreContext, get: <N extends keyof Services>(n: N) => Services[N]) => Services[K], opts?: { eager?: boolean }): void`.
  - `createServices(ctx): { get<N extends keyof Services>(n: N): Services[N]; startEager(): void }` : instanciation paresseuse, détection de cycle (`Error('service cycle: a → b → a')`). `startEager()` instancie les services `eager`, qui enregistrent ainsi leurs hooks de cycle de vie ; `src/main/index.ts` l'appelle juste après `createServices`.
  - `src/main/services/index.ts` charge `import.meta.glob('./*.service.ts', { eager: true })`.
  - Noms de services réservés : `locator`, `processes`, `settings`, `installer`, `worlds`, `catalog`, `templates`, `studio`, `sessions`, `generator`, `servers`, `webhost`, `vault`, `bizhawk`, `join`, `doctor`, `integration`, `openRequests`, `updater`.
  - Services **eager** : `processes` (Task 7), `servers` (Task 16), `openRequests` et `integration` (Task 21), `updater` (Task 35).
- **Handlers** : `src/main/ipc/index.ts` charge `import.meta.glob('./*.ts', { eager: true })`, hors `registry.ts`/`index.ts`, et appelle le `default(register, services)` de chaque module.
- `app:openPath` n'ouvre que des chemins pour lesquels `ctx.paths.isAllowed` répond vrai ; sinon `PATH_FORBIDDEN`. `app:openExternal` n'accepte que `https:` vers `archipelago.gg`, `github.com`, `archipelago.miraheze.org`, `tasvideos.org`, `discord.gg` et `learn.microsoft.com` ; sinon `PATH_FORBIDDEN`.
- `src/main/index.ts`, dans **cet ordre** :
  1. `app.setName('ArchipelaGOAT')`.
  2. Application de `GOAT_USER_DATA` / `GOAT_DATA_ROOT` via `app.setPath` (env de test seulement).
  3. `requestSingleInstanceLock()` (sinon `app.quit()`).
  4. `await app.whenReady()` : `safeStorage` n'est fiable qu'après `ready`.
  5. Création du `CoreContext`, de `createServices(ctx)`, `startEager()`, puis `installIpc`.
  6. Fenêtre : `titleBarStyle: 'hidden'` + `titleBarOverlay: { color: '#0B0B12', symbolColor: '#9D9DB0', height: 36 }` sur Windows **et** Linux, **sans** `frame: false`, donc les boutons natifs restent.
  7. Blocage de `will-navigate` et de `setWindowOpenHandler`.
  8. Handlers `uncaughtException`, `unhandledRejection` et `render-process-gone` : log masqué, puis dialogue « Redémarrer » (`app.relaunch(); app.exit()`).

- [ ] **Step 1: Tests**

```ts
// tests/unit/shared/ipc.test.ts
it('every channel has an input schema and no domain file redefines another domain channel', () => {
  // somme des clés de chaque fichier de domaine === nombre de clés de `channels` fusionné, et chaque nom commence par son domaine
})
it('rejects invalid input via schema', () => expect(channels['session:get'].input.safeParse({}).success).toBe(false))
it('webhost:host requires consent literal true', () =>
  expect(channels['webhost:host'].input.safeParse({ sessionId: 's', consent: false }).success).toBe(false))
// tests/unit/main/registry.test.ts
it('unregistered channel answers NOT_IMPLEMENTED', async () => expect(await call('vault:list')).toEqual({ ok: false, error: { code: 'NOT_IMPLEMENTED' } }))
it('invalid input answers INVALID_INPUT with zod path in detail', ...)
it('AppError thrown by handler is returned as data', ...)
// tests/unit/main/tasks.test.ts
it('emits progress then done with result', ...)
it('cancel aborts signal and emits failed TASK_CANCELLED', ...)
it('unknown thrown error becomes AP_UNKNOWN', ...)
// tests/unit/main/config.test.ts
it('deep-merges patch, persists atomically, emits config:changed', ...)
// tests/unit/main/secrets.test.ts
it('encrypts at rest (file does not contain plaintext)', ...)
it('throws SECRETS_UNAVAILABLE when encryption unavailable and plaintext not allowed', ...)
// tests/unit/main/services.test.ts
it('instantiates services lazily once and resolves dependencies via get', ...)
it('throws on dependency cycle with the cycle path', ...)
it('startEager instantiates only eager services', ...)
it('app:openPath rejects paths outside allowed roots and accepts a root added by a provider', ...)
// tests/unit/main/lifecycle.test.ts
it('runs early before-quit hooks before late ones', ...)
it('onWindowReady replays when the window is already ready', ...)
it('close request emits app:quitRequested when a server runs, and quits after app:confirmQuit', ...)
// tests/unit/main/user-path.test.ts
it('assertUserPath rejects relative, UNC, system dirs and missing files', ...)
// tests/unit/shared/rules.test.ts
it('RULE_PRESETS.race sets race true, spoiler 0, compatibility 0; defaultRules equals casual', ...)
// tests/unit/main/secrets.test.ts (suite)
it('get returns null instead of throwing when decryption is unavailable', ...)
```

- [ ] **Step 2: Lancer les tests**, vérifier qu'ils échouent (modules absents).
- [ ] **Step 3: Implémenter** les fichiers listés selon les Interfaces. Les handlers `app:*` et `tasks:*` sont implémentés ici ; tous les autres canaux restent `NOT_IMPLEMENTED`.
- [ ] **Step 4: Vérifier** `npm test` au vert et `npm run build` OK. `npm run dev` doit ouvrir la fenêtre sans erreur de console.
- [ ] **Step 5: Commit** `feat(core): ipc contract, shared types and main infrastructure`.

---

### Task 3: Utilitaires système (fichiers, archives, masquage, logs)

**Files:**
- Create: `src/main/core/system/fsx.ts`, `src/main/core/system/archive.ts`, `src/main/core/system/redact.ts`, `src/main/core/system/powershell.ts`
- Modify: `src/main/core/logger.ts` (ajout d'un sink fichier)
- Test: `tests/unit/system/fsx.test.ts`, `tests/unit/system/archive.test.ts`, `tests/unit/system/redact.test.ts`

**Interfaces:**
- Consumes : `AppError` (Task 2).
- Produces :
  - `fsx` :
    - `writeFileAtomic(path, data: string | Buffer): Promise<void>` et `pathExists(p): Promise<boolean>`.
    - `ensureDir(p)`, `isWritableDir(p): Promise<boolean>` (test d'écriture réel, pas `access`).
    - `safeJoin(base, ...parts): string` : lève `PATH_FORBIDDEN` si le résultat sort de `base`.
    - `backupFile(src, backupsRoot, label): Promise<string>` : copie dans `backupsRoot/<YYYYMMDD-HHmmss>-<label>/<basename>`.
    - `moveFile(src, destDir): Promise<string>` : gère les volumes différents, suffixe `-2`, `-3`… en cas de collision.
  - `archive` :
    - `ZipLimits { maxEntries: 20000; maxUncompressed: 512 MiB; maxRatio: 200 }` (valeurs par défaut).
    - `listZip(path, limits?): Promise<{ name; size; compressedSize; isDir }[]>` : lève `WORLD_INVALID{reason:'zip-bomb'|'traversal'|'not-zip'}` (code générique repris par Task 10).
    - `readZipText(path, entryName, maxBytes = 1 MiB): Promise<string | null>` et `readZipBytes(path, entryName, maxBytes = 1 MiB): Promise<Buffer | null>` (pour décoder soi-même l'encodage).
    - `extractZipSafe(path, destDir, opts?: { limits?: ZipLimits; filter?: (entryName: string) => boolean }): Promise<string[]>` (renvoie les chemins extraits).
    - `extractTarGzSafe(path, destDir, { stripComponents? })` : refuse les chemins absolus, les `..` et les liens symboliques sortants ; conserve le mode exécutable.
    - `sha256File(path): Promise<string>`.
  - `redact(text: string, extraSecrets?: string[]): string`, qui masque en `•••` :
    - `password: X` et `server_password: X` en YAML ;
    - `Password: X)` dans `Hosting game at` ;
    - `://user:pass@` (le mot de passe seulement) ;
    - les valeurs `'password': '…'` de la ligne `A client connection was refused due to:` ;
    - `session=…` dans les cookies ;
    - l'UUID après `/session/` ;
    - la sortie de `/options` : `Option password is set to X` et `Option server_password is set to X` (format exact de `MultiServer.py:1493-1500`) ;
    - la commande `/option password X` / `/option server_password X` tapée dans la console ;
    - les secrets littéraux passés dans `extraSecrets`.
  - `src/main/core/system/powershell.ts` (le **seul** endroit qui encode du PowerShell) : `encodePowerShell(script: string): string` (base64 UTF-16LE), `psQuote(value: string): string` (entoure de `'` en doublant `'`, `‘` et `’`), `runPowerShell(exec, script, opts?): Promise<{ code; stdout; stderr }>` (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand …`, le script commence par forcer `[Console]::OutputEncoding` en UTF-8). Utilisé par les Tasks 6, 9, 19 et 21.
  - `createFileLogger(dir): Logger` : rotation 5 fichiers × 5 Mo, chaque ligne passée par `redact`.

- [ ] **Step 1: Tests**

```ts
it('safeJoin rejects ../ escape and absolute injection', () => expect(() => safeJoin('/a', '../b')).toThrow(/PATH_FORBIDDEN/))
it('writeFileAtomic leaves no .tmp and survives path with spaces and é', ...)
it('backupFile creates timestamped folder and preserves content', ...)
it('extractTarGzSafe rejects entry ../evil', ...)   // tar.gz construit à partir d'en-têtes bruts (node-tar Header#encode) dans un flux gzip
it.skipIf(process.platform === 'win32')('extractTarGzSafe rejects symlink to /etc and keeps exec bits', ...)   // couvert par la CI ubuntu
it('extractZipSafe honours the entry filter', ...)
it('listZip flags zip bomb by ratio', ...)                               // archive construite avec yazl
it('redact masks Hosting line password', () =>
  expect(redact('Hosting game at 1.2.3.4:38281 (Password: hunter2)')).toBe('Hosting game at 1.2.3.4:38281 (Password: •••)'))
it('redact masks uri password keeping slot', () =>
  expect(redact('archipelago://Bob:s3cr3t@host:1')).toBe('archipelago://Bob:•••@host:1'))
it('redact masks refused-connection password and extra secrets', ...)
it('redact masks /options output and /option password commands', () =>
  expect(redact('Option server_password is set to adm1n')).toBe('Option server_password is set to •••'))
it('psQuote doubles straight and curly apostrophes; encodePowerShell round-trips as UTF-16LE base64', ...)
```

- [ ] **Step 2: Vérifier l'échec**, **Step 3: implémenter**, **Step 4: vérifier le succès**.
- [ ] **Step 5: Commit** `feat(core): fs, archive, redaction and file logger utilities`.

---

### Task 4: Tables de données Archipelago

**Files:**
- Create: `src/shared/data/ap-constants.ts`, `src/shared/data/patch-routes.ts`, `src/shared/data/rom-table.ts`, `src/shared/data/tutorial-links.ts`, `src/shared/data/log-patterns.ts`, `src/shared/data/error-catalog.ts`, `src/shared/data/core-worlds.ts`, `resources/core-worlds-0.6.8.json`, `scripts/gen-core-worlds.mjs`
- Create: `tests/fixtures/ap-output/generate-success.txt`, `generate-fill-error.txt`, `generate-yaml-error.txt`, `server-startup.txt`, `server-session.txt`
- Test: `tests/unit/data/*.test.ts`

**Interfaces:**
- Consumes : types et codes de la Task 2.
- Produces :
  - `ap-constants.ts` :
    - Dépôts et URLs : `AP_REPO = 'ArchipelagoMW/Archipelago'`, `IONIUM_REPO = 'ionium-ap/Archipelago-index'`, `WIKI_API = 'https://archipelago.miraheze.org/w/api.php'`, `WEBHOST_DEFAULT = 'https://archipelago.gg'`.
    - Installateur Inno : `AP_INNO_APPID = '{918BA46A-FAB8-460C-9DFF-AE691E1C865B}'`, `AP_UNINSTALL_KEY` (chemin HKLM complet avec `_is1`), `INNO_EXIT_CODES: Record<number, string>` (0-8, brief §1.2).
    - `ASSET_PATTERNS = { windows: /^Setup\.Archipelago\.(.+)\.exe$/, linuxTarGz: /^Archipelago_(.+)_linux-x86_64\.tar\.gz$/, appImage: /^Archipelago_(.+)_linux-x86_64\.AppImage$/ }`.
    - Exécutables : `AP_EXES` (noms sans extension, brief §1.5) et `apExeFileName(name, os)`.
    - `DEFAULT_PORT = 38281`.
    - BizHawk : `BIZHAWK_REPO = 'TASEmulators/BizHawk'`, `BIZHAWK_TAG = '2.11.1'`, `BIZHAWK_ASSETS = { win32: 'BizHawk-2.11.1-win-x64.zip', linux: 'BizHawk-2.11.1-linux-x64.tar.gz' }`.
    - `CORE_LOOSE_WORLDS` : **dérivé** de `resources/core-worlds-0.6.8.json` (entrées `loose: true`), jamais recopié à la main.
  - `patch-routes.ts` : `PATCH_ROUTES: PatchRoute[]` (brief §1.11 et spec §3.12) ; `routeForFile(fileName): PatchRoute | null` (insensible à la casse ; un `.zip` renvoie `null`) ; `TEXT_ROUTE: PatchRoute` (`client: 'text'`, `exe: 'ArchipelagoTextClient'`, tier `guided`).
  - `rom-table.ts` :
    - `ROM_TABLE: RomTableEntry[]`, **dérivée du code source d'AP 0.6.8** (classes de réglages `*_options` et MD5 des `worlds/*`). Elle couvre au moins les 8 mondes à ROM requise à la génération et les 9 mondes BizHawk du brief §1.11.
    - `findRomByMd5(md5): RomTableEntry | undefined`.
  - `tutorial-links.ts` : `tutorialUrl(game, base = WEBHOST_DEFAULT): string` (cas spéciaux du brief §1.11, sinon `/tutorial/<Game>/setup/en`).
  - `log-patterns.ts` :
    - Génération : `GENERATE_STAGES: { id: GenerateStageId; re: RegExp; percent: number }[]` (pourcentages croissants de 2 à 100), `FILL_STEP_RE` (groupes `done`, `total`), `FINAL_ARCHIVE_RE` (groupe `path`).
    - Serveur : `SERVER_READY_RE` (`server listening on`), `SERVER_HOSTING_RE`, `SERVER_EVENT_PATTERNS: { kind: ServerEvent['kind']; re: RegExp }[]`.
  - `error-catalog.ts` : `AP_ERRORS: { code: ErrorCode; re: RegExp; params?: (m: RegExpMatchArray) => Record<string, string> }[]` et `matchApError(text): { code; params } | null`. Chaque code `AP_*` de `ERROR_CODES` a au moins une regex.
  - `resources/core-worlds-0.6.8.json` : `{ apVersion: '0.6.8', worlds: { module: string; game: string; loose: boolean }[] }`, généré depuis `AP_SRC` par `scripts/gen-core-worlds.mjs` (lecture statique de `worlds/*/__init__.py` : attribut `game = "…"`). Sert à connaître les jeux core quand le dossier d'AP n'est pas lisible (AppImage non montée) et de garde-fou dans les tests. `coreWorldsFor(apVersion): CoreWorld[] | null` dans `src/shared/data/core-worlds.ts`.

- [ ] **Step 1: Fixtures.** Écrire les fichiers `tests/fixtures/ap-output/*.txt` à partir des lignes exactes du brief §1.6 et §1.7 (étapes de génération, FillError tronquée, erreur YAML avec caret, startup serveur avec `Hosting game at` **avant** `server listening on`, événements join/leave/item/goal).
- [ ] **Step 2: Tests**

```ts
it('routes BizHawk suffixes as full', () => expect(routeForFile('P1_Bob.apemerald')?.client).toBe('bizhawk'))
it('never routes .zip', () => expect(routeForFile('AP_123_P2_Al.zip')).toBeNull())
it('routes .aplttp to SNI assisted', ...)
it('finds Pokemon Emerald by md5', () => expect(findRomByMd5('605b89b67018abcea91e693a4dd25be3')?.settingsKey).toBe('pokemon_emerald_settings.rom_file'))
it('marks ALttP required at generation with snes header rule', ...)
it('generate stages match fixture in order with increasing percent', ...)   // lit generate-success.txt
it('FILL_STEP_RE parses "Current fill step (x) at 2000/5000 items placed."', ...)
it('server ready regex matches only the listening line', ...)
it('matchApError maps FillError text to AP_FILL_UNBEATABLE and missing world to AP_WORLD_NOT_FOUND with params.game', ...)
it('every AP_* error code has a catalog entry', ...)
it('tutorialUrl special-cases ALttP multiworld/en', ...)
it('core worlds for 0.6.8 include A Link to the Past (loose) and exclude DKC3', ...)
// Contrôle optionnel contre la source : lancé seulement si process.env.AP_SRC est défini
it.runIf(process.env.AP_SRC)('every ROM_TABLE md5 appears in AP source', ...)
```

- [ ] **Step 3: Vérifier l'échec**, **Step 4: implémenter** (en lisant `AP_SRC` pour les MD5 et les clés de réglages), **Step 5: vérifier le succès**, y compris `AP_SRC=<clone> npx vitest run tests/unit/data`.
- [ ] **Step 6: Commit** `feat(data): archipelago constants, routes, rom table, log and error catalogs`.

---

### Task 5: HTTP, téléchargements vérifiés, releases GitHub

**Files:**
- Create: `src/main/core/system/http.ts`, `src/main/core/system/downloads.ts`, `src/main/core/ap/releases.ts`
- Modify: `src/main/index.ts` (remplace le stub `Http`)
- Create: `tests/fixtures/github/release-0.6.8.json`, `tests/fixtures/github/release-rc.json`, `tests/helpers/http-server.ts`
- Test: `tests/unit/system/http.test.ts`, `tests/unit/system/downloads.test.ts`, `tests/unit/ap/releases.test.ts`

**Interfaces:**
- Consumes : `CoreContext`, `AppError`, `sha256File`, `writeFileAtomic`.
- Produces :
  - `createHttp({ userAgent, cacheDir, log, githubToken: () => string | null }): Http`, branché dans `src/main/index.ts` avec `githubToken: () => ctx.secrets.get('github.token')` :
    - `getJson<T>(url, opts?: { cacheKey?: string; headers?; timeoutMs?: number }): Promise<{ data: T; fromCache: boolean }>`.
    - `getText(url, opts?)` : même retour avec `data: string`.
    - `fetchRaw(url, init?: RequestInit & { timeoutMs?: number }): Promise<Response>` : sans cache ni suivi de redirection automatique si `redirect: 'manual'`.
    - Gère `If-None-Match` et ETag (fichier `cacheDir/http-cache.json` + corps à part) ; un 304 sert le cache.
    - Mapping d'erreurs : échec réseau → `NETWORK_OFFLINE` (et sert le cache s'il existe, avec `fromCache: true`) ; 403/429 avec `x-ratelimit-remaining: 0` → `GITHUB_RATE_LIMITED{resetAt}` ; autre statut ≥ 400 → `HTTP_ERROR{status,url}`.
    - Le jeton GitHub n'est envoyé qu'à `api.github.com`.
  - `download(http, { url, dest, sha256: string | null, expectedSize?: number, signal?: AbortSignal, onProgress?: (p: { received: number; total: number | null; bytesPerSec: number }) => void }): Promise<{ path: string; sha256: string }>`. Écrit `dest + '.part'`, vérifie, renomme. En cas d'écart de hash : supprime le fichier et lève `DOWNLOAD_HASH_MISMATCH`.
  - `parseRelease(json): ApRelease` (pure : regex d'assets, `digest` → `sha256`).
  - `fetchLatestApRelease(http, { force }): Promise<ApRelease>` (`/releases/latest`).
  - `fetchReleaseByTag(http, repo, tag): Promise<{ assets: ReleaseAsset[] }>`.

- [ ] **Step 1: Tests**, contre un serveur HTTP local (`tests/helpers/http-server.ts`) :

```ts
it('parseRelease picks the three 0.6.8 assets with sha256 from digest', () => {
  const r = parseRelease(fixture('release-0.6.8.json'))
  expect(r.version).toBe('0.6.8')
  expect(r.windows?.sha256).toBe('416e8b34348da41e8ee6b428262e3b6b09778bf07407d4cdf0aae601bdeacaee')
})
it('parseRelease ignores apk and uses tag_name not file names', ...)
it('serves cached body on 304 and on network failure', ...)
it('maps 403 with x-ratelimit-remaining 0 to GITHUB_RATE_LIMITED with resetAt', ...)
it('sends Authorization only to api.github.com', ...)
it('download verifies sha256 and renames .part', ...)
it('download deletes file and throws DOWNLOAD_HASH_MISMATCH on bad hash', ...)
it('download aborts on signal and removes .part', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès.
- [ ] **Step 5: Commit** `feat(core): http client with etag cache, verified downloads, github releases`.

---

## Phase B — Services cœur

Règle commune aux Tasks 6-21 : chaque tâche crée **son** fichier `src/main/services/<nom>.service.ts`. Ce fichier appelle `defineService('<nom>', …)` et augmente `Services`, en utilisant les noms réservés de la Task 2. Les handlers de la tâche vivent dans **ses** fichiers `src/main/ipc/*.ts`. Les dépendances entre services passent par `get('<nom>')`. Pour les tests, les services sont construits avec des dépendances injectées, sans registre.

### Task 6: Localisation d'Archipelago

**Files:**
- Create: `src/main/core/ap/locator.ts`, `src/main/core/system/registry.ts`, `src/main/ipc/ap-detect.ts`
- Test: `tests/unit/ap/locator.test.ts`, `tests/unit/system/registry.test.ts`

**Interfaces:**
- Consumes : `CoreContext` (`exec`, `platform`, `config`), `AP_UNINSTALL_KEY`, `apExeFileName`, `isWritableDir`.
- Produces :
  - `createLocator(ctx, opts?: { exeOverride?: (name: string) => ExeRef | null }): Locator` :
    - `detect(): Promise<ApInstall | null>`, mis en cache, invalidé par `invalidate()`.
    - `fromRoot(root, kind?): Promise<ApInstall>` : lève `AP_NOT_INSTALLED` si `ArchipelagoLauncher[.exe]` est absent.
    - `exe(install, name): ExeRef`.
    - `invalidate()`.
  - Fonctions pures :
    - `readManifestVersion(json: unknown): string | null` (`[0,6,8]` → `'0.6.8'`).
    - `resolveApPaths({ localPath, os, home, xdgDataHome, localWritable, cwd }, exists: (p) => boolean): ApPaths` (spec §3.1, brief §1.4).
    - `resolveSettingsFile(localPath, userPath, cwd, exists): string` (ordre exact de `settings.py:885-907`).
  - **Ordre de détection** (le chemin manuel prime toujours, car c'est un choix explicite de l'utilisateur) :
    - Windows :
      1. `config.apPathOverride` ;
      2. clé de désinstallation en vue 64 bits (`InstallLocation`) ;
      3. `HKLM\SOFTWARE\Classes\archipelago\shell\open\command`, **en ignorant** une commande qui pointe vers l'exécutable d'ArchipelaGOAT ;
      4. `C:\ProgramData\Archipelago`.
    - Linux :
      1. `config.apPathOverride` ;
      2. installation gérée `dataRoot/archipelago/Archipelago` ;
      3. AppImage la plus récente (par version dans le nom) dans `~/Applications`, `~/Downloads`, `~/.local/bin`.
  - **Registre** : `src/main/core/system/registry.ts` exporte `readRegistryValues(exec, keyPath, { view64: boolean }): Promise<Record<string, string> | null>`.
    - Implémentation : `runPowerShell` (Task 3) avec un script qui ouvre la clé via `[Microsoft.Win32.RegistryKey]::OpenBaseKey(<hive>, Registry64)` et imprime ses valeurs en JSON.
    - Raison : `reg.exe` sort en code page OEM (850 sur un Windows français) et casse les accents.
    - `parseRegQuery` n'est plus nécessaire.
  - **AppImage** : le dossier interne n'est pas lisible sans montage. `ApInstall.paths.coreWorlds` vaut alors `''`, et la liste des jeux core vient de `coreWorldsFor(version)` (Task 4).
  - **`GOAT_FAKE_AP_DIR`** (env de test, voir Global Constraints) :
    - Le service copie ce dossier dans un dossier temporaire, et `detect()` renvoie `fromRoot(tmp, 'custom')` **sans** lire le registre. `fromRoot` accepte `ArchipelagoLauncher.mjs` dans ce mode.
    - `exeOverride` mappe chaque nom vers `{ command: process.execPath, argsPrefix: ['<tmp>/<name>.mjs'], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }`.
  - `locator.service.ts` enregistre `ctx.paths.addAllowedRoots(async () => { const i = await detect(); return i ? [i.root, i.paths.userPath] : [] })`.
  - Handlers : `ap:detect`, `ap:setCustomPath` (passe par `assertUserPath(dir, { kind: 'dir' })`, valide via `fromRoot`, persiste `apPathOverride` via `config.updateInternal`).

- [ ] **Step 1: Tests**

```ts
it('readRegistryValues decodes UTF-8 JSON with accented InstallLocation', async () =>
  expect((await readRegistryValues(fakeExec(JSON_SAMPLE), KEY, { view64: true }))?.InstallLocation).toBe('D:\\Jeux\\Archipélago\\'))
it('windows order: override > uninstall key > HKCR command (ignoring ArchipelaGOAT) > ProgramData', ...)   // un test par repli
it('linux order: override > managed > newest AppImage', ...)
it('appimage version comes from file name and ~/.local/share/Archipelago/manifest.json', ...)
it('GOAT_FAKE_AP_DIR yields a custom install with .mjs launchers and ELECTRON_RUN_AS_NODE env', ...)
it('windows: userPath = localPath, customWorlds = custom_worlds', ...)
it('linux tar.gz writable: data inside install', ...)
it('linux appimage read-only: userPath ~/.local/share/Archipelago, customWorlds worlds/', ...)
it('settings resolution order: cwd options.yaml > cwd host.yaml > user options.yaml > user host.yaml', ...)  // 4 cas
it('appimage exe uses --executable=Name prefix', ...)
it('detect returns null when nothing found and uses override when set', ...)  // exec et fs injectés
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ap): detect archipelago install and resolve its paths`.

---

### Task 7: Lanceur de processus AP et faux exécutables

**Files:**
- Create: `src/main/core/ap/process.ts`, `src/main/core/ap/processes.ts`, `src/main/ipc/ap-processes.ts`
- Create: `src/main/services/processes.service.ts`, `tests/helpers/make-patch.mjs`, `tests/helpers/make-patch.d.mts`
- Create: `tests/fake-ap/ArchipelagoGenerate.mjs`, `tests/fake-ap/ArchipelagoServer.mjs`, `tests/fake-ap/ArchipelagoClient.mjs` (exposé sous les noms `ArchipelagoBizHawkClient.mjs`, `ArchipelagoSNIClient.mjs`, `ArchipelagoTextClient.mjs`, `ArchipelagoLauncher.mjs`, `ArchipelagoLauncherDebug.mjs` par des shims d'une ligne générés par `tests/fake-ap/make-shims.mjs <destDir>`)
- Test: `tests/unit/ap/process.test.ts`, `tests/unit/ap/processes.test.ts`

**Interfaces:**
- Consumes : `ExeRef`, `Logger`, `redact`.
- Produces :
  - `spawnAp(ctx, { exe: ExeRef, args: string[], cwd: string, stdin: 'ignore' | 'pipe', env?: Record<string, string>, window?: 'hidden' | 'visible', detached?: boolean, selfManaged?: boolean, sessionId?: string, onLine?: (stream: 'stdout' | 'stderr', line: string) => void }): ApProcess` :
    - `ApProcess { pid: number; write(line: string): void; exited: Promise<{ code: number | null; signal: string | null }>; kill(): void; lastLines(n: number): string[] }`.
    - Env : retire `PYTHONHOME` et `PYTHONPATH` (et `LD_LIBRARY_PATH` si `process.env.APPIMAGE` est défini), ajoute `PYTHONUNBUFFERED=1` et `PYTHONIOENCODING=utf-8`, puis fusionne `exe.env` et `env`. `shell: false`.
    - `window` : par défaut `defaultWindowFor(exeName)` = `'hidden'` pour `ArchipelagoGenerate`, `ArchipelagoServer` et `ArchipelagoLauncherDebug`, `'visible'` pour tout le reste. Se traduit par `windowsHide: window === 'hidden'`.
    - Les processus non détachés sont enregistrés dans un registre persisté dans `dataRoot/run/children.json` (`{ pid, exe, sessionId, startedAt }`). `selfManaged: true` (le serveur) les exclut de `disposeChildren` : c'est leur propriétaire qui les arrête.
    - Sous Linux, `detached: true` + `selfManaged` crée un groupe de processus ; le kill vise `-pid`.
  - `buildApEnv(base: NodeJS.ProcessEnv, isAppImage: boolean): NodeJS.ProcessEnv` (pure).
  - `class LineSplitter { push(chunk: Buffer | string): string[]; flush(): string[] }` : gère CRLF, les lignes partielles et l'UTF-8 coupé entre deux chunks.
  - `listChildren(): { pid; command }[]` et `disposeChildren(timeoutMs): Promise<void>` (kill de ce qui reste, hors `selfManaged`).
  - `findOrphans(ctx): Promise<{ pid; exe; sessionId: string | null }[]>` : relit `<ctx.platform.paths.dataRoot>/run/children.json` au démarrage, vérifie que chaque PID vit encore **et** est toujours un `Archipelago*` (`tasklist /FI "PID eq n"` / `/proc/<pid>/cmdline`), puis purge les autres. `killOrphan(pid)`.
  - `processes.service.ts` (**eager**) :
    - enregistre `ctx.lifecycle.onBeforeQuit(() => disposeChildren(5000), { phase: 'late' })` ;
    - au démarrage, tue (avec un log) les orphelins **non serveur** (`exe !== 'ArchipelagoServer'`, ex. une génération interrompue par un crash) ; les serveurs orphelins sont laissés à la Task 16, qui propose de les arrêter.
  - `tests/helpers/make-patch.mjs` (+ `make-patch.d.mts` pour les tests TS) : **le seul** constructeur de patch/zip de test, `makePatchZip(dest, manifest, extraEntries?)` et `makeSeedZip(dest, { seed, slots })`. Utilisé par le faux Generate et par la Task 20.
  - Les faux exécutables restent dans `tests/fake-ap/` ; toute copie ailleurs (env `GOAT_FAKE_AP_DIR`, `createFakeApInstall`) est un **shim** d'une ligne, `import 'file:///<chemin absolu du script réel>'`, ce qui garde la résolution des imports (`yazl`, fixtures) depuis le dépôt. Le chemin des fixtures est calculé depuis `import.meta.url` du script réel.
  - `listApProcesses(exec, os): Promise<{ pid: number; name: string }[]>` : `tasklist /FO CSV /NH` sous Windows, `ps -eo pid=,comm=` sous Linux ; filtre `^Archipelago`.
  - Handler `ap:processes`.
- Comportement des faux exécutables (piloté par l'env `FAKE_MODE`, et `FAKE_RECORD` pour écrire `argv`/`cwd` dans un fichier JSON) :
  - **Generate** :
    - `success` : imprime les lignes de `generate-success.txt` puis écrit un vrai zip `AP_<seed>.zip` (via `yazl`) dans `--outputpath`. Le zip contient `AP_<seed>.archipelago`, `AP_<seed>_Spoiler.txt` et un patch `AP_<seed>_P1_<name>.apemerald` dont le manifeste est valide.
    - `fail` : erreur sur stderr, puis lecture de stdin. Si EOF : exit 1. Si stdin reste ouvert : bloque indéfiniment, comme AP.
    - `slow` : ajoute des délais entre les lignes.
  - **Tous les modes** : `FAKE_MODE=buffered` retient toute la sortie jusqu'à la sortie du processus (ou jusqu'à `/save`), comme un stdout Python bufferisé.
  - **Server** :
    - Imprime `Hosting game at …`, puis `server listening on …` 300 ms plus tard. Écoute réellement le port TCP de `--port`, **sur 127.0.0.1** (pas d'invite du pare-feu Windows). Écrit son `cwd` dans `FAKE_RECORD`.
    - Lit stdin : `/exit` écrit le fichier `--savefile` puis exit 0 ; un EOF est ignoré (boucle).
    - `FAKE_MODE=port-busy` : OSError puis exit 1. `FAKE_MODE=ignore-exit` : ignore aussi `/exit`.
    - Une commande `/players` produit une ligne de sortie.
  - **Client** : enregistre `argv` et sort 0.

- [ ] **Step 1: Tests**

```ts
it('LineSplitter joins partial lines and handles CRLF and split UTF-8', ...)
it('buildApEnv strips PYTHONHOME/PYTHONPATH and sets PYTHONUNBUFFERED', ...)
it('generate fail mode exits (does not hang) with stdin ignore', async () => { /* attend exited < 5 s */ })
it('spawns with cwd and args containing spaces and accents', async () => { /* path.join(os.tmpdir(), 'Jérôme Dupont', 'ws') ; vérifie FAKE_RECORD */ })
it('a shim copied outside the repo runs the real fake script', ...)
it('disposeChildren kills remaining children but not selfManaged ones', ...)
it('defaultWindowFor hides Generate/Server/LauncherDebug and shows clients', ...)
it('merges ExeRef.env (ELECTRON_RUN_AS_NODE) into the child env', ...)
it('findOrphans keeps live Archipelago pids and purges dead or reused ones', ...)
it('parses tasklist CSV and ps output', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ap): process runner and fake archipelago executables for tests`.

---

### Task 8: Réglages d'Archipelago (host.yaml)

**Files:**
- Create: `src/main/core/ap/settings.ts`
- Test: `tests/unit/ap/settings.test.ts`

**Interfaces:**
- Consumes : `Locator`, `listApProcesses`, `writeFileAtomic`, `backupFile`, `CoreContext`.
- Produces :
  - `createApSettings(ctx, locator): ApSettings` :
    - `file(): Promise<string>` : le fichier effectif selon `resolveSettingsFile` (cwd = dossier de l'install).
    - `get(path: string[]): Promise<unknown>`.
    - `set(entries: { path: string[]; value: unknown }[]): Promise<void>` :
      1. Lève `SETTINGS_LOCKED{processes}` si un processus AP tourne.
      2. Sauvegarde dans `dataRoot/backups/`.
      3. `parseDocument(text, { version: '1.1' })` puis `setIn` sur chaque entrée.
      4. Écriture atomique `toString({ lineWidth: 0 })`.
      5. Si le fichier n'existe pas : crée `host.yaml` (**jamais** `options.yaml`).
    - `makeSessionSettings(sessionDir, entries): Promise<string>` : copie le fichier effectif (ou un document vide) vers `sessionDir/host.yaml` et applique les entrées. Pas de verrou, car le fichier appartient à la session.
  - Constante `SETTINGS_KEYS` : `emuhawkPath = ['bizhawkclient_options','emuhawk_path']`, `romStart = ['bizhawkclient_options','rom_start']`, et `romFile(key: string)`, qui éclate `'lttp_options.rom_file'` en chemin.

- [ ] **Step 1: Tests**

```ts
it('set preserves comments, order and unrelated keys', ...)
it('set throws SETTINGS_LOCKED when an Archipelago process runs', ...)          // listApProcesses injecté
it('set backs up the file before writing', ...)
it('effective options.yaml is edited, and host.yaml is never created beside it', ...)
it('creates host.yaml (not options.yaml) when no settings file exists', ...)
it('makeSessionSettings copies effective file and overrides generator and server_options', ...)
it('writes absolute paths with spaces and accents unquoted-safe and rereads identically', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ap): safe host.yaml reader and writer with session copies`.

---

### Task 9: Installation et mise à jour d'AP (Windows + Linux)

**Files:**
- Create: `src/main/core/ap/installer-win.ts`, `src/main/core/ap/installer-linux.ts`, `src/main/core/ap/install-service.ts`, `src/main/ipc/ap-install.ts`
- Test: `tests/unit/ap/installer-win.test.ts`, `tests/unit/ap/installer-linux.test.ts`, `tests/unit/ap/install-service.test.ts`

**Interfaces:**
- Consumes : `fetchLatestApRelease`, `download`, `extractTarGzSafe`, `backupFile`, `listApProcesses`, `Locator`, `scanWorlds` (Task 10 ; tant qu'elle n'existe pas, la quarantaine reçoit une fonction injectée), `TaskManager`.
- Produces :
  - Windows, fonctions pures :
    - `buildInnoArgs({ desktopIcons, customDir, logPath }): string[]`. Attendu exact sans `customDir` : `['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/CLOSEAPPLICATIONS','/TASKS="desktopicon,deletelib"','/LOG="<logPath>"']` ; avec `desktopIcons:false` : `/TASKS="!desktopicon,deletelib"`.
    - `buildElevatedScript(exePath, args): string`, exécuté par `runPowerShell` (Task 3, qui fournit aussi `psQuote`). Le script :
      ```powershell
      $psi = New-Object Diagnostics.ProcessStartInfo
      $psi.FileName = '<exe>'; $psi.Arguments = '<args joints>'; $psi.Verb = 'runas'; $psi.UseShellExecute = $true
      try { $p = [Diagnostics.Process]::Start($psi); $p.WaitForExit(); exit $p.ExitCode }
      catch [ComponentModel.Win32Exception] { exit $_.Exception.NativeErrorCode }
      ```
      Les valeurs passent par `psQuote` (doublement de `'`, `‘` et `’`).
    - `customDir` passe par `assertUserPath(dir, { mustExist: false, kind: 'dir', access: 'write' })`.
    - Le service s'enregistre sous le nom `installer`.
    - `interpretInstallResult(exitCode: number): AppErrorData | null` : uniquement par code (les messages sont localisés, ex. Windows FR) ; 0 → null ; 1223 → `INSTALL_ELEVATION_DENIED` ; 1-8 → `INSTALL_FAILED{exitCode, reason: INNO_EXIT_CODES[code]}` ; autre → `INSTALL_FAILED{exitCode}`.
  - Windows : `uninstallWindows(ctx, install, { purgeUserData })` lance `unins000.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` **via le même wrapper élevé** (AP est installé en admin).
  - Après une installation réussie (Windows ou Linux), le service émet `ap:installed` avec l'`ApInstall`.
  - Linux :
    - `installLinux(ctx, { release, targetRoot = dataRoot/archipelago }, task): Promise<ApInstall>`.
    - `applyLinuxUpdate(stagingRoot, targetRoot): Promise<void>` (supprime `lib/` et les fichiers racine `Archipelago*`, copie le reste ; préserve `Players/`, `output/`, `custom_worlds/`, `host.yaml`, `options.yaml`, `logs/`).
    - `checkGlibc(exec): Promise<{ version: string | null; ok: boolean }>` (≥ 2.35).
  - Service :
    - `createInstallService(ctx, deps)` : `{ latest(force); install({ desktopIcons, customDir }): TaskRef; uninstall({ purgeUserData }): TaskRef }`.
    - Étapes de tâche (codes de `stage`) : `download`, `verify`, `backup`, `quarantine`, `install`, `detect`.
    - Après succès : `locator.invalidate()`, puis événement `worlds:changed`.
  - Handlers : `ap:latestRelease`, `ap:install`, `ap:uninstall`.

- [ ] **Step 1: Tests**

```ts
it('buildInnoArgs passes tasks explicitly', () =>
  expect(buildInnoArgs({ desktopIcons: true, customDir: null, logPath: 'C:\\l.txt' })).toEqual(
    ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/CLOSEAPPLICATIONS', '/TASKS="desktopicon,deletelib"', '/LOG="C:\\l.txt"']))
it('buildInnoArgs deselects desktop icons and adds DIR', ...)   // '/TASKS="!desktopicon,deletelib"', '/DIR="D:\\Jeux\\Archipelago"'
it('elevated script quotes \' ‘ ’ and keeps spaces and accents', () => { /* chemin "C:\\Users\\O'Neil Jérôme\\Setup.exe" */ })
it('maps exit 1223 to INSTALL_ELEVATION_DENIED and 4 to INSTALL_FAILED with reason', ...)
it('linux update preserves Players, custom_worlds and host.yaml and replaces lib', ...)
it('linux install end-to-end from local tar.gz with sha256', ...)        // tar.gz construit dans le test, servi en local
it('install refuses with AP_RUNNING when Archipelago processes run', ...)
it('install backs up settings and quarantines corrupt apworlds before running setup', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ap): silent windows installer and managed linux install`.

---

### Task 10: APWorlds — inspection, inventaire, installation

**Files:**
- Create: `src/main/core/worlds/apworld.ts`, `src/main/core/worlds/inventory.ts`, `src/main/core/worlds/install.ts`, `src/main/ipc/worlds.ts`
- Create: `tests/helpers/make-apworld.ts` (fabrique des `.apworld` via yazl)
- Test: `tests/unit/worlds/apworld.test.ts`, `tests/unit/worlds/inventory.test.ts`, `tests/unit/worlds/install.test.ts`

**Interfaces:**
- Consumes : `listZip`, `readZipText`, `sha256File`, `download`, `moveFile`, `backupFile`, `Locator`, `coreWorldsFor` (Task 4 : noms des jeux des mondes `loose` et liste des jeux core quand `paths.coreWorlds === ''`), `CatalogEntry` (via une fonction `lookupCatalog(id)` injectée, fournie par Task 11 ; elle renvoie null tant que Task 11 n'existe pas).
- Crée `src/main/services/worlds.service.ts` (modifié ensuite par la Task 11).
- Produces :
  - `inspectApworld(path): Promise<ApworldInspection>`, avec `ApworldInspection = { module: string; hasInit: boolean; manifest: WorldManifest | null; manifestError: string | null; sha256: string; sizeBytes: number }`. Lève `WORLD_INVALID{reason}`, où `reason ∈ 'not-zip' | 'zip-bomb' | 'traversal' | 'multiple-roots' | 'no-init' | 'name-mismatch'`.
  - `scanWorlds(paths: ApPaths, disabledDir: string, apVersion: string | null): Promise<WorldInfo[]>`, avec `id` = sha1 du chemin absolu.
  - `computeStates(worlds, apVersion): WorldInfo[]` (pure). Règles :
    - `corrupt` si le zip est illisible ;
    - `no-manifest` ;
    - `incompatible` si la version est hors `[min, max]` ;
    - `shadowed` pour toute version inférieure d'un jeu déjà fourni, ou pour tout jeu déjà fourni par un monde `core-loose` ;
    - `disabled` pour un fichier situé dans `disabledDir`.
  - `createWorldInstaller(ctx, deps)` :
    - `prepare(source, task): Promise<WorldInstallPlan>`. Un `file` passe par `assertUserPath(p, { kind: 'file', exts: ['.apworld'] })`. Télécharge si `url`/`catalog`, vérifie le sha256 du catalogue, inspecte. `targetFileName = module + '.apworld'`, sans changer la casse.
      - Rejets (validations qu'AP ne fait pas) : `WORLD_INCOMPATIBLE{reason:'compatible-version', value}` si `compatibleVersion > 7` ; `WORLD_INCOMPATIBLE{reason:'ap-version', min, max, installed}` si la version d'AP installée est hors `[min, max]`.
      - Calcule `conflicts` et `trust` ; `warnings` contient `world-no-manifest` et/ou `world-version-conflict`.
    - `confirm(planId): Promise<{ world: WorldInfo; restartNeeded: boolean }>` : sauvegarde un éventuel fichier existant, copie atomique dans `customWorlds`, émet `worlds:changed`. `restartNeeded` vaut `listApProcesses().length > 0`. Les plans expirent au bout d'1 h (`NOT_FOUND`).
    - `setEnabled(worldId, enabled)` : déplace entre `customWorlds` et `dataRoot/disabled-worlds`.
    - `remove(worldId)` : déplace vers `backups`. Un monde `core` lève `PATH_FORBIDDEN`.
  - Handlers : `worlds:*`.

- [ ] **Step 1: Tests**

```ts
it('reads manifest at root or inside module folder', ...)
it('rejects traversal entry and zip bomb', ...)
it('renames versioned asset foo-v1.2.apworld with root foo/ to foo.apworld', ...)
it('keeps module case LostKingdoms2', ...)
it('marks lower world_version of same game as shadowed', ...)
it('marks custom world shadowed by a core-loose world (e.g. game "A Link to the Past")', ...)
it('marks incompatible when installed AP is outside min/max', ...)
it('marks no-manifest and corrupt', ...)
it('confirm backs up existing file then installs atomically', ...)
it('prepare rejects compatible_version 8 and AP outside min/max with WORLD_INCOMPATIBLE', ...)
it('confirm reports restartNeeded when an Archipelago process runs', ...)
it('setEnabled moves to and from disabled dir; remove refuses core', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(worlds): static apworld inspection, inventory and verified install`.

---

### Task 11: Catalogue d'APWorlds (index ionium + wiki)

**Files:**
- Create: `src/main/core/worlds/catalog.ts`, `src/main/ipc/catalog.ts`
- Modify: `src/main/services/worlds.service.ts` (injecte `lookupCatalog: (id) => get('catalog').lookup(id)` ; aucune autre tâche de la vague 5 ne touche ce fichier)
- Create: `resources/catalog-optout.json` (`{ "games": [], "repos": [] }`)
- Create: `tests/fixtures/catalog/tree.json`, `tests/fixtures/catalog/index.toml`, `tests/fixtures/catalog/index.lock`, `tests/fixtures/catalog/worlds/*.toml` (≥ 4, **récupérés réellement** via GET sur `raw.githubusercontent.com/ionium-ap/Archipelago-index/main/...` puis réduits), `tests/fixtures/catalog/wiki-page1.json`, `wiki-afterdark.json` (GET réels, réduits)
- Test: `tests/unit/worlds/catalog.test.ts`

**Interfaces:**
- Consumes : `Http`, `scanWorlds` (pour `installedVersion`), `ConfigStore` (`showAfterDark`), `p-limit`.
- Produces :
  - Fonctions pures :
    - `parseIoniumToml(text, fileStem): IoniumWorld | null`.
    - `parseIoniumLock(text): Map<string, string>` (clé `"<id>@<version>"` → sha256).
    - `resolveIoniumRelease(world, apVersion, lock): { version; url; sha256 } | null` (respecte `default_version`, `[releases]` min/max, `{{version}}`, `[base."<req>"]`).
    - `parseWikiPages(json): WikiPage[]` (`pageprops.infoboxes` est une chaîne JSON).
    - `joinCatalog(ionium, wiki, installed, { showAfterDark, afterDarkTitles }): CatalogEntry[]` (jointure par nom de jeu, puis par `owner/repo`).
  - `createCatalog(ctx, deps)` : `{ snapshot(force: boolean): Promise<CatalogSnapshot>; lookup(id): CatalogEntry | null; lookupByGame(game): CatalogEntry | null }` (les deux `lookup*` lisent le dernier instantané, sans réseau).
    - Liste d'opt-out des mainteneurs : `resources/catalog-optout.json` (`{ "games": string[], "repos": string[] }`, vide au départ). Ces entrées sont exclues du catalogue.
    - Récupère l'arbre (1 appel API), puis les TOML modifiés uniquement, avec un cache par sha de blob (`dataRoot/catalog/blobs/<sha>.toml`) et une concurrence de 8 sur `raw.githubusercontent.com`.
    - Wiki : générateur `categorymembers` (`Category:Implementations`) + `pageprops`, boucle `gcmcontinue` ; liste `Category:After Dark implementations`.
    - Instantané persisté ; hors-ligne ou limité → `stale: true` et `errors` renseigné.
  - Handler : `catalog:list`.

- [ ] **Step 1: Tests**

```ts
it('parses ionium toml keys (name, display_name, home, tags, versions, releases)', ...)
it('resolves latest supported release for AP 0.6.8 with lock sha256 and url template', ...)
it('parses wiki infobox JSON string fields', ...)
it('joins ionium and wiki by game then repo and sets trust indexed-verified when sha present', ...)
it('hides after dark entries unless showAfterDark', ...)
it('excludes games and repos listed in catalog-optout.json', ...)
it('lookupByGame finds entry by exact manifest game name', ...)
it('worlds prepare with a catalog source resolves the entry url and sha256', ...)
it('returns stale snapshot from disk when offline or rate limited', ...)
it('fetches only changed blobs on second refresh', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(worlds): apworld catalog from ionium index and wiki`.

---

### Task 12: Templates et schéma d'options

**Files:**
- Create: `src/main/core/yaml/template-parser.ts`, `src/main/core/ap/templates.ts`, `src/main/ipc/studio-schema.ts`
- Create: `tests/fixtures/templates/*.yaml` : **au moins 10 templates réels** récupérés via GET sur `https://archipelago.gg/static/generated/configs/<nom>.yaml`, dont A Link to the Past, Ocarina of Time, Pokemon Emerald, Hollow Knight, Stardew Valley, Timespinner, Super Mario 64, Factorio, The Witness, Kingdom Hearts 2, Clique. Plus `tests/fixtures/templates/presets-*.json` (2 réponses réelles de `/games/<jeu>/option-presets`).
- Test: `tests/unit/yaml/template-parser.test.ts`, `tests/unit/ap/templates.test.ts`

**Interfaces:**
- Consumes : `Http`, `Locator`, `spawnAp`, `scanWorlds` (refuse la régénération si un monde est `corrupt` : `WORLD_CORRUPT_BLOCKING`), `TaskManager`.
- Produces :
  - `parseTemplate(text: string): GameSchema`, à partir du format de `data/options.yaml` d'AP :
    - section de jeu à 2 espaces, bannières `##…##` / `# Group #` ;
    - lignes de doc `# ` sous la clé ;
    - `# Minimum value is N` / `# Maximum value is M` ;
    - notes `# equivalent to N` ;
    - poids 50 sur la valeur par défaut.
    - Règles d'inférence du `kind` :
      - `toggle` : clés ⊆ {true, false} ;
      - `range` : min/max présents ; `named-range` s'il y a des notes `equivalent` ;
      - `choice` : autres clés scalaires ;
      - `list`/`set` : séquence en flux (`['a','b']`) ;
      - `dict` : mapping par défaut ;
      - `text-choice` : chaîne pondérée hors choix ;
      - `free` : sinon.
    - Toute inférence → `confidence: 'inferred'`, sauf `range` et `toggle` → `'exact'`.
  - `fileSafeName(game): string` : réplique `Utils.get_file_safe_name` d'AP (à vérifier dans `AP_SRC`).
  - `createTemplates(ctx, deps): Templates` :
    - `listGames(): Promise<StudioGame[]>` (mondes installés ∪ templates locaux).
    - `getSchema(game): Promise<GameSchema>` : local `Players/Templates/<safe>.yaml`, sinon site (avec cache), sinon `NOT_FOUND`. Les presets viennent du local `Templates/Presets/<game> - <preset>.yaml` ou du site `/games/<game>/option-presets`.
    - `regenerate(task): Promise<{ count }>` : `ArchipelagoLauncherDebug` (Windows) / `ArchipelagoLauncher` avec `['Generate Template Options', '--', '--skip_open_folder']`, `stdin: 'ignore'`, `cwd = userPath`, timeout 5 min.
  - Handlers : `studio:games`, `studio:schema`, `ap:regenerateTemplates`.

- [ ] **Step 1: Tests**

```ts
it.each(FIXTURES)('parses %s: game name, ≥1 group, every option has key/kind/default', ...)
it('ALttP progression_balancing is named-range 0..99 default 50 with special names', ...)
it('a toggle option parses as toggle with boolean default', ...)
it('a choice option lists all choices and default has weight 50', ...)
it('groups keep template order with "Game Options" first when present', ...)
it('docs are joined without leading "# "', ...)
it('getSchema falls back to site template when local missing and caches it', ...)
it('regenerate refuses when a corrupt apworld exists', ...)
it('fileSafeName strips <>:"/\\|?*', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(yaml): template parser and option schema provider`.

---

### Task 13: Validation et écriture YAML

**Files:**
- Create: `src/main/core/yaml/load.ts`, `src/main/core/yaml/validate.ts`, `src/main/core/yaml/writer.ts`, `src/shared/studio-model.ts`, `src/main/ipc/studio.ts`
- Create: `tests/fixtures/yamls/` (valides, invalides, BOM+CRLF, Windows-1252, multi-documents, tabulations)
- Test: `tests/unit/yaml/load.test.ts`, `tests/unit/yaml/validate.test.ts`, `tests/unit/yaml/writer.test.ts`

**Interfaces:**
- Consumes : `GameSchema` (Task 12, via la fonction injectée `schemaFor(game)`), `scanWorlds`, `ISSUE_CODES`.
- Produces :
  - `decodeYamlBytes(buf: Buffer): { text: string; issues: Issue[] }` : BOM UTF-8 et UTF-16 ; repli Windows-1252 avec `encoding-fallback` en warning.
  - `loadYaml11(text): { docs: unknown[]; issues: Issue[] }` (`version: '1.1'`, `uniqueKeys: true`, multi-documents).
  - `interface ValidationContext { installedGames: Map<string, { worldVersion: string | null }>; apVersion: string; schemaFor(game): GameSchema | undefined; allowQuantity: boolean; plandoEnabled: string[] }`.
  - `validatePlayerDocs(docs: unknown[], fileName: string, ctx): PlayerDoc[]`, qui produit chaque `IssueCode` de la liste YAML/jeu/nom/requires/options de la Task 2 (règles : spec §3.10). La suggestion de jeu (`params.suggestion`) utilise une distance de Levenshtein sur les jeux installés.
  - `validateSessionNames(files: PlayerFile[]): Issue[]` : `name-duplicate`, insensible à la casse, après résolution de `{number}`/`{NUMBER}` par compteur de nom de base.
  - `parsePlayerYaml(text): { docs: EditorDoc[]; issues: Issue[] }` et `renderPlayerYaml(doc: EditorDoc, schema?: GameSchema): string`. Règles d'écriture (spec §3.10) : `quoteIfAmbiguous(s: string): string` exporté, `requires.version` entre guillemets, `{}` pour une section vide, entiers pour les ranges, UTF-8 sans BOM.
  - `src/shared/studio-model.ts` (partagé avec la Task 27) : `docFromSchema(schema: GameSchema, name: string): EditorDoc` (valeurs par défaut de chaque option, `requiresVersion` = version du schéma), `applyPreset(doc, preset): EditorDoc`, `setOptionValue(doc, key, v: OptionValue): EditorDoc`.
  - Handlers :
    - `studio:parse`, `studio:render`, `studio:validate`.
    - `studio:open` : avec `path`, passe par `assertUserPath(p, { kind: 'file', exts: ['.yaml', '.yml', '.txt'] })` ; sans `path`, ouvre un dialogue. Lecture via `decodeYamlBytes`. Le chemin renvoyé est ajouté au `Set` des chemins enregistrables.
    - `studio:save` : n'écrit **que** vers un chemin de ce `Set` (issu d'un dialogue du main ou de `studio:open` pendant cette session), ou vers le résultat d'un nouveau dialogue si `path` est null. Extension `.yaml`/`.yml` obligatoire. Tout autre chemin → `PATH_FORBIDDEN`.
    - `studio:validate` utilise `fileName` (défaut `'Player.yaml'`) pour dériver le nom du joueur.

- [ ] **Step 1: Tests**

```ts
it.each(ISSUE_CASES)('detects %s', ...)   // un YAML minimal par code d'issue YAML/jeu/nom/requires/options
it('accepts BOM + CRLF + multi-doc', ...)
it('decodes Windows-1252 é with encoding-fallback warning', ...)
it('flags tab indentation as yaml-syntax with line number', ...)
it('name "Player{number}" twice resolves to Player1/Player2 without duplicate', ...)
it('"VeryLongName{number}" over 16 chars after substitution is name-too-long', ...)
it('roundtrip: render(defaults of each fixture schema) then load gives same values', ...)
it('quotes yes/no/on/off/0755/1:20 and requires.version', ...)
it('preserves unknown root keys and unknown options through parse→render', ...)
it('writes {} for empty game section', ...)
it.each(TEMPLATE_FIXTURES)('Studio defaults for %s validate without error issues', (f) => {
  const schema = parseTemplate(read(f))
  const text = renderPlayerYaml(docFromSchema(schema, 'Goat'), schema)
  const docs = validatePlayerDocs(loadYaml11(text).docs, 'Goat.yaml', ctxWith(schema))
  expect(docs.flatMap((d) => d.issues).filter((i) => i.severity === 'error')).toEqual([])
})
it('studio:save refuses a path not returned by a dialog', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(yaml): yaml 1.1 loader, validator and safe writer`.

---

### Task 14: Sessions (parties de l'organisateur)

**Files:**
- Create: `src/main/core/sessions/store.ts`, `src/main/core/sessions/workspace.ts`, `src/main/core/sessions/rules.ts`, `src/main/core/sessions/validate-session.ts`, `src/main/ipc/session.ts`
- Test: `tests/unit/sessions/*.test.ts`

**Interfaces:**
- Consumes : `writeFileAtomic`, `moveFile`, `listZip`/`readZipBytes`, `decodeYamlBytes`, `loadYaml11`, `validatePlayerDocs`, `validateSessionNames`, `scanWorlds`, `coreWorldsFor`, `Catalog.lookupByGame` (renvoie null si absent), `ROM_TABLE`, `Vault.resolveRomForEntry` (Task 18), `ApSettings`, `SecretStore`, `assertUserPath`, `RULE_PRESETS`/`defaultRules` (Task 2).
- Produces :
  - Importe `RULE_PRESETS` et `defaultRules` de `src/shared/rules.ts` (Task 2) ; ne les redéfinit pas.
  - `buildSessionSettingsEntries(rules: Rules, secrets: { password: string | null; serverPassword: string | null }, romPaths: Record<string /*settingsKey*/, string /*abs path*/>): { path: string[]; value: unknown }[]` (dans `sessions/rules.ts`). Produit :
    - `generator.spoiler`, `generator.race`, `generator.plando_options` ;
    - `server_options.{password, server_password, hint_cost, location_check_points, release_mode, collect_mode, remaining_mode, countdown_mode, auto_shutdown, compatibility, disable_item_cheat = !rules.itemCheat}` ;
    - une entrée `romFile(key)` par ROM, en chemin absolu.
    - Utilisé par la Task 15 (génération) **et** la Task 16 (avant chaque démarrage du serveur).
  - `resolveRomNeeds(games: string[], deps): Promise<RomNeed[]>` : pour chaque entrée de `ROM_TABLE` avec `requiredAtGeneration` dont le jeu est dans la session, appelle `vault.resolveRomForEntry(entry)` (Task 18, seul endroit qui implémente « clé effective → MD5 → repli coffre ») et en fait un `RomNeed` (`path` = chemin `ok`). Ce chemin sera écrit dans le `host.yaml` **de session**, sans toucher aux réglages globaux. Ainsi AP ne tombe jamais sur une ROM absente, donc jamais sur une boîte de dialogue cachée.
  - `createSessionStore(ctx, deps): SessionStore` :
    - Méthodes : `list`, `create`, `get`, `update`, `delete`, `addFiles` (chaque chemin passe par `assertUserPath`), `addText`, `removeFile`, `readFile(id, fileId): { text }`, `replaceFile(id, fileId, text)` (re-décode, re-valide, garde `storedName`), `setSecrets`, `getSecrets(id): { password: string | null; serverPassword: string | null }`, `setGeneration(id, g)`, `setHosting(id, h)`.
    - Workspace `dataRoot/sessions/<id>/{players,output,logs}`. Id `s_` + base36 horodatage + 4 caractères aléatoires.
    - `delete` déplace le workspace vers `backups/`.
    - Les secrets sont stockés via `SecretStore` (clés `session.<id>.password` / `.serverPassword`), jamais dans `session.json`.
  - `importPlayerSources(paths): Promise<{ files: { originalName; text; issues: Issue[] }[]; ignored: string[] }>` : `.yaml`, `.yml`, `.txt` dont le contenu est du YAML, zips (entrées YAML lues en octets via `readZipBytes`, avec limites) ; **tout** passe par `decodeYamlBytes`, ce qui conserve `encoding-fallback`. Tout le reste va dans `ignored`.
  - `storedNameFor(originalName, existing: string[]): string` : caractères `[A-Za-z0-9 _.-]`, extension `.yaml`, suffixes `-2`, `-3`…
  - `validateSession(id): Promise<SessionValidation>`. `blocking` est vrai si l'une des conditions suivantes est remplie :
    - une issue `error` dans un fichier ou au niveau de la session ;
    - au moins un monde manquant ;
    - un `RomNeed` dont le statut n'est pas `ok`.
  - Handlers : `session:*`, sauf `session:generate`.

- [ ] **Step 1: Tests**

```ts
it('create/list/get/update/delete roundtrip; delete moves to backups', ...)
it('addFiles imports yaml from zip and reports README.md as ignored', ...)
it('players dir contains only .yaml files with deduped safe names', ...)
it('secrets are not written to session.json', ...)
it('validateSession is blocking on missing world and lists catalogId', ...)
it('romNeed is ok when the effective rom_file key points to a matching file', ...)
it('romNeed is ok with vaultPath when only the vault has a verified match', ...)
it('romNeed is bad-hash when the key points to a wrong file and the vault has nothing', ...)
it('buildSessionSettingsEntries writes absolute lttp_options.rom_file and disable_item_cheat', ...)
it('replaceFile keeps storedName and revalidates', ...)
it('a Windows-1252 yaml inside a zip keeps its encoding-fallback issue', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(sessions): organizer sessions, imports, rules and validation`.

---

### Task 15: Génération

**Files:**
- Create: `src/main/core/ap/generate.ts`, `src/main/ipc/session-generate.ts`
- Test: `tests/unit/ap/generate.test.ts`

**Interfaces:**
- Consumes : `SessionStore`, `validateSession`, `buildSessionSettingsEntries` (Task 14), `ApSettings.makeSessionSettings`, `spawnAp`, `Locator`, `GENERATE_STAGES`, `FILL_STEP_RE`, `FINAL_ARCHIVE_RE`, `matchApError`, `listZip`/`readZipText`/`extractZipSafe`, `routeForFile`, `TaskManager`.
- Produces :
  - `buildGenerateArgs(ws: { players: string; output: string }, rules: Rules): string[]` : `['--player_files_path', abs, '--outputpath', abs, '--spoiler', String(n)]`, plus `--race` si besoin, plus `--plando`, `'<items, …>'` si `rules.plando` n'est pas vide.
  - Le `host.yaml` de session est construit avec `buildSessionSettingsEntries(rules, secrets, romPaths)` (Task 14). `romPaths` = `{ [need.settingsKey]: need.path }` pour chaque `RomNeed` `ok`.
  - Le service s'enregistre sous le nom `generator`.
  - `reduceProgress(state: GenProgress, line: string): GenProgress`, où `GenProgress = { stage: GenerateStageId; percent: number }` : monotone, l'étape `fill` est affinée par `FILL_STEP_RE`.
  - `extractGenerationError(stderr: string[], stdout: string[]): AppErrorData` : `matchApError` sur la dernière exception, `detail` tronqué à 4000 caractères, `GENERATION_FAILED` sinon.
  - `readGenerationZip(zipPath): Promise<{ seedName; slots: Slot[]; spoilerName: string | null }>` : slots lus depuis l'en-tête du spoiler (`Player <n>: <name>` / `Game: <game>` ; cas 1 joueur) et depuis les noms `AP_<seed>_P<n>_<name>.<ext>`.
  - `runGeneration(ctx, deps, sessionId, task): Promise<Generation>` :
    1. Pré-vol `validateSession` → `GENERATION_PREFLIGHT{errors}` si bloquant.
    2. `makeSessionSettings`.
    3. Spawn `ArchipelagoGenerate`, `cwd = workspace`, **`stdin: 'ignore'`**.
    4. Progression via `task.progress(stage, percent)`.
    5. Log complet dans `workspace/logs/generate-<ts>.txt` (masqué).
    6. Avertissement après 10 min sans nouvelle ligne.
    7. Sur `task.signal` annulé : `proc.kill()`, suppression des fichiers partiels de `output/`, puis `TASK_CANCELLED`.
    8. Succès = exit 0 **et** `FINAL_ARCHIVE_RE`.
       - Extraction de chaque entrée par slot (tout sauf le `.archipelago` et le spoiler) vers `workspace/output/slots/P<n>_<name>/`, via `extractZipSafe` avec `filter`. `Slot.patchFile` reçoit le chemin **absolu** extrait.
       - Mise à jour de la session (`generation`, `status: 'generated'`).
  - Handler : `session:generate`.

- [ ] **Step 1: Tests** (utilisent les faux exécutables de la Task 7 via `exeOverride`) :

```ts
it('buildGenerateArgs uses absolute paths with spaces and accents', ...)
it('reduceProgress over generate-success.txt is monotonic and ends at 100/done', ...)
it('extractGenerationError maps huge FillError to AP_FILL_UNBEATABLE with detail ≤ 4000 chars', ...)
it('readGenerationZip reads slots for multiworld and single-player spoilers', ...)
it('runGeneration success stores Generation with slots and patch file names', ...)
it('runGeneration failure does not hang (stdin ignored) and returns mapped error', ...)
it('runGeneration refuses with GENERATION_PREFLIGHT when validation blocks', ...)
it('runGeneration extracts per-slot files and stores absolute patchFile paths', ...)
it('cancel kills a slow fake generate and removes partial output', ...)
it('session host.yaml contains the vault rom path when the global key is unset', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ap): multiworld generation with live progress and friendly errors`.

---

### Task 16: Serveur local

**Files:**
- Create: `src/main/core/ap/server.ts`, `src/main/core/system/net.ts`, `src/main/ipc/server.ts`, `src/main/services/servers.service.ts` (enregistre `ctx.lifecycle.onBeforeQuit(() => servers.disposeAll(), { phase: 'early' })` et `ctx.lifecycle.onCloseRequested(() => ({ servers: <sessions en cours>, tasks: [] }))`)
- Test: `tests/unit/ap/server.test.ts`, `tests/unit/system/net.test.ts`

**Interfaces:**
- Consumes : `SessionStore`, `buildSessionSettingsEntries`/`resolveRomNeeds` (Task 14), `ApSettings.makeSessionSettings`, `spawnAp`, `findOrphans`/`killOrphan`, `Locator`, `SERVER_READY_RE`, `SERVER_HOSTING_RE`, `SERVER_EVENT_PATTERNS`, `redact`, `EventBus`, `Lifecycle`.
- Produces :
  - `net.ts` : `findFreePort(start = 38281, max = 38381): Promise<number>`, `isPortFree(port): Promise<boolean>`, `listAddresses(ifaces = os.networkInterfaces(), port): Address[]` (localhost + IPv4 LAN non internes), `fetchPublicIp(http): Promise<string | null>` (`https://checkip.amazonaws.com`, 5 s).
  - `buildServerArgs(zipPath, port, savefile, rules): string[]` : chaque option de mode passée explicitement avec sa valeur.
  - `parseServerLine(line): ServerEvent | null`.
  - `quoteConsoleArg(s): string` (guillemets si espaces).
  - `createServerManager(ctx, deps): ServerManager` :
    - `start(sessionId): Promise<ServerState>` :
      1. **Réécrit** `workspace/host.yaml` via `makeSessionSettings(workspace, buildSessionSettingsEntries(rules, secrets, romPaths))` (Task 14), pour toujours refléter les règles et mots de passe courants.
      2. Spawn avec **`cwd = workspace`**, `stdin: 'pipe'`, `selfManaged: true` (+ `detached: true` sous Linux).
      3. Les mots de passe passent par ce `host.yaml` et ne sont **jamais** en argument (invisibles dans la liste des processus) ; écart assumé avec la spec §3.11, mis à jour dans la spec.
      4. `ready` sur `SERVER_READY_RE` ; repli `SERVER_HOSTING_RE` + sonde TCP, timeout 30 s → `SERVER_START_FAILED` ; port occupé → `PORT_IN_USE`.
      5. `savefile = workspace/output/<seed>.apsave` ; s'il existe déjà, `resumedFromSave: true`.
    - `stop(sessionId, { force }): Promise<void>` : `/exit` puis attente de 15 s ; ensuite seulement kill, avec `ServerState.error = PROCESS_TIMEOUT`.
    - `command(sessionId, cmd)`, `get(sessionId)`, `history(sessionId): ServerHistory` (anneaux de 500 événements et 500 lignes).
    - `disposeAll(): Promise<void>`.
    - Au démarrage du service (**eager**) :
      - `ctx.lifecycle.onBeforeQuit(() => disposeAll(), { phase: 'early' })` ;
      - réconciliation via `findOrphans` (Task 7) : une session `hosting.mode === 'local'` dont le serveur orphelin vit encore est marquée `crashed`, avec l'erreur `SERVER_START_FAILED{orphanPid}` et l'action « Arrêter ».
    - Émet `server:state`, `server:event`, `server:log` (lignes masquées avec les secrets de la session) ; met à jour `session.hosting`.
  - Handlers : `server:*`, dont `server:history`.

- [ ] **Step 1: Tests**

```ts
it('buildServerArgs passes every mode flag with explicit value', ...)
it('parses join, leave, item send, goal and all-goals lines', ...)
it('ready only after "server listening on", not after "Hosting game at"', ...)   // fake server
it('command is written to stdin and output line emitted', ...)
it('stop sends /exit and fake writes the savefile', ...)
it('stop force-kills after timeout when server ignores /exit', ...)               // FAKE_MODE=ignore-exit, timeout réduit
it('PORT_IN_USE when port busy', ...)
it('disposeAll stops every running server', ...)
it('quit with a running fake server still writes the savefile (early before late)', ...)
it('start rewrites session host.yaml with the current password and spawns with cwd = workspace', ...)   // FAKE_RECORD
it('start reports resumedFromSave when the .apsave exists', ...)
it('tolerates FAKE_MODE=buffered: ready via TCP probe fallback', ...)
it('history returns past events after a late subscriber', ...)
it('server:log lines are redacted with session password', ...)
it('listAddresses excludes internal and IPv6 link-local', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ap): local multiworld server with console, events and safe stop`.

---

### Task 17: Client archipelago.gg et faux site

**Files:**
- Create: `src/main/core/webhost/cookies.ts`, `src/main/core/webhost/client.ts`, `src/main/core/webhost/rooms.ts`, `src/main/ipc/webhost.ts`
- Create: `tests/mock-webhost/server.ts` (exporte `startMockWebhost`)
- Test: `tests/unit/webhost/*.test.ts`

**Interfaces:**
- Consumes : `Http.fetchRaw`, `SecretStore`, `ConfigStore.webhostUrl` (surchargé par `GOAT_WEBHOST_URL`), `SessionStore`, `TaskManager`.
- Produces :
  - `createCookieJar(secrets): CookieJarStore` : tough-cookie, sérialisé dans le secret `webhost.cookies`.
  - `createWebhostClient(ctx, { baseUrl, jar }): WebhostClient` :
    - `uploadSeed(zipPath): Promise<string /*seedId*/>` : 302 attendu ; 200 HTML → `WEBHOST_UPLOAD_FAILED{message}` via `parseUserMessage(html)`.
    - `createRoom(seedId): Promise<string /*roomId*/>`.
    - `wake(roomId): Promise<void>`.
    - `roomStatus(roomId): Promise<RoomStatus>` : un 404 HTML donne `NOT_FOUND`, sans parse JSON.
    - `sendCommand(roomId, cmd): Promise<void>` (POST formulaire `cmd`).
    - `readLog(roomId, fromByte): Promise<{ text; nextByte }>` (`Range`).
    - `myRooms(): Promise<WebRoomRef[]>`.
    - `ownerUrl(roomId): Promise<string>` (`/session/<uuid>` puis redirection vers la room).
    - Erreur réseau ou 5xx → `WEBHOST_UNAVAILABLE`.
  - Fonctions pures : `parseUserMessage(html): string | null`, `normalizeWebUrl(base, rel): string` (résout `rel` contre `base` ; passe `http://` en `https://` **uniquement** si `base` est en https et que l'hôte est celui du site, sinon le faux site local en http casserait), `toWebRoom(roomId, seedId, status, base): WebRoom`.
  - `hostOnWeb(ctx, deps, sessionId, task): Promise<WebRoom>` :
    - Étapes : `upload`, `room`, `wake`, `port`.
    - `createRoom` est appelé **exactement une fois**.
    - Sondage du port avec backoff 1 → 5 s, total 60 s. `last_port === -1` → `WEBHOST_ROOM_FAILED`.
    - Persiste `session.hosting`.
  - `startMockWebhost(opts?: { portDelayPolls?: number; failUpload?: string }): Promise<{ url; close(); state }>` : routes de la spec §7.2, avec cookie de session, écoute sur `127.0.0.1`.
  - Handlers : `webhost:*`.

- [ ] **Step 1: Tests**

```ts
it('hosts end-to-end against mock and returns WebRoom with port', ...)
it('calls /new_room exactly once even when port takes 3 polls', ...)
it('maps upload HTML user-message to WEBHOST_UPLOAD_FAILED', ...)
it('last_port -1 gives WEBHOST_ROOM_FAILED', ...)
it('room_status 404 HTML gives NOT_FOUND without JSON crash', ...)
it('cookie persists across client instances (owner kept)', ...)
it('readLog uses Range and returns nextByte', ...)
it('network failure gives WEBHOST_UNAVAILABLE within timeout', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(webhost): archipelago.gg hosting client with mock server`.

---

### Task 18: Coffre ROM

**Files:**
- Create: `src/main/core/play/roms.ts`, `src/main/ipc/vault.ts`
- Test: `tests/unit/play/roms.test.ts`

**Interfaces:**
- Consumes : `ROM_TABLE`, `findRomByMd5`, `ApSettings`, `writeFileAtomic`, `TaskManager`.
- Produces :
  - `md5Rom(path, header: 'snes' | 'ines' | 'none'): Promise<string>` (streaming). `snes` retire 512 octets si `size % 1024 === 512` ; `ines` retire 16 octets si le fichier commence par `NES\x1A`.
  - `identifyRom(path): Promise<{ md5: string; entry: RomTableEntry | null }>` : essaie les règles d'en-tête des entrées dont l'extension correspond.
  - `createVault(ctx, deps): Vault` :
    - `list()` ; `scan(paths, task)` (chaque chemin passe par `assertUserPath` ; récursif, profondeur 4, extensions de la spec §3.12, taille ≤ 128 Mo) ; `remove(path)` ; `apply(): Promise<VaultApplyResult>` (une seule écriture `settings.set` groupée ; `SETTINGS_LOCKED` remonté tel quel).
    - `findForMd5(md5s): RomRecord | null`.
    - `resolveRomForEntry(entry: RomTableEntry, md5s = entry.md5s): Promise<{ status: 'ok' | 'missing' | 'bad-hash'; path: string | null; vaultPath: string | null }>` : **seule** implémentation de « clé effective `romFile(entry.settingsKey)` (résolue contre `userPath`) → MD5 avec la règle d'en-tête de l'entrée → sinon correspondance vérifiée du coffre ». Utilisée par les Tasks 14 (`RomNeed`) et 20 (checklist, avec `md5s` = `baseChecksums` du patch).
    - Index `userData/vault.json` ; une entrée dont `size`/`mtime` a changé est re-hachée.
  - Handlers : `vault:*`.

- [ ] **Step 1: Tests**

```ts
it('strips 512-byte SNES copier header only when size % 1024 === 512', ...)   // buffers synthétiques, md5 attendu calculé par crypto
it('strips iNES header for MM2', ...)
it('scan identifies matching file and ignores >128MB and unknown extensions', ...)
it('apply writes rom_file keys in one settings write', ...)
it('resolveRomForEntry: ok from effective key, ok via vault fallback, bad-hash when the key points to a wrong file', ...)
it('a vault record whose file changed is re-hashed before use', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(play): rom vault with md5 identification`.

---

### Task 19: BizHawk

**Files:**
- Create: `src/main/core/play/bizhawk.ts`, `src/main/ipc/bizhawk.ts`
- Test: `tests/unit/play/bizhawk.test.ts`

**Interfaces:**
- Consumes : `fetchReleaseByTag`, `download`, `extractZipSafe`, `extractTarGzSafe`, `ApSettings`, `SETTINGS_KEYS`, `BIZHAWK_*`, `ExecFn`.
- Produces :
  - `checkPrereqsWindows(exec): Promise<BizhawkState['prereqs']>` : clé `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64` `Version`, lue en vue 64 bits via `readRegistryValues` (Task 6).
  - `setPath` passe par `assertUserPath(p, { kind: 'dir' })`.
  - Détection d'un BizHawk existant (spec §3.12) : si `bizhawkclient_options.emuhawk_path` des réglages d'AP pointe vers un EmuHawk existant, `state()` le présente comme installation externe (`managed: false`). Version : `(Get-Item EmuHawk.exe).VersionInfo.ProductVersion` via `runPowerShell` sous Windows, `null` (accepté avec avertissement) sous Linux. Hors de 2.7–2.11 → prérequis en avertissement.
  - `checkPrereqsLinux(exec): Promise<BizhawkState['prereqs']>` : `mono`, `lua5.4`, `lsb_release`, et `libopenal` via `ldconfig -p`.
  - `linuxInstallHint(osRelease: string, missing: string[]): string` : commande apt / dnf / pacman.
  - `createBizhawk(ctx, deps): Bizhawk` :
    - `state()` ; `install(task)` (dans `dataRoot/emulators/bizhawk-2.11.1/`, fichier `.goat-version`, bits exécutables sous Linux) ; `setPath(p)` (valide la présence de `EmuHawk.exe` / `EmuHawkMono.sh`) ; `configureAp()`.
    - `configureAp` écrit le chemin absolu de `EmuHawk.exe` (Windows) ou `EmuHawkMono.sh` (Linux) et `rom_start: true`.
  - Handlers : `bizhawk:*`.

- [ ] **Step 1: Tests**

```ts
it('checkPrereqsWindows reads the VC++ runtime Version via readRegistryValues', ...)   // exec injecté
it('state adopts an existing emuhawk_path from AP settings (2.7 ≤ version ≤ 2.11 accepted, else warning)', ...)
it('linux hint uses apt on ubuntu, dnf on fedora, pacman on arch', ...)
it('configureAp writes EmuHawk.exe on windows and EmuHawkMono.sh on linux', ...)
it('install downloads pinned asset, verifies digest, extracts and writes .goat-version', ...)  // serveur local
it('setPath rejects folder without EmuHawk', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(play): bizhawk install and archipelago configuration`.

---

### Task 20: Patchs, routage et « Rejoindre »

**Files:**
- Create: `src/main/core/play/patch.ts`, `src/main/core/play/join.ts`, `src/main/ipc/join.ts`
- Create: `tests/helpers/make-patch.ts`
- Test: `tests/unit/play/patch.test.ts`, `tests/unit/play/join.test.ts`

**Interfaces:**
- Consumes : `readZipText`, `routeForFile`, `TEXT_ROUTE`, `tutorialUrl`, `WebhostClient` (Task 17), `Vault` + `md5Rom` + `findRomByMd5` (Tasks 18 et 4), `ApSettings` (Task 8), `Bizhawk` (Task 19), `scanWorlds`, `coreWorldsFor`, `Locator`, `spawnAp`, `download`, `assertUserPath`.
- Produces :
  - `readPatchManifest(path): Promise<PatchManifest>` : `archipelago.json` ; `base_checksum` (chaîne ou liste) devient `baseChecksums` ; manifeste absent ou invalide → `PATCH_INVALID`.
  - `parseJoinInput(input: string, existsFile: (p) => boolean): JoinTarget`, qui accepte :
    - l'URL de room `https?://(www\.)?archipelago\.gg/room/<22 caractères>` (avec slash final ou query) ;
    - `archipelago://[slot[:pass]@]host:port[?game=…]` (décodé ; `game` optionnel) ;
    - `host:port` ;
    - un chemin de patch existant ;
    - tout le reste → `JOIN_BAD_INPUT`.
  - `createJoin(ctx, deps): Join` :
    - `resolve(input)`.
    - `prepare(target, slotName, task): Promise<JoinPlan>` :
      - Room **sans** `slotName` : `roomStatus` (réveil si `port <= 0`), puis plan avec `slots` rempli, `slot: null`, `ready: false`, **sans téléchargement**.
      - Room **avec** `slotName` : téléchargement du patch du slot dans `dataRoot/rooms/<roomId>/`, puis lecture du manifeste. Si le `server` du patch diffère du port courant : `warnings` reçoit `patch-server-stale`.
      - Patch local (passé par `assertUserPath`) ou adresse : pas de slots à choisir.
      - Slot sans patch (jeux PC, slots `.zip` comme Factorio) : `route = { suffix: '', client: 'none', exe: null, tier: 'guided' }` avec lien tutoriel. `TEXT_ROUTE` sert uniquement à `textClient`.
    - `refresh(planId)`.
    - `play(planId): Promise<{ pid }>` :
      - Si `checklist.rom` est `missing` avec `code: 'rom-apply-from-vault'`, applique d'abord **cette seule** clé via `settings.set` (peut lever `SETTINGS_LOCKED`).
      - Spawn de `route.exe` avec `[patchPath]`, `cwd = userPath`, `stdin: 'ignore'`, **`window: 'visible'`**, `detached: true`, puis `unref`.
    - `textClient({ host, port, slot, password })` : `ArchipelagoTextClient --connect host:port --name slot [--password pw]`, `window: 'visible'`.
  - `buildChecklist(...)`, pure :
    - `ap` : installé ;
    - `world` : le jeu est fourni par un monde chargé (ou listé dans `coreWorldsFor`) ;
    - `rom` : `na` si pas de `baseChecksums`. Sinon `entry = findRomByMd5(baseChecksums[0])` puis `vault.resolveRomForEntry(entry, baseChecksums)` (Task 18) : `ok` si la clé **effective** est valide ; si seul le coffre a la ROM, `missing` avec `code: 'rom-apply-from-vault'` (appliqué automatiquement par `play`) ; sinon `missing` avec `code: 'rom-missing'` (ou `rom-bad-hash`).
    - `emulator` : `bizhawk` exige un BizHawk installé et `configuredInAp` ; `sni` donne `warning` (assisté) ; sinon `na`.
    - `ready` est vrai si aucun item n'est `missing`, à l'exception de `rom-apply-from-vault`.
  - Handlers : `join:*`.

- [ ] **Step 1: Tests**

```ts
it.each(INPUTS)('parseJoinInput %s', ...)   // URL avec slash final, uri encodée sans game, host:port, chemin avec espaces, entrée invalide
it('readPatchManifest accepts base_checksum string or list', ...)
it('prepare without slot lists room slots and downloads nothing', ...)
it('prepare downloads slot patch from mock webhost room and routes .apemerald to bizhawk', ...)
it('rom is rom-apply-from-vault when only the vault has it, and play applies the key before spawning', ...)
it('clients are spawned with a visible window', ...)
it('flags patch-server-stale when room port changed', ...)
it('checklist missing rom and emulator → ready false', ...)
it('play spawns client with patch path (fake client records argv)', ...)
it('Factorio .zip slot gives route none with tutorial link', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(play): join flow with patch routing and readiness checklist`.

---

### Task 21: Diagnostic, intégration système, liens et fichiers ouverts

**Files:**
- Create: `src/main/core/system/doctor.ts`, `src/main/core/system/support-bundle.ts`, `src/main/core/system/integration-linux.ts`, `src/main/core/system/integration-win.ts`, `src/main/core/system/open-requests.ts`, `src/main/ipc/doctor.ts`, `src/main/ipc/system.ts`, `src/main/services/{doctor,integration,openRequests}.service.ts` (`openRequests` lit `process.argv` au démarrage et s'abonne à `ctx.lifecycle.onSecondInstance` / `onOpenFile` / `onWindowReady`)
- Test: `tests/unit/system/doctor.test.ts`, `tests/unit/system/integration.test.ts`, `tests/unit/main/open-requests.test.ts`

**Interfaces:**
- Consumes : `Locator`, `fetchLatestApRelease`, `scanWorlds`, `listApProcesses`, `isPortFree`, `Bizhawk.state`, `checkGlibc`, `ApSettings.file`, `redact`, `yazl`, `Platform.setProtocolClient`.
- Produces :
  - `runDoctor(deps): Promise<DoctorCheck[]>` : un check par `DoctorCheckId`, avec sévérités (spec §3.15). `fix` vaut `{kind:'auto'}` pour `worlds-corrupt` (quarantaine vers `disabled-worlds`) et `{kind:'navigate', to:'/install'}` pour `ap-installed` et `ap-update`.
  - `fixDoctor(checkId, deps): Promise<DoctorCheck[]>`.
  - `createSupportBundle(deps): Promise<string>` : zip dans `platform.paths.downloads`, nommé `archipelagoat-support-<YYYYMMDD-HHmmss>.zip`, contenant les logs app, les logs AP des 7 derniers jours (≤ 20 Mo) et `doctor.json`, **tout passé par `redact`**.
  - Linux :
    - `desktopEntry({ execPath, iconPath }): string` (contient `Exec="<execPath>" %u`, `MimeType=x-scheme-handler/archipelago;application/x-apworld;application/x-archipelago-patch;`, `Categories=Game;`). L'appelant passe `execPath = process.env.APPIMAGE ?? process.execPath`, car dans une AppImage `process.execPath` pointe vers un montage temporaire `/tmp/.mount_*`.
    - `mimeXml(): string`.
    - `installLinuxIntegration(exec, paths)` et `removeLinuxIntegration(...)`.
  - Windows :
    - `setWinProtocol(on)` via `platform.setProtocolClient`.
    - `setWinAssociations(on)` : ProgID HKCU `ArchipelaGOAT.Patch` pour `.apsml2` (le suffixe BizHawk qu'AP n'associe pas), écrit et retiré via `reg add/delete HKCU\Software\Classes\…` ; désactivé par défaut.
  - Le service `integration` (**eager**) écoute `ap:installed` : à la première installation gérée sous Linux, si `config.integration.linuxDesktop` est vrai, il installe l'intégration.
  - `parseArgvRequests(argv: string[], defaultApp: boolean): OpenRequest[]` : ignore `argv.slice(0, defaultApp ? 2 : 1)` (exécutable et, en dev ou sous Playwright, le point d'entrée) ainsi que tous les flags `--*` (y compris ceux ajoutés par Chromium) ; `archipelago://…` → `uri` ; chemin existant → `file`. Une file d'attente est vidée par `app:pendingOpenRequests` ; quand la fenêtre est prête, les requêtes arrivent par l'événement `app:openRequest`.
  - Handlers : `doctor:*`, `system:*`, `app:pendingOpenRequests`.

- [ ] **Step 1: Tests**

```ts
it('doctor flags corrupt world as error with auto fix and no-manifest as warning', ...)
it('doctor flags port 38281 busy and running AP processes', ...)
it('fix worlds-corrupt moves files to disabled-worlds', ...)
it('support bundle contains no password or session uuid', ...)
it('desktopEntry contains Exec with %u and archipelago scheme handler', ...)
it('parseArgvRequests extracts uri and existing file, skips flags, exe and dev entry point', ...)
it('desktop entry uses APPIMAGE path when set', ...)
it('integration enables linux desktop on first ap:installed when the flag is on', ...)
it('second instance argv is forwarded as app:openRequest', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(system): doctor, support bundle, os integration and open requests`.

---

## Phase C — Interface

Règles communes aux Tasks 22-32 :
- Les composants du design system (Task 22) ne contiennent **aucun texte** : tout libellé est une prop.
- Dans les écrans, tout texte passe par `t('…')`. Chaque écran possède **ses** fichiers de traduction `src/renderer/src/features/<écran>/i18n.fr.json` et `i18n.en.json`, fusionnés sous `screens.<écran>` par `import.meta.glob` (Task 23). Les fichiers communs `i18n/fr.json` / `en.json` n'appartiennent qu'à la Task 23.
- Chaque écran **remplace** le fichier stub créé par la Task 23 à son chemin final (ex. `features/home/HomeScreen.tsx`) ; le routeur n'est jamais modifié par les Tasks 24-32.
- Les appels passent par les hooks de la Task 23 (`useIpcQuery`, `useIpcMutation`, `useTask`, `useEvent`), jamais par `window.goat` en direct.
- Chaque écran gère les états chargement / vide / erreur avec les composants `EmptyState` et `ErrorPanel`.
- Un test renderer par écran, avec `tests/renderer/goat-mock.ts` (Task 23).

### Task 22: Design system « Arcade néon »

**Files:**
- Create: `src/renderer/src/design/tokens.css`, `fonts.css`, `effects.css`, `base.css`, `src/renderer/src/design/sfx.ts`, `src/renderer/src/design/contrast.ts`, `src/renderer/src/design/useEffectsPrefs.ts`
- Create: `src/renderer/src/design/components/{NeonButton,PixelPanel,PlayerCard,StatTile,StatusPill,Stepper,Dropzone,ProgressBar,Terminal,Modal,Toast,Tooltip,Toggle,Segmented,Select,Combobox,Slider,WeightSlider,Badge,TrustBadge,EmptyState,ErrorPanel,CRTOverlay,CopyField,Kbd,Spinner,Tabs}.tsx` + `index.ts`
- Create: `src/renderer/src/features/dev/Gallery.tsx`
- Test: `tests/renderer/design/*.test.tsx`

**Interfaces:**
- Consumes : `AppConfig.effects` (passé en props/contexte), tokens de la spec §4.3.
- Produces :
  - Les variables CSS de la spec §4.3 (noms exacts) et les classes utilitaires `.glow-violet`, `.glow-cyan`, `.pixel-border`, `.blink-cursor`, `.typewriter`, `.crt`, `.scanlines`, `.grid-bg`. Tous les effets sont neutralisés sous `.fx-off` et `@media (prefers-reduced-motion: reduce)`.
  - `useEffectsPrefs(): { glow; crt; animations; sounds; reduced: boolean }`.
  - `sfx.play('blip' | 'confirm' | 'error' | 'coin' | 'success')` : synthèse WebAudio, no-op si les sons sont coupés.
  - `contrastRatio(fg, bg): number`.
  - Composants, props clés :
    - `NeonButton{variant:'primary'|'secondary'|'ghost'|'danger', size:'sm'|'md'|'lg', icon?, loading?}`.
    - `PlayerCard{player:1|2, title, subtitle, onClick}`.
    - `Stepper{steps:{id,label}[], current}` (`aria-current="step"`).
    - `Dropzone{accept: string[], onFiles(paths), onBrowse}` : chemins via `window.goat.pathForFile(file)` (Task 2).
    - `ProgressBar{percent|null, segments=20, label}`.
    - `Terminal{lines:{text, tone?}[], onCommand?, history?}`.
    - `WeightSlider{weights: Record<string,number>, onChange}` (affiche les probabilités en %, arrondies à l'entier).
    - `TrustBadge{tier: TrustTier}`.
    - `CopyField{value, secret?}`.
    - `CRTOverlay` (pointer-events none).
  - Polices via `@fontsource` (aucun réseau).
  - Route `/dev/gallery`, disponible seulement si `!isPackaged`.

- [ ] **Step 1: Tests**

```tsx
it('text tokens reach 4.5:1 on bg-0 and bg-2', () => { /* lit tokens.css, extrait --text, --text-dim, --bg-0, --bg-2 et vérifie contrastRatio ≥ 4.5 pour chaque paire */ })
it('WeightSlider shows rounded probabilities summing to ~100', ...)
it('Stepper marks current step with aria-current', ...)
it('NeonButton loading disables click and shows spinner label', ...)
it('effects off when reduced motion', ...)
it('CopyField masks secret until revealed', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès (y compris un passage visuel sur `/dev/gallery` en `npm run dev`). **Step 5: Commit** `feat(ui): arcade neon design system and component gallery`.

---

### Task 23: Coque de l'application

**Files:**
- Create: `src/renderer/src/App.tsx` (remplace), `router.tsx`, `layout/{AppLayout,TitleBar,Rail,StatusBar,ScreenBoundary,QuitConfirm}.tsx`, `lib/goat.ts`, `lib/errors.ts`, `lib/drop-routing.ts`, `hooks/{useIpc,useTask,useEvent,useShortcuts,useOpenRequests}.ts`, `hooks/useWorldInstall.tsx`, `stores/{config,tasks,ui}.ts`, `i18n/{index.ts,fr.json,en.json}`, `features/boot/BootScreen.tsx`, `features/worlds/TrustDialog.tsx`
- Create (stubs que les Tasks 24-32 remplacent) : `features/home/HomeScreen.tsx`, `features/doctor/DoctorScreen.tsx`, `features/install/InstallScreen.tsx`, `features/worlds/WorldsScreen.tsx`, `features/studio/StudioScreen.tsx`, `features/session/SessionWizard.tsx`, `features/host/LiveGameScreen.tsx`, `features/join/JoinScreen.tsx`, `features/vault/VaultScreen.tsx`, `features/settings/SettingsScreen.tsx`, chacun avec ses `i18n.fr.json`/`i18n.en.json` vides (`{}`)
- Create: `tests/renderer/goat-mock.ts`
- Test: `tests/renderer/shell/*.test.tsx`, `tests/unit/i18n-parity.test.ts`

**Interfaces:**
- Consumes : contrat IPC (Task 2), dont `app:pendingOpenRequests`, `app:confirmQuit`, `worlds:prepareInstall`, `worlds:confirmInstall` et les événements `app:openRequest`, `app:quitRequested` ; design system (Task 22) ; codes (`ERROR_CODES`, `ISSUE_CODES`, `DOCTOR_CHECK_IDS`, `GENERATE_STAGE_IDS`).
- Produces :
  - Routes (hash) : `/`, `/doctor`, `/install`, `/worlds`, `/studio`, `/session/new`, `/session/:id` (assistant, `?step=1..5`), `/play/:sessionId` (partie en cours), `/join`, `/vault`, `/settings`, `/dev/gallery`.
  - Hooks :
    - `useIpcQuery<C>(channel: C, input: ChannelInput<C>, opts?)` : TanStack Query, clé `[channel, input]`.
    - `useIpcMutation<C>(channel, { invalidates?: ChannelName[] })`.
    - `useTask(taskId | null): { status: 'idle'|'running'|'done'|'failed'; progress: TaskProgress | null; logs: TaskLog[]; result: unknown; error: AppErrorData | null }`.
    - `useEvent<E>(name, cb)`.
  - Stores : `useConfig()` (AppConfig + `set(patch)`, synchronisé via `config:changed`), `useTasksStore` (tâches actives pour la barre d'état).
  - `describeError(e: AppErrorData | GoatError): { title: string; body: string; action?: { labelKey: string; to?: string } }` (via `t`).
  - `routeDroppedFile(name): { to: string; intent: 'world-install' | 'session-import' | 'join-patch' | 'studio-open' | 'ask' }`, qui associe :
    - `.apworld` → `/worlds?install=` ;
    - `.yaml`/`.yml` → session active sinon Studio ;
    - un suffixe de patch → `/join` ;
    - `.zip` → `ask`.
  - i18n : détection `app:getInfo.locale` (`fr*` → fr), changement à chaud via `config.language`, espaces de noms `common`, `nav`, `errors`, `issues`, `doctor`, `stages`, `screens.*`.
  - `TitleBar` : 36 px de haut, zones de drag (`-webkit-app-region: drag`), marge droite réservée aux boutons natifs du `titleBarOverlay` (Task 2, Windows et Linux ; largeur lue via `navigator.windowControlsOverlay.getTitlebarAreaRect()`).
  - i18n : `i18n/index.ts` fusionne `fr.json`/`en.json` communs et `import.meta.glob('../features/*/i18n.{fr,en}.json', { eager: true })` sous `screens.<dossier>`. Le test de parité couvre l'ensemble fusionné.
  - `useOpenRequests()`, monté dans `AppLayout` : au montage, vide `app:pendingOpenRequests`, puis s'abonne à `app:openRequest`. Un `uri` route vers `/join?input=<encodé>` ; un `file` passe par `routeDroppedFile` (`.apworld` → `/worlds?install=<path>`, patch → `/join?input=<path>`, `.yaml` → `/studio?open=<path>` ou import dans la session ouverte, `.zip` → modale de choix).
  - `ScreenBoundary` autour de chaque route : message traduit, détail repliable, bouton « Recharger l'écran » (reset + invalidation des queries).
  - `QuitConfirm` : modale sur `app:quitRequested` (liste des serveurs et tâches en cours), qui répond via `app:confirmQuit`.
  - `AppLayout` applique sur la racine les classes d'effets dérivées de `useConfig().effects` : `fx-off` quand `animations` est faux, plus `fx-no-crt`, `fx-no-glow` ; la Task 32 se contente de modifier la config.
  - `useWorldInstall()` : `{ start(source: WorldSource): Promise<{ installed: boolean }>; dialog: ReactNode; state }` (les appels successifs sont mis en file, pour enchaîner plusieurs installations). Enchaîne `worlds:prepareInstall`, `useTask`, `TrustDialog`, puis `worlds:confirmInstall`, et affiche un toast « Redémarre les programmes Archipelago ouverts » si `restartNeeded`. `TrustDialog` (source, auteurs, sha256 tronqué copiable, `TrustBadge`, conflits « X remplacera Y », avertissement code arbitraire, case « J'ai compris » obligatoire) vit ici, car les Tasks 26, 28 et 30 l'utilisent toutes.
  - `Rail` : 7 entrées, raccourcis `Ctrl+1..7`.
  - `StatusBar` : version d'AP via `ap:detect`, état du serveur (`server:state`), tâches actives, langue.
  - `BootScreen` : premier lancement si `!config.firstRunDone`, ≈ 2 s, passable par n'importe quelle touche, puis `firstRunDone = true`.
  - Overlay de dépôt global.
  - `goat-mock.ts` : `installGoatMock(handlers: Partial<Record<ChannelName, (input) => unknown>>): { emit(event, payload); calls }`.

- [ ] **Step 1: Tests**

```ts
it('fr.json and en.json have identical key sets', ...)
it('every ERROR_CODES, ISSUE_CODES, DOCTOR_CHECK_IDS and GENERATE_STAGE_IDS entry has fr and en text', ...)
it('useTask aggregates progress, logs and done events', ...)
it('routeDroppedFile maps apworld, yaml, patch and zip', ...)
it('renders each route with its screen heading (stub title) inside the layout', ...)
it('animations off in config puts fx-off on the root', ...)
it('Ctrl+3 navigates to /join', ...)
it('boot screen shows once then sets firstRunDone', ...)
it('cold-start uri from app:pendingOpenRequests routes to /join?input=', ...)
it('ScreenBoundary catches a throwing screen and reloads it', ...)
it('QuitConfirm answers app:confirmQuit', ...)
it('useWorldInstall requires acknowledgement before confirmInstall and toasts restartNeeded', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): app shell, routing, i18n and ipc hooks`.

---

### Task 24: Écrans Accueil et Diagnostic

**Files:**
- Create: `src/renderer/src/features/home/HomeScreen.tsx`, `features/doctor/DoctorScreen.tsx`
- Test: `tests/renderer/home.test.tsx`, `tests/renderer/doctor.test.tsx`

**Interfaces:**
- Consumes : `ap:detect`, `worlds:list`, `vault:list`, `bizhawk:state`, `doctor:run`, `doctor:fix`, `doctor:supportBundle`, `session:list`.
- Produces : les écrans de la spec §4.2.1 et la page diagnostic (liste des checks, action de correction, bouton « Créer un bundle de support », puis ouverture du dossier).
  - Si `ap:detect` renvoie null : CTA « INSERT COIN » vers `/install`.
  - Le bandeau d'alertes affiche les checks `warning`/`error`.

- [ ] **Step 1: Tests**

```tsx
it('shows INSERT COIN when AP is missing and navigates to /install', ...)
it('shows four stat tiles with values', ...)
it('lists doctor warnings and runs auto fix', ...)
it('recent sessions link to their wizard or live screen', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): home and doctor screens`.

---

### Task 25: Écran Installer / mettre à jour

**Files:**
- Create: `src/renderer/src/features/install/InstallScreen.tsx`
- Test: `tests/renderer/install.test.tsx`

**Interfaces:**
- Consumes : `ap:detect`, `ap:latestRelease`, `ap:install`, `ap:uninstall`, `ap:setCustomPath`, `app:pickPaths`, `useTask`.
- Produces : version installée vs dernière ; options (icônes bureau, dossier personnalisé, chemin existant) ; progression par étape (`download` / `verify` / `backup` / `quarantine` / `install` / `detect`) ; note UAC et vc_redist (Windows) ; désinstallation avec case « supprimer aussi mes données » et confirmation ; erreurs `INSTALL_ELEVATION_DENIED` et `GITHUB_RATE_LIMITED` traduites.

- [ ] **Step 1: Tests**

```tsx
it('offers install when missing, update when older, nothing when up to date', ...)
it('shows staged progress from task events and success state', ...)
it('shows elevation denied error with retry', ...)
it('uninstall requires confirmation and passes purgeUserData', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): archipelago install and update screen`.

---

### Task 26: Écran Mondes

**Files:**
- Create: `src/renderer/src/features/worlds/{WorldsScreen,InstalledList,CatalogGrid}.tsx` (remplace le stub), `features/worlds/i18n.{fr,en}.json`
- Test: `tests/renderer/worlds.test.tsx`

**Interfaces:**
- Consumes : `worlds:list`, `worlds:setEnabled`, `worlds:remove`, `catalog:list`, `app:openPath`, `app:openExternal`, événement `worlds:changed`, hook `useWorldInstall` (Task 23).
- Produces :
  - Onglets Installés / Catalogue (spec §4.2.3).
  - Query `?install=<path>` → `useWorldInstall().start({ kind: 'file', path })`.
  - Catalogue : recherche, filtres, mention `stale`, attribution du wiki (CC BY-NC-SA 4.0).

- [ ] **Step 1: Tests**

```tsx
it('shows state badges (no-manifest, corrupt, shadowed) with tooltips', ...)
it('install from catalog starts useWorldInstall with the catalog source', ...)
it('?install=<path> starts a file install', ...)
it('filters catalog by search and hides after dark by default', ...)
it('shows stale banner when snapshot stale', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): worlds manager and catalog screen`.

---

### Task 27: Studio YAML

**Files:**
- Create: `src/renderer/src/features/studio/{StudioScreen,GamePicker,OptionField,OptionGroup,YamlPreview,PresetMenu}.tsx` (remplace le stub), `features/studio/editor-ops.ts`, `features/studio/i18n.{fr,en}.json`
- Test: `tests/renderer/studio.test.tsx`, `tests/unit/studio-ops.test.ts`

**Interfaces:**
- Consumes : `studio:games`, `studio:schema`, `studio:render`, `studio:validate`, `studio:parse`, `studio:open`, `studio:save`, `session:list`, `session:addText`, `session:readFile`, `session:replaceFile` ; `docFromSchema`/`applyPreset`/`setOptionValue` de `src/shared/studio-model.ts` (Task 13).
- Produces :
  - `editor-ops.ts` : `toWeighted(option, doc): EditorDoc`, `randomize(doc, key): EditorDoc`.
  - Routes d'entrée : `/studio?open=<path>` (`studio:open {path}`) ; `/studio?session=<id>&file=<fileId>` (charge via `session:readFile`, l'enregistrement fait `session:replaceFile` puis revient à l'assistant).
  - Un jeu installé sans schéma (`schemaSource === 'none'`, typiquement un monde custom) propose « Générer les templates » (`ap:regenerateTemplates` + `useTask`), puis recharge `studio:games`.
  - `OptionField`, contrôle selon `kind` :
    - `toggle` → `Toggle` ;
    - `choice`/`text-choice` → `Segmented` (≤ 4 choix) ou `Select` ;
    - `range`/`named-range` → `Slider` + champ, plus noms spéciaux ;
    - `list`/`set`/`dict`/`free` → éditeur YAML brut.
    - Le mode pondéré passe par `WeightSlider`.
  - Aperçu YAML (rendu via `studio:render`, debounce 250 ms) et validation en direct (issues traduites, cliquables vers l'option).
  - Actions : Enregistrer / Exporter / Ajouter à une partie (choix de session) / Ouvrir.

- [ ] **Step 1: Tests**

```ts
it('toWeighted turns a single value into weights {value: 50}', ...)
it('randomize sets the option to "random"', ...)
```
```tsx
it('renders a slider for range and a toggle for toggle option', ...)
it('switching to weighted mode shows WeightSlider and updates preview', ...)
it('validation issue links scroll to the option', ...)
it('add to session calls session:addText with rendered text', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): visual yaml studio`.

---

### Task 28: Assistant de partie (5 étapes)

**Files:**
- Create: `src/renderer/src/features/session/{SessionWizard,StepPlayers,StepCheck,StepRules,StepGenerate,StepHost,WebConsentDialog}.tsx`
- Test: `tests/renderer/session-wizard.test.tsx`

**Interfaces:**
- Consumes : `session:*` (dont `readFile`, `replaceFile`), `session:generate`, `session:validate`, `studio:parse`, `studio:render`, `vault:apply`, `server:start`, `webhost:host`, `app:pickPaths`, `useTask`, `useWorldInstall` (Task 23 ; il couvre `worlds:prepareInstall` et `worlds:confirmInstall`).
- Produces : les étapes de la spec §4.2.5.
  - `StepCheck` :
    - « Installer les mondes manquants » enchaîne `useWorldInstall().start({ kind: 'catalog', id: catalogId })` pour chaque monde, ou propose un fichier quand `catalogId` est null.
    - « Renommer » sur `name-duplicate` / `name-too-long` : `session:readFile` → `studio:parse` → nouveau nom saisi sur le document concerné → `studio:render` de **chaque** document → jointure par `\n---\n` → `session:replaceFile` (les fichiers multi-documents gardent tous leurs documents).
  - `StepGenerate` a un bouton « Annuler » (`tasks:cancel`).
    - « Corriger dans le Studio » : navigation vers `/studio?session=<id>&file=<fileId>`.
    - « Utiliser la ROM du coffre » pour un `RomNeed` avec `vaultPath` : rien à faire globalement, car la génération l'écrit dans le `host.yaml` de session ; l'écran affiche simplement « ROM trouvée dans le coffre ».
  - `StepRules` : presets, avancé, mots de passe via `session:setSecrets`.
  - `StepGenerate` : `ProgressBar` par étapes, log repliable, erreur via `describeError` avec action, confettis au succès.
  - `StepHost` : deux cartes, archipelago.gg (recommandé Internet) et local. `WebConsentDialog` obligatoire avant `webhost:host` (texte de la spec §6.2). En cas de succès, navigation vers `/play/:sessionId`.
  - Le bouton « Suivant » de l'étape 2 est bloqué tant que `blocking`, avec la raison affichée.

- [ ] **Step 1: Tests**

```tsx
it('step 1 lists dropped files and ignored ones', ...)
it('step 2 blocks next while validation is blocking and shows actions', ...)
it('step 2 rename action replaces the file with the new name and revalidates', ...)
it('step 2 fix-in-studio navigates with session and file params', ...)
it('step 3 applies race preset values', ...)
it('step 4 shows stage progress and friendly error with log link', ...)
it('step 5 requires consent before web hosting and navigates to live screen', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): organizer session wizard`.

---

### Task 29: Écran Partie en cours

**Files:**
- Create: `src/renderer/src/features/host/{LiveGameScreen,ConnectionCard,PlayersPanel,EventFeed,ConsolePanel,SlotFiles}.tsx`, `features/host/share-text.ts`
- Test: `tests/renderer/live-game.test.tsx`, `tests/unit/share-text.test.ts`

**Interfaces:**
- Consumes : `session:get`, `session:getSecrets`, `server:get`, `server:history`, `server:command`, `server:stop`, `webhost:room`, `webhost:wake`, `webhost:command`, `webhost:log`, `webhost:openAsOwner`, `app:openPath`, événements `server:*`.
- Produces :
  - `buildShareText(session, addresses | webRoom, { password: string | null }, t): string` : adresse, slots, et mot de passe uniquement si fourni.
  - Mode local :
    - état (`starting`/`ready`…) ; bandeau « Partie reprise depuis la sauvegarde : ses options priment » si `resumedFromSave` ;
    - adresses (localhost, LAN, publique avec mention de la redirection de port) ;
    - joueurs et flux reconstruits depuis `server:history` au montage, puis mis à jour par les événements ;
    - flux d'événements aux couleurs d'AP ;
    - console (historique ↑/↓, boutons `/players`, `/status`, `/release`, `/collect`, `/countdown 10`, `/save`) ;
    - arrêt avec confirmation.
  - `SlotFiles` : un bouton par slot qui ouvre `workspace/output/slots/P<n>_<name>/` (`app:openPath`) et un bouton qui copie le chemin. Le mot de passe s'affiche via `CopyField secret` (valeur lue par `session:getSecrets`).
  - Mode web : adresse `archipelago.gg:<port>`, lien de room, réveil, console distante, log en suivi (sondage toutes les 5 s quand visible), patchs par slot, « Ouvrir en tant que propriétaire ».

- [ ] **Step 1: Tests**

```ts
it('share text includes address, slots and password only when asked', ...)
```
```tsx
it('local: shows ready state and addresses from server:state event', ...)
it('local: rebuilds feed from server:history on mount and shows resumed banner', ...)
it('feed renders item event with sender, item and receiver', ...)
it('console sends command and keeps history', ...)
it('web: wake updates port display', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): live game screen for local and web rooms`.

---

### Task 30: Écran Rejoindre

**Files:**
- Create: `src/renderer/src/features/join/{JoinScreen,SlotPicker,ReadinessChecklist}.tsx`
- Test: `tests/renderer/join.test.tsx`

**Interfaces:**
- Consumes : `join:resolve`, `join:prepare`, `join:refresh`, `join:play`, `join:textClient`, `vault:scan`, `bizhawk:install`, `bizhawk:configureAp`, `useWorldInstall` (Task 23), `app:openExternal`.
- Produces : spec §4.2.7.
  - Champ d'entrée, dépôt de patch, historique local des rooms (store persistant `localStorage`, enveloppé dans un try/catch).
  - Au montage, un paramètre `?input=` (posé par `useOpenRequests`) pré-remplit le champ et lance `join:resolve`.
  - `SlotPicker` alimenté par `JoinPlan.slots` (premier `join:prepare` sans slot). Le choix relance `join:prepare` avec `slotName`.
  - `ReadinessChecklist` : chaque item `missing` propose son action (scanner des ROMs, installer BizHawk, installer le monde via `useWorldInstall`, installer AP). `rom-apply-from-vault` s'affiche « ROM trouvée dans le coffre, sera configurée au lancement ».
  - `JoinPlan.warnings` est affiché (ex. `patch-server-stale` : « l'adresse de la room a changé, utilise <adresse> »).
  - **JOUER** (activé si `ready`). Tier `assisted`/`guided` : étapes et lien tutoriel. Bouton « Text Client ».

- [ ] **Step 1: Tests**

```tsx
it('room url resolves then shows slot picker from plan.slots', ...)
it('?input= param pre-fills and resolves on mount', ...)
it('shows patch-server-stale warning with the current address', ...)
it('checklist shows actions for missing rom and emulator; JOUER disabled until ready', ...)
it('ready plan enables JOUER and calls join:play', ...)
it('guided tier shows tutorial link', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): join screen with readiness checklist`.

---

### Task 31: Écran Émulateurs et ROMs

**Files:**
- Create: `src/renderer/src/features/vault/{VaultScreen,RomList,BizhawkCard}.tsx`
- Test: `tests/renderer/vault.test.tsx`

**Interfaces:**
- Consumes : `vault:*`, `bizhawk:*`, `app:pickPaths`, `useTask`.
- Produces : spec §4.2.8.
  - ROMs reconnues (jeu, MD5 ✓, chemin) et non reconnues.
  - Scan de dossiers, « Appliquer à Archipelago » (résultat appliqué / ignoré traduit, y compris `SETTINGS_LOCKED`).
  - Table des jeux supportés (`vault:table`).
  - `BizhawkCard` : état, prérequis (avec commande Linux copiable), installer, choisir un chemin existant, configurer AP.
  - Mention légale « ArchipelaGOAT ne fournit aucune ROM ».

- [ ] **Step 1: Tests**

```tsx
it('scan task fills recognised roms list', ...)
it('apply shows applied and skipped with reasons', ...)
it('bizhawk card shows missing prereqs with copyable linux command', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): emulators and rom vault screen`.

---

### Task 32: Réglages et À propos

**Files:**
- Create: `src/renderer/src/features/settings/{SettingsScreen,AboutPanel}.tsx`
- Test: `tests/renderer/settings.test.tsx`

**Interfaces:**
- Consumes : `app:getConfig`, `app:setConfig`, `app:getInfo`, `app:setGithubToken`, `app:secretsStatus`, `app:clearData`, `system:integration`, `system:setIntegration`, `ap:setCustomPath`, `app:pickPaths`, `app:openPath`.
- Produces : spec §4.2.9.
  - Langue, effets (CRT, glow, animations, sons), 18+, chemin d'AP.
  - Jeton GitHub en **écriture seule** via `app:setGithubToken` ; l'écran n'affiche que « jeton enregistré » d'après `app:secretsStatus`.
  - Si `canEncrypt` est faux : interrupteur « Mémoriser les secrets en clair » (`allowPlaintextSecrets`), avec confirmation.
  - Intégration système : bureau Linux, protocole `archipelago://` sous Windows, associations `.apsml2` sous Windows.
  - Dossiers (ouvrir) et boutons « Vider » pour téléchargements, cache du catalogue et logs (`app:clearData`).
  - À propos : version, mention « Compagnon non officiel pour Archipelago », licences des dépendances (import **optionnel** de `resources/licenses.json` généré par la Task 35 : l'écran gère son absence), attributions (wiki CC BY-NC-SA 4.0, index ionium), état de l'auto-update (texte statique « non configuré »).

- [ ] **Step 1: Tests**

```tsx
it('switching language updates UI text immediately', ...)
it('disabling animations sets fx-off on root', ...)
it('integration toggles call system:setIntegration and reflect availability', ...)
it('github token field is write-only and shows saved state', ...)
it('plaintext secrets toggle appears only when encryption is unavailable and asks confirmation', ...)
it('clear catalog cache calls app:clearData', ...)
it('about panel shows unofficial companion notice', ...)
```

- [ ] **Step 2-4:** vérifier l'échec, implémenter, vérifier le succès. **Step 5: Commit** `feat(ui): settings and about screens`.

---

## Phase D — Qualité et livraison

### Task 33: Tests d'intégration bout en bout (main)

**Files:**
- Create: `tests/integration/harness.ts`, `tests/integration/organizer-local.test.ts`, `tests/integration/organizer-web.test.ts`, `tests/integration/player-join.test.ts`, `tests/integration/install-linux.test.ts`

**Interfaces:**
- Consumes : `createServices` (Task 2) et tous les services enregistrés ; faux exécutables (Task 7) ; faux site (Task 17).
- Produces :
  - `createFakeApInstall(dir, { games: string[] }): Promise<string>` (réutilisé par la Task 34), qui crée un arbre d'installation factice complet :
    - `manifest.json` `{"version":[0,6,8]}` ;
    - les `.mjs` de `tests/fake-ap/` ;
    - `lib/worlds/<module>.apworld` pour chaque jeu des YAML de fixture (via `tests/helpers/make-apworld.ts`) ;
    - `Players/Templates/<jeu>.yaml` (copiés des fixtures de la Task 12) ;
    - `custom_worlds/` vide.
  - `createTestCore({ tmp, webhostUrl, fakeApDir }): Promise<{ services; ctx; cleanup() }>` : Platform factice, dialogues pilotés par une file, `GOAT_FAKE_AP_DIR` pointant sur l'arbre factice.

- [ ] **Step 1: Écrire les tests**

```ts
it('organizer local: create session → add fixture yamls → validate → generate → start server → /players → stop → .apsave exists', ...)
it('organizer web: generate → host on mock → room port → command → log tail', ...)
it('player: resolve room url → prepare → patch routed to bizhawk → play spawns fake client with patch', ...)
it('install linux managed from local tar.gz then detect', ...)
```

- [ ] **Step 2: Lancer** `npm run test:integration`. Attendu : vert. Les échecs révèlent des défauts d'intégration ; les corriger dans le module fautif, avec un test unitaire de non-régression.
- [ ] **Step 3: Commit** `test: end-to-end integration flows with fake archipelago`.

---

### Task 34: E2E Playwright sur l'app Electron

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/app.spec.ts`, `tests/e2e/organizer.spec.ts`, `tests/e2e/helpers.ts`
- Output: `tests/e2e/screenshots/{fr,en}/*.png` (versionnées)

**Interfaces:**
- Consumes : app buildée (`out/`), env `GOAT_E2E=1`, `GOAT_DATA_ROOT`, `GOAT_USER_DATA`, `GOAT_FAKE_AP_DIR`, `GOAT_WEBHOST_URL` (faux site lancé par le test), `GOAT_E2E_DIALOGS`.
- `playwright.config.ts` exclut `linux-smoke.spec.ts` et `packaged-win.spec.ts` de `npm run test:e2e` (ils ne tournent qu'avec leur variable d'env dédiée, Task 35).
- Produces : `launchApp({ lang, fakeAp: boolean, argv?: string[] }): Promise<{ app; page }>`. Chaque lancement reçoit un `GOAT_USER_DATA` et un `GOAT_DATA_ROOT` uniques (verrou single-instance indépendant) ; Playwright tourne avec `workers: 1`. L'arbre AP factice vient de `createFakeApInstall` (Task 33).

- [ ] **Step 1: Tests**

```ts
for (const lang of ['fr', 'en'] as const) {
  test.describe(lang, () => {
    test(`visits every screen without console errors or CSP violations and screenshots it (${lang})`, ...)
  })
}
test('cold start with an archipelago:// argv lands on /join with the input resolved', ...)
test('keyboard: Tab reaches both player cards and Enter opens wizard', ...)
test('reduced motion disables animations', ...)   // emulateMedia
test('organizer flow through UI with fake AP: add yaml via queued dialog, generate, host locally, see ready', ...)
test('second launch skips boot screen', ...)
```

- [ ] **Step 2: Lancer** `npm run build && npm run test:e2e`. Attendu : vert, et les captures sont produites. Relire les captures (cohérence visuelle néon, aucun texte qui déborde en FR).
- [ ] **Step 3: Commit** `test(e2e): playwright electron coverage of all screens in fr and en`.

---

### Task 35: Packaging, icônes, build Linux Docker, CI, README

**Files:**
- Create: `electron-builder.yml`, `build/icon.svg` (logo original : chèvre pixel + îlots, néon violet/jaune), `scripts/make-icons.mjs` (`sharp` → `build/icon.png` 512 et `build/icons/*.png` ; `png-to-ico` → `build/icon.ico`), `scripts/build-linux-docker.mjs`, `scripts/smoke-linux-docker.mjs`, `tests/e2e/linux-smoke.spec.ts`, `tests/e2e/packaged-win.spec.ts`, `scripts/checksums.mjs`, `scripts/licenses.mjs` (génère `resources/licenses.json`), `src/main/services/updater.service.ts`
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md` (sections FR puis EN : fonctionnalités, captures, installation, avertissement SmartScreen, non-affiliation, ROMs, développement)
- Modify: `package.json` (champ `build` retiré au profit de `electron-builder.yml`, scripts `dist:*`)

**Interfaces:**
- Produces, avec `electron-builder.yml` conforme à la spec §8 :
  - Windows : cibles `nsis` (`perMachine: false`, `oneClick: false`, `allowToChangeInstallationDirectory: true`) et `portable` ; `artifactName` `ArchipelaGOAT-Setup-${version}.${ext}` / `ArchipelaGOAT-${version}-portable.${ext}`.
  - Linux : cibles `AppImage`, `deb`, `tar.gz` ; `category: Game` ; `mimeTypes: [x-scheme-handler/archipelago]`.
  - `protocols: [{ name: Archipelago, schemes: [archipelago] }]` ; `asar: true` ; `directories.output: release/${version}`.
  - `publish: github`, utilisé uniquement par la CI avec `--publish always` sur un tag.
  - `scripts/build-linux-docker.mjs` lance `docker run --rm -v <repo>:/project -v archipelagoat-linux-node-modules:/project/node_modules -w /project electronuserland/builder:24 bash -lc "npm ci && npm run build && npx electron-builder --linux"`.
  - `scripts/smoke-linux-docker.mjs` : conteneur `electronuserland/builder:24` + `apt-get install -y xvfb libnss3 libgtk-3-0 libgbm1 libasound2 libxss1`, puis `xvfb-run npx playwright test tests/e2e/linux-smoke.spec.ts`. Le spec cible `release/<ver>/linux-unpacked/archipelagoat` avec `--no-sandbox` (pas d'AppImage en conteneur : pas de FUSE). Il vérifie aussi `APPIMAGE_EXTRACT_AND_RUN=1 ./ArchipelaGOAT-<ver>.AppImage --version` (on passe par la variable d'env, car Playwright préfixe ses propres arguments), et installe/lance le `.deb` (`dpkg -i`) et le `tar.gz` extrait.
  - `scripts/checksums.mjs` écrit `release/<ver>/SHA256SUMS.txt`.
  - `src/main/services/updater.service.ts` : `initUpdater()` reste un no-op si `app-update.yml` est absent (cas des builds locaux) ; l'écran À propos affiche alors « non configuré ».

- [ ] **Step 1: Générer les icônes** `npm run icons`. Vérifier que `build/icon.ico` contient 16 à 256 px et `build/icon.png` fait 512×512.
- [ ] **Step 2: Build Windows** `npm run dist:win`. Attendu : `release/<ver>/ArchipelaGOAT-Setup-<ver>.exe` et `ArchipelaGOAT-<ver>-portable.exe`.
- [ ] **Step 3: Smoke E2E sur l'app packagée Windows.** `tests/e2e/packaged-win.spec.ts` couvre trois variantes, et chacune doit charger l'accueil sans erreur :
  - `release/<ver>/win-unpacked/ArchipelaGOAT.exe` ;
  - le **portable** `ArchipelaGOAT-<ver>-portable.exe` ;
  - l'installeur NSIS, installé silencieusement (`ArchipelaGOAT-Setup-<ver>.exe /S /D=<tmp>\ArchipelaGOAT`), dont on lance l'exe installé avant de le désinstaller (`Uninstall ArchipelaGOAT.exe /S`).
  
  Commande : `GOAT_E2E_PACKAGED=1 npx playwright test tests/e2e/packaged-win.spec.ts`. Attendu : vert.
- [ ] **Step 4: Build Linux.** Démarrer Docker Desktop si besoin, puis `npm run dist:linux:docker`. Attendu : `.AppImage`, `.deb` et `.tar.gz` dans `release/<ver>/`.
- [ ] **Step 5: Smoke Linux.** `node scripts/smoke-linux-docker.mjs`. Attendu : `linux-unpacked`, le `.deb` installé et le `tar.gz` extrait chargent tous la fenêtre sans erreur ; l'AppImage répond à `--version`.
- [ ] **Step 6: Sommes de contrôle.** `node scripts/checksums.mjs`. Attendu : `SHA256SUMS.txt` liste les 5 artefacts.
- [ ] **Step 7: Valider les workflows** avec `npx --yes @action-validator/cli .github/workflows/*.yml` (ou équivalent). Ne pas pousser.
- [ ] **Step 8: Commit** `build: packaging for windows and linux, icons, ci workflows and readme`.

---

### Task 36: Vérification réelle (uniquement avec l'accord explicite de l'utilisateur)

Cette tâche ne s'exécute qu'après un « oui » explicite de l'utilisateur, demandé au moment voulu. Elle produit un rapport, pas de code. Les défauts trouvés deviennent des corrections, chacune avec son test de non-régression.

- [ ] **Step 1:** Avec l'app packagée Windows, installer réellement Archipelago 0.6.8 depuis l'écran Installer (une invite UAC). Vérifier la détection, la version et les chemins, et que `ap:processes` est vide après.
- [ ] **Step 2:** Avec le Studio, créer **au moins 10** YAML (valeurs par défaut) pour des jeux core sans ROM (ex. Clique, Timespinner, Hollow Knight, Stardew Valley, The Witness, Factorio, Super Mario 64, Kingdom Hearts 2, Celeste 64, Hylics 2). Les ajouter à une session et générer. Noter le résultat **par jeu** ; tout échec devient un défaut à corriger. Relever les vraies lignes de sortie pour enrichir `tests/fixtures/ap-output/`.
- [ ] **Step 3:** Héberger en local. Se connecter avec le Text Client depuis l'écran Rejoindre (`localhost:<port>`) et **vérifier que sa fenêtre s'affiche**. Envoyer `/players`, arrêter. Vérifier que le `.apsave` existe et que le délai de buffering de la console est acceptable (sinon, noter pour la v1.1 : pseudo-terminal).
- [ ] **Step 3b:** Pendant les étapes 1 à 3, vérifier explicitement qu'**aucune fenêtre console** ne s'ouvre (installation, génération, hébergement, rejoindre).
- [ ] **Step 4 (optionnel, nouvel accord) :** héberger la même partie sur archipelago.gg, vérifier le port, la console distante et le log, puis laisser la room expirer.
- [ ] **Step 5:** Linux en conteneur : installation gérée tar.gz, génération, serveur.
- [ ] **Step 6:** Rédiger `docs/verification/2026-10-16-real-run.md` (résultats, captures, écarts) et committer `docs: real-world verification report`.
