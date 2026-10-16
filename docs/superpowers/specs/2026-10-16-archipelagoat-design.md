# ArchipelaGOAT — Spécification de conception

- **Date** : 2026-10-16
- **Statut** : validée section par section en conversation, en attente de relecture écrite
- **Référence factuelle** : [`docs/research/archipelago-research-brief.md`](../../research/archipelago-research-brief.md) (abrégé « brief §x.y »). Toute valeur technique (chemin, flag, endpoint, hash) citée ici vient du brief, lui-même sourcé sur le code d'Archipelago 0.6.8 et des requêtes réelles.
- **Cible Archipelago** : 0.6.8 (release du 2026-10-04). Le code doit rester tolérant aux versions 0.6.x voisines et préparer 0.7.0.

---

## 1. Compréhension et objectifs

### 1.1 Ce que veut l'utilisateur (dit)

- Une app **ultra puissante** et **ultra jolie** qui rend l'installation et la mise en place d'un multiworld [Archipelago](https://archipelago.gg) ultra rapides et simples.
- Livrée en **.exe pour Windows 10/11** et pour **Linux**.
- **Tout-en-un** : couvre le joueur (être prêt à jouer) et l'organisateur (monter une partie de groupe).
- Hébergement **au choix** : sur **archipelago.gg** ou **en local**.
- Interface **FR + EN**, langue auto-détectée, changeable.
- Nom : **ArchipelaGOAT**.
- Direction visuelle : **Arcade néon** (noir profond, couleurs rétro vives, typo mono, glow).
- Stack : **Electron + React + TypeScript**.
- Distribution : **binaires locaux d'abord**, CI GitHub prête mais **rien de publié sans accord**.

### 1.2 Hypothèses (validées en conversation)

- **Compagnon non officiel** : l'app pilote les programmes officiels d'Archipelago **non modifiés** (`ArchipelagoGenerate`, `ArchipelagoServer`, `ArchipelagoLauncher`, clients) et les endpoints documentés d'archipelago.gg. Aucun fork, aucun patch des fichiers d'AP.
- **Aucun réhébergement** : APWorlds, émulateurs et installateurs sont téléchargés depuis leur **source officielle**, vérifiés par sha256.
- **Aucune ROM, ISO ou WAD n'est jamais téléchargée ni liée.** L'utilisateur fournit ses dumps ; l'app les reconnaît par MD5.
- **Archipelago officiel uniquement** (pas MultiworldGG). **Une seule version d'AP installée** sous Windows (contrainte de l'installateur Inno, brief C10).
- **Mondes « After Dark » (18+) masqués par défaut**, activables dans les réglages.
- L'app s'affiche clairement comme **« Compagnon non officiel pour Archipelago »** et n'utilise aucune image d'archipelago.gg (copyright LegendaryLinux).

### 1.3 Critères de succès

1. **Organisateur** : de « rien d'installé » à « partie hébergée avec lien partageable » en **moins de 5 minutes** (hors temps de téléchargement), avec N YAML déjà reçus.
2. **Joueur** : du lien de room au jeu lancé en **2-3 clics** pour les 9 jeux BizHawk (brief §1.11, tier Full).
3. **Zéro terminal**, **zéro édition manuelle** de `host.yaml`, **zéro fenêtre console** qui s'ouvre.
4. Aucune erreur brute d'AP n'est montrée sans traduction claire et action proposée (le log complet reste accessible).
5. Rendu identique Windows/Linux, fluide (60 fps sur les animations), utilisable entièrement au clavier.

### 1.4 Hors périmètre v1 (v1.1+)

- Assistant réseau : UPnP-IGD / NAT-PMP / PCP, détection CGNAT, test de joignabilité, règle pare-feu, guides de tunnels.
- PopTracker et Universal Tracker.
- Aides SNI / RetroArch (scripts wrapper, `retroarch.cfg`).
- Aides par jeu PC (Factorio, Civ6, fichiers de config, lancement avec flags).
- Éditeurs plando / triggers / item_links avancés, exporteur de schéma par apworld.
- Tableau de bord tracker temps réel via WebSocket.
- Génération web via `/api/generate`.
- Versions d'AP côte à côte.

---

## 2. Architecture

### 2.1 Vue d'ensemble

```
┌────────────────────────── Renderer (React 19 + TS) ──────────────────────────┐
│ écrans · design system néon · i18n FR/EN · stores Zustand · TanStack Query    │
└───────────────▲──────────────────────────────────────────────┬───────────────┘
                │ événements (push)                            │ invoke (request/response)
┌───────────────┴─────────── Preload (contextBridge) ──────────▼───────────────┐
│ window.goat : API typée unique, générée depuis src/shared/ipc.ts               │
└───────────────▲──────────────────────────────────────────────┬───────────────┘
┌───────────────┴──────────── Main (Node 22+/TS) ──────────────▼───────────────┐
│ ipc/ : handlers, validation zod de chaque entrée                               │
│ core/ : services métier purs (aucun import 'electron' sauf adaptateurs)        │
│   ap/ webhost/ worlds/ yaml/ play/ system/ sessions/                           │
└──────────────────────────────────────────────────────────────────────────────┘
        │ child_process (programmes AP officiels, BizHawk) · fs · HTTPS
```

**Règle de dépendance** : `renderer → preload → main/ipc → main/core`. `core` n'importe jamais `electron` directement ; les besoins Electron (chemins `app.getPath`, `safeStorage`, `shell`, `dialog`) passent par une interface `Platform` injectée, ce qui rend `core` testable sous Vitest sans Electron.

### 2.2 Arborescence du projet

```
archipelagoat/
  package.json · electron.vite.config.ts · electron-builder.yml · tsconfig.*.json
  vitest.config.ts · playwright.config.ts · .eslintrc / eslint.config.js · .prettierrc
  build/                      # icônes (icon.svg source, icon.png 512, icon.ico), ressources installeur
  resources/                  # fichiers embarqués à l'exécution (data par version d'AP)
  src/
    shared/
      ipc.ts                  # contrat IPC : canaux, schémas zod d'entrée, types de sortie, événements
      types.ts                # modèles partagés (Session, PlayerFile, ApInstall, WorldInfo, …)
      errors.ts               # AppError { code, params, detail?, logPath? }
      data/
        ap-constants.ts       # AppId Inno, regex d'assets, noms d'exécutables, ports par défaut
        patch-routes.ts       # suffixe de patch → client AP + tier (Full/Assisted/Guided)
        rom-table.ts          # jeux → MD5 acceptés, règles d'en-tête, clé host.yaml, requis à la génération
        tutorial-links.ts     # jeu → URL tutoriel archipelago.gg
        log-patterns.ts       # regex des lignes de progression / prêt / événements serveur
        error-catalog.ts      # regex d'erreurs AP → code + clé i18n + action proposée
    main/
      index.ts                # bootstrap, fenêtre, single-instance, protocole, CSP, menus
      platform.ts             # implémentation Electron de l'interface Platform
      ipc/                    # un fichier de handlers par domaine
      core/
        ap/        locator.ts · releases.ts · installer-win.ts · installer-linux.ts
                   settings.ts · process.ts · generate.ts · server.ts · templates.ts
        webhost/   client.ts · cookies.ts · rooms.ts
        worlds/    apworld.ts · inventory.ts · install.ts · catalog.ts
        yaml/      template-parser.ts · schema.ts · validate.ts · writer.ts
        play/      patch.ts · router.ts · roms.ts · bizhawk.ts · join.ts
        system/    doctor.ts · downloads.ts · secrets.ts · redact.ts · logger.ts
                   integration-linux.ts · integration-win.ts · net.ts · fsx.ts
        sessions/  store.ts · workspace.ts
    preload/index.ts
    renderer/
      index.html
      src/
        main.tsx · App.tsx · router.tsx
        design/      tokens.css · fonts.css · effects.css · components/*
        features/    home/ install/ worlds/ studio/ session/ host/ join/ vault/ settings/ doctor/
        i18n/        index.ts · fr.json · en.json
        stores/ · hooks/ · lib/
  tests/
    unit/ · integration/ · e2e/
    fixtures/        templates/ yamls/ patches/ apworlds/ webhost/ ap-output/
    fake-ap/         faux exécutables AP (scripts Node) reproduisant les pièges
    mock-webhost/    faux archipelago.gg (HTTP local)
  .github/workflows/ci.yml · release.yml
  docs/
```

### 2.3 Dossiers de données de l'app

Jamais dans le dossier d'Archipelago (son installateur efface `{app}\*.exe` et `lib/`, brief §1.2).

| Rôle | Windows | Linux |
|---|---|---|
| Config + petites données (`userData`) | `%APPDATA%\ArchipelaGOAT\` | `~/.config/ArchipelaGOAT/` |
| Données lourdes (`dataRoot`) | `%LOCALAPPDATA%\ArchipelaGOAT\` | `${XDG_DATA_HOME:-~/.local/share}/ArchipelaGOAT/` |

Contenu :

- `userData/config.json` — réglages de l'app (langue, effets, sons, 18+, chemins, intégration).
- `userData/secrets.bin` — secrets chiffrés via `safeStorage` (cookie de session archipelago.gg, mots de passe serveur, jeton GitHub optionnel).
- `userData/vault.json` — index du coffre ROM (références de fichiers, pas de copies).
- `dataRoot/sessions/<id>/` — `session.json`, `players/`, `output/`, `host.yaml` (copie complète), `logs/`.
- `dataRoot/rooms/<roomId>/` — patchs téléchargés pour une partie rejointe (patch et ROM patchée côte à côte).
- `dataRoot/archipelago/` — installation d'AP gérée par l'app sous Linux (§4.2).
- `dataRoot/emulators/bizhawk-2.11.1/`.
- `dataRoot/downloads/` — cache des téléchargements vérifiés.
- `dataRoot/catalog/` — cache du catalogue (index ionium, wiki), ETag.
- `dataRoot/disabled-worlds/` — APWorlds désactivés (hors du dossier scanné par AP).
- `dataRoot/backups/<timestamp>/` — sauvegardes de `host.yaml`/`options.yaml` et d'APWorlds retirés.
- `dataRoot/logs/` — logs de l'app (rotation, secrets masqués).

### 2.4 Contrat IPC

- Un seul fichier source de vérité : `src/shared/ipc.ts`. Chaque commande déclare `{ input: zodSchema, output: Type }`. Chaque événement push déclare son payload.
- Le preload expose `window.goat.invoke(channel, input)` et `window.goat.on(event, cb) → unsubscribe`, typés à partir du contrat. Aucune autre API n'est exposée (pas de `ipcRenderer` brut).
- Le main valide **chaque** entrée avec zod avant d'appeler `core`. Les erreurs remontent en `AppError` sérialisable `{ code, params, detail?, logPath? }` ; le renderer les traduit via i18n.
- Domaines : `app.*`, `ap.*` (install, état, réglages), `worlds.*`, `catalog.*`, `studio.*`, `session.*`, `generate.*`, `server.*`, `webhost.*`, `join.*`, `vault.*`, `emulators.*`, `doctor.*`, `system.*`.
- Les opérations longues (téléchargement, installation, génération, serveur) renvoient un `taskId` immédiatement et publient `task.progress` / `task.log` / `task.done` / `task.error`.

### 2.5 Stack et dépendances

- **Shell** : Electron (dernière stable), electron-vite, electron-builder, electron-updater (configuré, inactif tant que rien n'est publié).
- **Renderer** : React 19, React Router (mode hash), Zustand, TanStack Query, i18next + react-i18next, Motion (ex-Framer Motion), `@fontsource/press-start-2p`, `@fontsource/jetbrains-mono` (polices embarquées, aucune requête réseau), icônes Tabler (`@tabler/icons-react`).
- **Main** : `yaml` (mode YAML 1.1, commentaires préservés), `yauzl` (lecture de zip en streaming, sans extraction), `tar` (extraction tar.gz Linux), `smol-toml` (index ionium), `tough-cookie` (jar archipelago.gg), `zod`, `semver`, `p-limit`. HTTP via `fetch` natif de Node (undici).
- **Aucun module natif** (pas de node-gyp) : build Linux simple dans Docker. Registre Windows via `reg.exe`, élévation via PowerShell, secrets via `safeStorage`.
- **Qualité** : TypeScript `strict`, ESLint, Prettier, Vitest, Playwright (`_electron`).

---

## 3. Modules métier (main/core)

Chaque module a une responsabilité unique, une interface publique documentée et des tests unitaires. Les signatures ci-dessous sont indicatives ; les noms exacts sont fixés dans le plan d'implémentation.

### 3.1 `ap/locator` — trouver Archipelago et ses chemins

- Un **chemin choisi manuellement** dans les réglages prime toujours, sur les deux OS (c'est un choix explicite de l'utilisateur).
- **Windows**, ensuite, dans l'ordre :
  1. Clé de désinstallation `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{918BA46A-FAB8-460C-9DFF-AE691E1C865B}_is1` en **vue 64 bits** : `InstallLocation`, `DisplayName`. Lecture via PowerShell en UTF-8 (et non `reg.exe`, dont la sortie OEM casse les accents).
  2. `HKLM\SOFTWARE\Classes\archipelago\shell\open\command`, en ignorant une commande qui pointerait vers ArchipelaGOAT.
  3. `C:\ProgramData\Archipelago` s'il existe.
- **Linux**, ensuite : installation gérée par l'app (`dataRoot/archipelago/Archipelago`), puis l'AppImage la plus récente trouvée dans `~/Applications`, `~/Downloads`, `~/.local/bin`. Pour une AppImage (non montée), la liste des jeux core vient d'une table embarquée par version d'AP.
- **Version** : `<install>/manifest.json` → `version: [0,6,8]` ; sinon `DisplayName` ; sinon nom de l'AppImage. Pour une AppImage, `~/.local/share/Archipelago/manifest.json`.
- **Résolution des chemins** (réimplémente `Utils.user_path`, brief §1.4) :
  - `localPath` = dossier de l'exécutable (AppImage : point de montage, en lecture seule).
  - `userPath` = `localPath` s'il est accessible en écriture, sinon `~/.local/share/Archipelago` (Linux uniquement).
  - `customWorlds` = `userPath/custom_worlds` si `userPath == localPath`, sinon `userPath/worlds`.
  - `players`, `output`, `logs`, `templates` (`Players/Templates`), `cache` (`%LOCALAPPDATA%\Archipelago\Cache` / `~/.cache/Archipelago`).
  - `settingsFile` : algorithme exact de `settings.py:885-907` (un seul fichier chargé, cf. brief C3).
- **Exécutables** : table des noms (`ArchipelagoLauncher`, `ArchipelagoLauncherDebug` (Windows), `ArchipelagoGenerate`, `ArchipelagoServer`, `ArchipelagoTextClient`, `ArchipelagoBizHawkClient`, `ArchipelagoSNIClient`, …). Pour une AppImage, l'invocation devient `<AppImage> --executable=<Nom> …`.
- **Sortie** : `ApInstall { kind: 'windows-installer'|'linux-managed'|'linux-targz'|'linux-appimage'|'custom', version, localPath, userPath, paths{…}, exe(name) → {command, argsPrefix} }` ou `null`.

### 3.2 `ap/releases` — releases GitHub

- `GET https://api.github.com/repos/ArchipelagoMW/Archipelago/releases/latest` (jamais `/releases` brut pour éviter les RC ; toujours `tag_name`).
- Sélection d'asset **par regex** : `^Setup\.Archipelago\.(.+)\.exe$`, `^Archipelago_(.+)_linux-x86_64\.tar\.gz$`, `^Archipelago_(.+)_linux-x86_64\.AppImage$`.
- Récupère `digest` (`sha256:<hex>`), `size`, `browser_download_url`.
- Cache + ETag dans `dataRoot/catalog/`. Jeton GitHub optionnel (réglages) pour dépasser 60 req/h. Gestion explicite de `403 rate limit` → message clair + heure de reset.

### 3.3 `system/downloads` — téléchargements vérifiés

- Téléchargement en streaming vers `*.part`, progression (octets, débit, ETA), annulation, reprise via `Range` si le serveur l'accepte.
- Vérification **sha256 obligatoire** quand un digest est connu ; sinon l'appelant doit fournir une politique explicite (`trust: 'unverified'` affiché dans l'UI).
- Renommage atomique à la fin. Les fichiers téléchargés sont des **données non fiables** : jamais exécutés hors des chemins prévus (installateur AP, BizHawk).

### 3.4 `ap/installer-win` — installer / mettre à jour AP sous Windows

1. Récupérer la release (§3.2), télécharger le Setup, vérifier sha256.
2. Vérifier qu'aucun processus `Archipelago*.exe` ne tourne (sinon proposer de les fermer).
3. Sauvegarder `host.yaml`/`options.yaml` et la liste des APWorlds custom dans `dataRoot/backups/`.
4. **Quarantaine préventive** des APWorlds corrompus (zip illisible) : sinon l'étape `--update_settings` de l'installateur bloque sur une boîte de dialogue cachée (brief §4.3).
5. Lancer en élevé et attendre le code de sortie :
   `powershell -NoProfile -Command "(Start-Process -FilePath '<setup>' -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/CLOSEAPPLICATIONS','/TASKS=\"desktopicon,deletelib\"','/LOG=\"<log>\"' -Verb RunAs -Wait -PassThru).ExitCode"`.
   - `/TASKS` est toujours passé explicitement (Inno mémorise les choix précédents). Réglage : icônes bureau oui/non.
   - Installation dans un dossier personnalisé : `/DIR="…"` (option avancée).
6. Mapper les codes de sortie 0-8 (brief §1.2) vers des messages ; UAC refusé → code dédié `INSTALL_ELEVATION_DENIED`.
7. Suivre la progression en lisant le log Inno.
8. Re-détecter l'installation et afficher la version.

- **Désinstallation** : `unins000.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`. Les données utilisateur d'AP restent sur disque ; une option « nettoyage complet » les supprime **après confirmation explicite**.
- Note UI : une petite fenêtre vc_redist peut apparaître, c'est normal.

### 3.5 `ap/installer-linux` — installer / mettre à jour AP sous Linux

- **Stratégie par défaut : tar.gz, mode « dossier stable »** (brief C6 mode a) dans `dataRoot/archipelago/` :
  1. Télécharger le tar.gz, vérifier sha256.
  2. Extraire dans `dataRoot/archipelago/.staging-<ver>/` (protection contre traversée de chemins et liens symboliques sortants).
  3. Mise à jour : sauvegarder la config, supprimer `Archipelago/lib/` et les exécutables racine, puis copier le contenu de staging par-dessus (les dossiers utilisateur `Players/`, `output/`, `custom_worlds/`, `host.yaml`, `logs/` sont préservés).
  4. Vérifier les bits exécutables (`ArchipelagoLauncher`, `SNI/sni`, …).
- Pas de FUSE, pas de chemin `/tmp/.mount_*` (évite le bug #5863), pas de root.
- **AppImage existante** : supportée en lecture/pilotage (via `--executable=`), jamais mise à jour automatiquement (on propose de migrer vers l'installation gérée).
- Si `glibc` < 2.35 (`ldd --version`), avertir que les builds d'AP risquent de ne pas démarrer.

### 3.6 `ap/settings` — réglages d'Archipelago

- Sait **quel fichier AP charge** (§3.1) et le lit avec `yaml` en mode **YAML 1.1**, en préservant les commentaires.
- Écritures **uniquement quand aucun processus AP ne tourne** ; sinon l'opération est mise en attente avec message. Sauvegarde dans `dataRoot/backups/` avant chaque écriture, écriture atomique (`.tmp` + rename).
- Ne crée **jamais** un `options.yaml` partiel (il remplacerait `host.yaml`, brief C3).
- Opérations : `get(path)`, `set(path, value)`, `ensureRomPath(key, absPath)`, `setBizhawk(emuhawkPath, romStart)`.
- **Fichier de session** : `makeSessionSettings(sessionDir, overrides)` copie le fichier de réglages effectif dans `sessionDir/host.yaml` puis applique les overrides (generator, server_options). Les processus de la session sont lancés avec `cwd = sessionDir`, ce qui fait charger ce fichier (cwd ≠ localPath) et permet de désactiver des flags `store_true` (brief §1.7).

### 3.7 `ap/process` — lanceur de processus AP

Point unique pour lancer un programme AP ou BizHawk.

- Entrée : `{ exe: ExeRef, args, cwd (obligatoire), stdin: 'ignore'|'pipe', env? }`.
- `windowsHide: true` (pas de fenêtre console), `cwd` explicite (jamais hérité), environnement nettoyé (`PYTHONHOME`, `PYTHONPATH` retirés ; `LD_LIBRARY_PATH` retiré si l'app tourne en AppImage), `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`.
- Décodage UTF-8 ligne par ligne de stdout **et** stderr, avec gestion des lignes sans retour final (invites).
- Sous Windows, pour les composants GUI dont on veut la sortie, utiliser `ArchipelagoLauncherDebug.exe`.
- Jamais lancé en élevé. Suivi des PID ; à la fermeture de l'app, les processus enfants sont arrêtés proprement (serveur : `/exit`) avec confirmation si une partie est en cours.
- Tests : accepte une `ExeRef` arbitraire `{ command, argsPrefix }` pour pointer vers les faux exécutables Node (`tests/fake-ap/`).

### 3.8 `ap/generate` — générer une partie

- Entrée : `sessionId`. Prépare le workspace (§3.13), écrit le `host.yaml` de session, puis lance
  `ArchipelagoGenerate --player_files_path <ws>/players --outputpath <ws>/output --spoiler <n> [--seed N] [--race] [--plando "<…>"]`
  avec **`stdin: 'ignore'`** (sinon blocage sur « Press enter to close », brief §1.6).
- **Progression** : parse les lignes de `log-patterns.ts` (brief §1.6) → étapes nommées + pourcentage ; « Current fill step … X/Y » affine la barre.
- **Succès** = code 0 **et** ligne `Creating final archive at <abs path>`. On lit ensuite le zip (sans l'extraire) : `AP_<seed>.archipelago`, spoiler, fichiers par joueur ; on construit la liste des slots (nom, jeu, fichier de patch) à partir du spoiler et des noms de fichiers.
- **Échec** : extraction de la dernière exception (`<Type>: …`) depuis stderr, tronquée (une FillError peut faire des Mo), passage au `error-catalog` → message traduit + action ; lien vers le log complet.
- **Pré-vol obligatoire** avant de lancer : validation YAML (§3.10), mondes installés (§3.9), ROMs requises à la génération (§3.12).
  - Une ROM est « prête » si la clé `<jeu>.rom_file` du fichier de réglages effectif pointe vers un fichier au bon MD5, **ou** si le coffre ROM contient une correspondance vérifiée.
  - Dans les deux cas, le chemin absolu est écrit dans le `host.yaml` **de session**, sans toucher aux réglages globaux.
  - Aucune génération ne part si le pré-vol échoue : ainsi aucune boîte de dialogue cachée ne peut apparaître.
- Délai de garde : avertissement à 10 min sans progression, annulation possible (kill + nettoyage).

### 3.9 `worlds/*` — APWorlds

- **`apworld.ts` — inspection statique** (aucun code exécuté) : lecture du zip avec `yauzl`, limites (taille totale décompressée, nombre d'entrées, ratio de compression) contre les zip bombs, refus des chemins absolus / `..`. Extrait : dossier racine unique, présence de `<dir>/__init__.py`, `archipelago.json` (racine ou `<dir>/`), champs `game`, `world_version`, `minimum_ap_version`, `maximum_ap_version`, `authors`, `version`, `compatible_version`.
- **`inventory.ts` — inventaire** : scanne `customWorlds` et `lib/worlds` (top-level uniquement, ignore `_*`/`.*`, mêmes règles qu'AP, brief §1.10). Pour chaque monde : état (`ok`, `no-manifest` → « cassé en 0.7.0 », `incompatible-version`, `corrupt` → **fatal pour AP**, `shadowed` = masqué par une version supérieure du même jeu, `core-loose` = non remplaçable). Prédit quel fichier AP chargera par jeu.
- **`install.ts` — installation** : depuis un fichier local, une URL ou le catalogue.
  - Validations d'AP + celles qu'il ne fait pas : `compatible_version ≤ 7`, version d'AP installée dans `[min, max]`, conflit avec un monde existant (affiche lequel gagnera).
  - **Écran de confiance obligatoire** : source, auteur(s), sha256, niveau de confiance (Core / Indexé + hash vérifié / Release GitHub liée au wiki / Fichier inconnu) et rappel « un APWorld exécute du code sur ton ordinateur ».
  - Nom de fichier cible = `<dossier interne>.apworld` (renomme les assets versionnés, sans jamais changer la casse).
  - Copie atomique dans `customWorlds`. L'installation est autorisée même si un programme AP est ouvert ; comme AP ne charge les mondes qu'au démarrage, l'app avertit qu'il faut redémarrer les programmes AP ouverts.
  - **Désactiver** = déplacer vers `dataRoot/disabled-worlds/` ; **Réactiver** = l'inverse ; **Supprimer** = déplacer vers `backups/` (annulable), après confirmation.
- **`catalog.ts` — catalogue** :
  - **Index ionium** (`ionium-ap/Archipelago-index`) : arbre via `GET /repos/ionium-ap/Archipelago-index/git/trees/main?recursive=1`, TOML via `raw.githubusercontent.com` (cache + ETag), `index.lock` pour les sha256. Filtrage par version d'AP installée (`[releases]` min/max, `bases`).
  - **Wiki Miraheze** (API MediaWiki, `origin=*`) : statut, mainteneur, lien de setup, catégories (dont « After Dark », « requires a ROM at generation »).
  - Jointure par nom de jeu (manifest `game`) puis par `owner/repo`. Attribution affichée (wiki CC BY-NC-SA 4.0).
  - Les fichiers annexes des releases (mods clients, Setup .exe de forks…) ne sont **jamais** lancés automatiquement.
  - Liste d'opt-out des mainteneurs embarquée (`resources/`), mise à jour avec l'app.

### 3.10 `yaml/*` — schéma, validation, écriture

- **Sources de schéma** (par ordre de préférence) :
  1. Templates locaux `Players/Templates/<jeu>.yaml` (fournis par l'installateur pour les mondes core ; régénérables pour les mondes custom via `ArchipelagoLauncher[Debug] "Generate Template Options" -- --skip_open_folder`).
  2. Templates du site `GET https://archipelago.gg/static/generated/configs/<jeu>.yaml` (mondes core, versions du site).
  3. Presets : `GET https://archipelago.gg/games/<jeu>/option-presets` et `Players/Templates/Presets/`.
- **`template-parser.ts`** : parse le format déterministe des templates (brief §1.9) : en-tête, bannières `# Group #`, options à 2 espaces avec lignes de doc `# `, `# Minimum value is N` / `# Maximum value is M`, `# equivalent to N`, poids (défaut = 50). Produit un schéma :
  `OptionSchema { key, group, doc, kind: 'toggle'|'choice'|'range'|'named-range'|'text-choice'|'list'|'set'|'dict'|'counter'|'free', default, choices?, range?{min,max}, specialNames?{name→value}, confidence: 'exact'|'inferred' }`.
  Les options complexes (dict/list/set/item_links/plando) sont éditées en bloc YAML brut avec validation syntaxique.
- **`validate.ts`** — valide sans exécuter Python (brief §1.9, §3.1) :
  - Parse YAML 1.1 avec détection des clés dupliquées ; multi-documents (`---`).
  - `name` : présent ou dérivé du nom de fichier, substitution des placeholders, ≤ 16 caractères après substitution, pas `Archipelago`, unicité **insensible à la casse** dans la session, pas de nom purement numérique.
  - `game` : chaîne ou dict pondéré ; chaque jeu de poids > 0 doit avoir une section, être installé (casse exacte), sinon suggestion floue et proposition d'installation via le catalogue.
  - `requires.version` : chaîne `"X.Y.Z"` entre guillemets, ≤ version installée ; `requires.plando` ⊆ modules plando activés ; `requires.game` vs `world_version` installé.
  - Valeurs d'options vs schéma quand il est connu (Toggle/Choice/Range/random-range, floats refusés, poids tous nuls refusés, section vide `Game:` refusée → proposer `{}`).
  - `quantity` vs `allow_quantity` ; options PerGameCommon à la racine refusées.
  - Résultat : `Issue { severity: 'error'|'warning', code, path, params }` traduisible.
- **`writer.ts`** : écrit des YAML que `UniqueKeyLoader` d'AP relira identiquement : guillemets sur les scalaires ambigus en YAML 1.1 (`yes/no/on/off`, `0755`, `1:20`…), entiers pour les ranges, `{}` pour les sections vides, `requires.version` entre guillemets, jamais de `random-range` négatif, UTF-8 sans BOM.

### 3.11 `ap/server` — serveur local

- Choix d'un port libre (38281 par défaut, sinon suivant).
- Lancement : `ArchipelagoServer <zip absolu> --port <P> --savefile <ws>/output/<seed>.apsave` + **toutes** les options de mode passées explicitement (`--release_mode`, `--collect_mode`, `--remaining_mode`, `--countdown_mode`, `--hint_cost`, `--location_check_points`, `--auto_shutdown`), `cwd = sessionDir`, **`stdin: 'pipe'` gardé ouvert**.
- Avant chaque démarrage, le `host.yaml` de session est réécrit avec les règles et mots de passe courants. Les **mots de passe passent par ce fichier et jamais en argument** (sinon ils seraient visibles dans la liste des processus). `disable_item_cheat` vient aussi de ce fichier (flag `store_true`).
- **Prêt** = ligne `server listening on` ; repli : `Hosting game at` + sonde TCP sur le port (timeout 30 s). Port occupé → erreur dédiée.
- **Adresses à partager** : localhost, IPv4 LAN (interfaces réseau), IP publique (lookup par l'app, avec mention « nécessite une redirection de port »).
- **Console** : envoi de commandes sur stdin (`/players`, `/status`, `/send`, `/release`, `/collect`, `/countdown`, `/hint`, `/option`, `/save`) ; les commandes à plusieurs mots sont quotées.
- **Flux d'événements** : parse `has joined`, `has left the game`, `sent <item> to <receiver> (<location>)`, `has completed their goal`, `Team #1 has completed all of their games!` (brief §1.7). Mots de passe masqués dans toute ligne affichée.
- **Arrêt** : `/exit\n` puis attente ; arrêt forcé après 15 s seulement, avec avertissement de perte possible (~60 s de progression).
- **Reprise** : même zip + même `--savefile` ; avertir qu'une sauvegarde existante prime sur les nouvelles options.
- Si le buffering de stdout rend la console trop lente (à vérifier en test réel), le plan prévoit un pseudo-terminal en v1.1 ; en v1 on accepte un léger délai.

### 3.12 `play/*` — rejoindre, patchs, ROMs, BizHawk

- **`patch.ts`** : lit `archipelago.json` d'un patch (zip) : `game`, `player`, `player_name`, `server`, `patch_file_ending`, `base_checksum`, `result_file_ending`, `compatible_version`.
- **`router.ts`** : suffixe → client AP + tier (`patch-routes.ts`, brief §1.11) :
  - BizHawk : `.apred .apblue .apemerald .apmlss .apcv64 .apcvcotm .apmm2 .apmm3 .apsml2 .apygo06` → `ArchipelagoBizHawkClient <patch>` (Full).
  - SNI : `.aplttp .apsm .apsmw .apsmz3 .apsoe .apl2ac .apkdl3 .apyi .apeb` → `ArchipelagoSNIClient <patch>` (Assisted).
  - `.apz5` OoT, `.apbn3` MMBN3, `.aptloz` Zelda 1, `.apadvn` Adventure, `.apzl` Zillion → leurs clients (Assisted).
  - `.apladx .apgl .apcivvi` → Launcher (Assisted).
  - **Jamais de `.zip` passé au Launcher** (il le prendrait pour un multiworld à héberger).
  - Sans patch (jeux PC) : infos de connexion + lien tutoriel + bouton « Text Client » (Guided).
- **`join.ts`** :
  1. Entrée : URL de room (`https://archipelago.gg/room/<id>`), lien `archipelago://slot:pass@host:port?game=…`, ou patch déposé.
  2. Room : `GET /api/room_status/<room>` ; si `last_port <= 0`, réveiller via `GET /room/<id>?update` puis re-sonder ; liste des slots (nom, jeu).
  3. Choix du slot → téléchargement du patch (`https://archipelago.gg` + `download`) dans `dataRoot/rooms/<roomId>/`.
  4. **Checklist** : AP installé et compatible ✓, monde du jeu installé ✓, ROM de base (via `base_checksum`) ✓, émulateur ✓. Chaque ✗ propose son action.
  5. **JOUER** : lance le client routé avec le patch. Si le `server` du patch est périmé (port changé), on le signale et on affiche l'adresse à jour.
- **`roms.ts` — coffre ROM** :
  - L'utilisateur choisit un dossier ou des fichiers ; scan des extensions plausibles (`.sfc .smc .gb .gbc .gba .nes .z64 .n64 .v64 .bin .sms .gen .md .iso .srl`), taille max raisonnable.
  - MD5 avec règles d'en-tête (SNES : retirer 512 octets si `size % 1024 == 512` ; MM2/MM3 : retirer l'en-tête iNES de 16 octets) ; comparaison à `rom-table.ts` et aux `base_checksum` des patchs.
  - « Appliquer à Archipelago » : écrit `<clé>.rom_file` (chemin absolu) dans le fichier de réglages effectif (§3.6).
  - Le coffre stocke des **références** (chemin, taille, mtime, MD5, jeu), jamais de copie, et ne partage jamais rien.
  - La table MD5 et les clés `host.yaml` sont **dérivées du code source d'AP 0.6.8** (worlds/*), vérifiées par des tests.
- **`bizhawk.ts`** :
  - Version épinglée **2.11.1** : `BizHawk-2.11.1-win-x64.zip` / `BizHawk-2.11.1-linux-x64.tar.gz` depuis les releases GitHub `TASEmulators/BizHawk` (digest de l'API).
  - Installation dans `dataRoot/emulators/bizhawk-2.11.1/`. Détection d'un BizHawk existant (version 2.7 à 2.11 acceptée).
  - Windows : vérifier le runtime VC++ x64 (registre) et sinon guider vers l'installateur officiel Microsoft. Linux : vérifier `mono`, `lua5.4`, `openal`, `lsb_release` et afficher la commande d'installation pour la distribution détectée (apt/dnf/pacman).
  - Écrit `bizhawkclient_options.emuhawk_path` (`EmuHawkMono.sh` sous Linux, chemins absolus) et `rom_start: true`.

### 3.13 `sessions/*` — parties de l'organisateur

```ts
Session {
  id, name, createdAt, updatedAt, status: 'draft'|'validated'|'generated'|'hosting'|'finished',
  players: PlayerFile[],          // fichiers copiés dans <ws>/players (noms normalisés, triés)
  rules: Rules,
  generation?: { seedName, zipPath, spoilerPath?, slots: Slot[], durationS, log },
  hosting?: { mode: 'local', port, addresses, savefile } | { mode: 'web', seedId, roomId, roomUrl, port, lastCheckedAt }
}
PlayerFile { id, originalName, storedName, docs: { name, games: string[], issues: Issue[] }[] }
Rules { preset: 'casual'|'async'|'race'|'custom', spoiler, race, hintCost, releaseMode, collectMode,
        remainingMode, countdownMode, itemCheat, locationCheckPoints, autoShutdown, password?, serverPassword?, plando: string[] }
```

- Workspace isolé `dataRoot/sessions/<id>/` ; **seuls des fichiers YAML** arrivent dans `players/` (Generate lit tout fichier top-level, un README casserait la génération).
- Import : `.yaml`, `.yml`, `.txt` YAML, zips contenant des YAML (extraits en mémoire, validés), multi-documents conservés.
- Presets (brief §4.3) : **Détente** (item cheat off, hint_cost 10, release/collect auto, spoiler 3), **Async** (auto_shutdown 0, release/collect auto), **Course** (`--race`, spoiler 0, compatibility 0).
- Mots de passe stockés via `secrets`, jamais en clair dans `session.json`.

### 3.14 `webhost/*` — archipelago.gg

- **Client** : `fetch` + jar `tough-cookie` persistant (cookie `session` chiffré via `safeStorage`), `redirect: 'manual'` pour `/uploads` et `/new_room`, User-Agent `ArchipelaGOAT/<version> (unofficial Archipelago companion)` (l'URL du dépôt y sera ajoutée s'il est publié), `Accept-Encoding: gzip, br`. Toujours vérifier le statut **avant** de parser du JSON (les 404 sont du HTML). URLs relatives et `http://` normalisées vers `https://archipelago.gg`.
- **Héberger** (après consentement explicite, §6.2) :
  1. `POST /uploads` (multipart, champ `file` = `AP_<seed>.zip`) → `302 Location: /seed/<seedId>` ; sinon extraire `<div class="user-message">` → erreur.
  2. `GET /new_room/<seedId>` **une seule fois** (non idempotent) → `302 /room/<roomId>`.
  3. `GET /room/<roomId>?update` pour réveiller, puis sonder `GET /api/room_status/<roomId>` jusqu'à `last_port > 0` (`-1` = erreur) avec backoff (1 s → 5 s, max 60 s).
  4. Afficher `archipelago.gg:<port>`, l'URL de room, les patchs par slot.
- **Room en cours** : console distante via `POST /room/<roomId>` (champ `cmd`, propriétaire seulement), log via `GET /log/<roomId>` avec `Range: bytes=N-` (sondage toutes les 5 s quand l'écran est visible), bouton « Réveiller » (`/room/<id>?update` puis relecture du port, qui **peut changer**).
- **Ouvrir en tant que propriétaire dans le navigateur** : via `/session/<uuid>` (l'UUID est traité comme un secret).
- **Mes rooms** : `GET /api/get_rooms` / `get_seeds` avec le cookie de session.
- Ne jamais pré-charger ni appeler `disown_*` sans action explicite.
- Si plus de 20 joueurs, rien ne change (génération locale + upload) ; si le site renvoie une erreur de taille, l'afficher clairement.

### 3.15 `system/*` — diagnostic, intégration, secrets

- **`doctor.ts`** : liste de vérifications avec sévérité et action de correction : AP installé/à jour, fichier de réglages effectif, APWorlds (corrompus = bloquant, sans manifeste = alerte 0.7.0, incompatibles, doublons), processus AP en cours, port 38281 occupé, BizHawk et prérequis, espace disque, dossier `C:\ProgramData\Archipelago` modifiable par tous (information), glibc sous Linux, horloge/connexion réseau. **Bundle de support** : zip des logs AP + app, secrets masqués (§6.3), généré localement, jamais envoyé.
- **`integration-linux.ts`** : `.desktop` dans `~/.local/share/applications/` avec `Exec=<app> %u`, `MimeType=x-scheme-handler/archipelago;` (+ types MIME `*.apworld`, `*.archipelago` via XML shared-mime-info), puis `xdg-mime default` et `update-desktop-database`. Activé par défaut à la première installation d'AP, désactivable.
- **`integration-win.ts`** : AP enregistre déjà `archipelago://` et la plupart des suffixes. Option (désactivée par défaut) « Ouvrir les liens archipelago:// avec ArchipelaGOAT » en **HKCU** (prioritaire, réversible). Associations HKCU optionnelles pour les suffixes oubliés par AP (`.apsml2`).
- **Protocole et fichiers** : l'app est single-instance ; un lien `archipelago://` ou un fichier ouvert (patch, `.apworld`, `.yaml`, `.zip` de seed) est routé vers l'écran adéquat. Les liens sans `?game=` sont acceptés (contrairement au Launcher qui plante).
- **`secrets.ts`** : `safeStorage.encryptString` ; si indisponible (Linux sans keyring), stockage refusé par défaut avec message, ou option « mémoriser en clair » explicitement acceptée.
- **`redact.ts`** : masque `password`, `server_password`, `Password: …` dans `Hosting game at`, `:<pass>@` dans les URLs, la ligne `A client connection was refused due to: {…}`, la sortie de `/options`, le cookie et l'UUID de session.

---

## 4. Interface

### 4.1 Navigation

- **Rail gauche** (icônes + libellés au survol, raccourcis `Ctrl+1…7`) : Accueil · Partie · Rejoindre · Studio YAML · Mondes · Émulateurs et ROMs · Réglages. Le diagnostic est accessible depuis l'accueil et la barre d'état.
- **Barre d'état** : version d'AP (pastille verte/jaune/rouge), état du serveur (off / local / archipelago.gg), tâches en cours (téléchargements, génération), langue.
- **Toasts** pour les fins de tâche ; **modales** pour les confirmations et l'écran de confiance APWorld.

### 4.2 Écrans

1. **Accueil**
   - Deux grandes cartes « PLAYER 1 — Organiser une partie » et « PLAYER 2 — Rejoindre une partie ».
   - Tuiles d'état : Archipelago, Mondes, ROMs, BizHawk.
   - Bandeau d'alertes du diagnostic (ex. APWorlds cassés en 0.7.0).
   - Parties récentes (reprendre, réouvrir la room).
   - **Premier lancement** : séquence « boot » arcade (≈2 s, passable, une seule fois), langue auto, détection d'AP ; s'il manque, gros CTA « INSERT COIN — Installer Archipelago 0.6.8 ».
2. **Installer / mettre à jour**
   - Version installée vs dernière, notes de version (texte brut).
   - Options : icônes bureau, dossier personnalisé (avancé).
   - Progression : téléchargement → vérification sha256 → sauvegarde → installation → vérification.
   - Désinstallation (avec ou sans nettoyage des données).
3. **Mondes**
   - Onglets **Installés** / **Catalogue**.
   - Installés : liste avec état, version, source, menu (désactiver, supprimer, ouvrir le dossier), filtre par état.
   - Catalogue : recherche, filtres (statut, tags, requiert une ROM, PopTracker, 18+ si activé), cartes avec badge de confiance, bouton Installer → écran de confiance.
   - Dépôt d'un `.apworld` par glisser-déposer n'importe où dans l'app.
4. **Studio YAML**
   - Choix du jeu (recherche parmi les mondes installés), nom du joueur.
   - Options par groupe (cartes repliables) : contrôles adaptés (interrupteur, segmenté/liste, slider + champ, slider avec noms spéciaux, bloc YAML brut pour les complexes) ; doc de l'option en infobulle/panneau.
   - Mode **simple** (une valeur) / **pondéré** (poids par valeur, avec aperçu des probabilités).
   - Presets du jeu ; bouton « aléatoire » par option.
   - Aperçu YAML en direct (lecture seule) et validation en direct.
   - Actions : Enregistrer, Exporter, Ajouter à une partie, Ouvrir un YAML existant (import et édition, en préservant les clés inconnues).
5. **Partie (assistant organisateur)**, en 5 étapes avec stepper :
   1. **Joueurs** : zone de dépôt, liste des YAML (nom, jeu(x), état), « Créer le mien » (Studio).
   2. **Vérification** : erreurs/alertes par YAML avec actions (installer le monde manquant, renommer un doublon, fournir une ROM, corriger dans le Studio).
   3. **Règles** : presets + avancé (indices, release/collect/remaining/countdown, mots de passe, spoiler, course, plando, item cheat).
   4. **Génération** : barre de progression par étapes, log repliable, erreur traduite + action.
   5. **Hébergement** : choix archipelago.gg (recommandé pour jouer sur Internet) ou local (LAN, ou Internet avec redirection de port).
6. **Partie en cours** (local ou web)
   - Statut, adresse à copier, message prêt à coller (adresse, slots, mot de passe, lien de room).
   - Joueurs (connecté / absent / but atteint).
   - Flux d'objets aux couleurs officielles d'AP : progression `#AF99EF`, utile `#6D8BE8`, piège `#FA8072`, filler `#00EEEE`.
   - Console avec historique et raccourcis.
   - Fichiers de patch par joueur (ouvrir le dossier, copier).
   - Actions : sauvegarder, arrêter, réveiller (web).
7. **Rejoindre**
   - Champ « lien de room / archipelago:// », zone de dépôt de patch, historique des rooms.
   - Choix du slot, checklist avec actions, gros bouton **JOUER**.
   - Pour les tiers Assisted/Guided : étapes claires + lien vers le tutoriel officiel.
8. **Émulateurs et ROMs**
   - Coffre ROM : dossiers suivis, ROMs reconnues (jeu, région, MD5 ✓), non reconnues.
   - « Appliquer à Archipelago ».
   - BizHawk : état, installer/mettre à jour, prérequis.
9. **Réglages**
   - Langue, effets (CRT, glow, animations, sons), mondes 18+.
   - Chemins (AP, dossiers), intégration système, jeton GitHub optionnel.
   - Données de l'app (ouvrir, nettoyer), à propos (version, licences, attributions, mention non officiel).

### 4.3 Design system « Arcade néon »

- **Tokens** (`design/tokens.css`, variables CSS) :
  - Fonds : `--bg-0 #07070C`, `--bg-1 #0B0B12`, `--bg-2 #111118`, `--bg-3 #1A1A24`.
  - Lignes : `--line #26262F`, `--line-strong #3A3A48`.
  - Texte : `--text #F5F3FF`, `--text-dim #9D9DB0`, `--text-mute #5B5B6B`.
  - Néons : `--neon-violet #A855F7` (principal), `--neon-cyan #22D3EE` (info / joueur 2), `--neon-yellow #FACC15` (alerte / accent), `--neon-pink #F43F5E` (danger), `--neon-green #4ADE80` (succès), `--neon-magenta #EE00EE` (soi-même dans le flux).
  - Glows : `--glow-violet: 0 0 6px #A855F7aa, 0 0 18px #A855F755`, etc.
- **Typographie** : Press Start 2P pour les titres et étiquettes d'arcade (taille ≥ 10 px, usage parcimonieux) ; JetBrains Mono pour tout le reste ; tailles 12/13/14/16/20/28.
- **Effets** (tous désactivables, et coupés par `prefers-reduced-motion`) :
  - fond grille en perspective + scanlines CRT légères + vignette ;
  - glows sur focus/hover ;
  - bordures « pixel » (coins en escalier via `clip-path`) ;
  - curseur `_` clignotant ;
  - texte qui s'écrit sur les titres de section ;
  - transitions de page (glissé + flash) ;
  - confettis pixel à la fin d'une génération réussie.
- **Sons** 8-bit synthétisés en WebAudio (aucun fichier), **coupés par défaut**.
- **Composants** : `NeonButton` (primary/secondary/ghost/danger), `PixelPanel`, `PlayerCard`, `StatTile`, `StatusPill`, `Stepper`, `Dropzone`, `ProgressBar` (segmentée façon barre de vie), `Terminal` (console + flux), `Modal`, `Toast`, `Tooltip`, `Toggle`, `Segmented`, `Select`/`Combobox`, `Slider`, `WeightSlider`, `Badge`, `TrustBadge`, `EmptyState`, `CRTOverlay`, `BootScreen`, `CopyField`.
- **Accessibilité** : contraste ≥ 4.5:1 pour le texte, focus visible néon, navigation complète au clavier, `aria-*` sur les contrôles, libellés sur les boutons-icônes, textes alternatifs.
- **Fenêtre** : 1280×800 par défaut, minimum 1024×680, barre de titre personnalisée (`titleBarStyle: 'hidden'` avec zones de drag et boutons natifs via `titleBarOverlay`, sous Windows et Linux).
- **Identité** : logo original (chèvre pixel + îlots, néon violet/jaune), icône d'app dérivée ; aucune ressource d'archipelago.gg.

### 4.4 Internationalisation

- i18next, fichiers `fr.json` / `en.json` avec les mêmes clés (test qui vérifie la parité).
- Langue initiale = `app.getLocale()` (fr* → FR, sinon EN), changeable à chaud.
- Le catalogue d'erreurs, les étapes de génération, les tiers de jeu et les textes d'aide sont tous traduits. Les noms de jeux, d'objets et les sorties brutes d'AP restent en anglais.
- Formats de nombres, dates et tailles via `Intl`.

---

## 5. Gestion des erreurs

- **`AppError`** : `{ code, params, detail?, logPath? }`. Le renderer affiche `t('errors.<code>', params)` et propose l'action associée. Le détail technique est repliable ; le log complet est accessible par un bouton.
- **`error-catalog.ts`** : regex sur la sortie d'AP → code + action. Couvre au minimum les messages du brief §1.6 :
  - YAML invalide (avec ligne/colonne) ;
  - `No world found to handle game X` (+ suggestion) ;
  - `No game options for selected game` ;
  - quantity désactivée ;
  - version requise ;
  - plando non activé ;
  - noms non uniques ;
  - FillError (« injouable », « plus de place », « pas assez de locations ») ;
  - ROM manquante ou hash incorrect ;
  - multidata incompatible ;
  - port occupé ;
  - « No .archipelago found in archive ».
- **Processus** : délais de garde, détection de sortie anormale, code de sortie + dernières lignes conservées. Aucun processus AP n'est lancé si son pré-vol peut prédire une boîte de dialogue cachée (ROM, APWorld corrompu).
- **Réseau** : timeouts, réessais avec backoff pour les GET idempotents uniquement, mode hors-ligne explicite (catalogue en cache, installation impossible signalée), rate-limit GitHub expliqué.
- **Fichiers** : écritures atomiques, sauvegardes avant modification des réglages d'AP, aucune suppression définitive sans confirmation (déplacement vers `backups/`).
- **Crash du renderer** : error boundary par écran avec bouton « Recharger l'écran » ; crash du main → log + dialogue de redémarrage.

---

## 6. Sécurité et confidentialité

### 6.1 Electron

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- CSP stricte : `default-src 'self'`, pas d'`eval`, pas de scripts distants. Les images distantes du catalogue (boxart du wiki) passent par `img-src` limité à `https://static.wikitide.net` et `https://archipelago.miraheze.org` ; sinon pas d'image.
- Navigation et `window.open` bloqués ; liens externes ouverts via `shell.openExternal` après vérification d'une liste blanche de domaines (archipelago.gg, github.com, archipelago.miraheze.org, tasvideos.org, etc.).
- Toutes les entrées IPC validées par zod ; les chemins de fichiers reçus du renderer sont vérifiés (existence, type, pas de traversée vers des zones sensibles).

### 6.2 Contenus tiers

- **APWorlds** : écran de confiance obligatoire, hash vérifié quand disponible, aucune mise à jour silencieuse, jamais exécutés par l'app.
- **Uploads archipelago.gg** : dialogue de consentement à chaque hébergement web, qui précise que le zip contient les mots de passe en clair et que la room est accessible à quiconque a le lien.
- **ROMs** : jamais téléchargées, liées, copiées ailleurs que là où l'utilisateur les a mises (sauf patch produit par AP dans `rooms/`), ni envoyées.
- **Téléchargements** : sha256 vérifié, stockés hors des dossiers exécutés automatiquement.
- **Processus** : jamais lancés en élevé, sauf l'installateur officiel d'AP (UAC visible).

### 6.3 Secrets

- Coffre `safeStorage` ; jamais dans les logs, `session.json`, captures ou bundles de support (`redact.ts` appliqué à tout ce qui sort).
- L'UUID de session archipelago.gg est traité comme un mot de passe.

---

## 7. Tests et vérification

### 7.1 Unitaires (Vitest, sans Electron)

- `locator` (résolution de chemins sur arborescences simulées, Windows/Linux/AppImage, fichier de réglages effectif).
- `releases` (sélection d'assets, RC, digest).
- `template-parser` sur de **vrais templates** d'AP 0.6.8 (fixtures récupérées depuis `archipelago.gg/static/generated/configs/` pour un échantillon d'au moins 10 jeux variés).
- `validate` (chaque règle de §3.10, YAML valides/invalides), `writer` (aller-retour : écrire → relire en YAML 1.1 → valeurs identiques).
- `apworld` (zips valides, sans manifeste, corrompus, traversée, zip bomb), `inventory` (prédiction du monde chargé).
- `patch` / `router` (manifests réels de patchs fabriqués en fixture), `roms` (MD5 avec règles d'en-tête).
- `log-patterns`, `error-catalog` (sorties réelles d'AP en fixture), `redact`.
- `webhost/client` contre le faux serveur.
- Parité des clés i18n FR/EN.
- Couverture visée ≥ 80 % sur `core/`.

### 7.2 Intégration

- **Faux exécutables AP** (`tests/fake-ap/*.mjs`, lancés via `node`) qui reproduisent :
  - les lignes de progression, puis le blocage sur stdin en cas d'erreur ;
  - le serveur : ligne `Hosting game at` avant `server listening on`, ignore l'EOF, s'arrête sur `/exit` en écrivant un `.apsave` ;
  - la sortie bufferisée ;
  - le port occupé.
- **Faux archipelago.gg** (`tests/mock-webhost/`) : `/uploads` (302), `/new_room` (302), `/room`, `/api/room_status` (port à 0 puis attribué), `/log` avec `Range`, cookie de session, erreurs HTML.
- Parcours complets : session → génération → hébergement local → console → arrêt ; session → upload → room → port ; rejoindre → patch → routage.

### 7.3 E2E (Playwright + Electron)

- Lancement de l'app packagée et non packagée ; chaque écran visité en FR et EN ; captures d'écran archivées dans `tests/e2e/screenshots/`.
- Vérifications : aucune erreur console, navigation clavier sur l'accueil et l'assistant, `prefers-reduced-motion` respecté.
- Linux : exécution dans Docker sous `xvfb`.

### 7.4 Tests réels (avec accord explicite de l'utilisateur, au moment voulu)

1. Installer réellement AP 0.6.8 sur la machine Windows de l'utilisateur (UAC, `C:\ProgramData\Archipelago`) via l'app.
2. Générer une partie locale avec 2-3 YAML de jeux core sans ROM, l'héberger, se connecter avec `ArchipelagoTextClient`, envoyer des commandes, arrêter proprement, vérifier le `.apsave`.
3. Optionnel : un upload réel sur archipelago.gg (crée une room réelle).
4. Linux : installation gérée tar.gz + génération + serveur dans un conteneur.

Aucun de ces tests n'est lancé sans un « oui » explicite.

---

## 8. Build et distribution

- **electron-builder**
  - `appId: com.archipelagoat.app`, `productName: ArchipelaGOAT`.
  - Windows :
    - `nsis` : par utilisateur (`perMachine: false`), `oneClick: false`, choix du dossier, raccourcis.
    - `portable`.
    - Artefacts : `ArchipelaGOAT-Setup-<ver>.exe`, `ArchipelaGOAT-<ver>-portable.exe`.
  - Linux :
    - `AppImage`, `deb`, `tar.gz`.
    - `.desktop` avec `MimeType=x-scheme-handler/archipelago;`.
    - Catégorie `Game`.
  - `protocols: archipelago` déclaré (utilisé sous Linux ; sous Windows seulement si l'option HKCU est activée par l'utilisateur).
  - `files` minimal, `asar: true`, source maps exclues du package.
- **Linux depuis Windows** : `docker run --rm -v <projet>:/project -v archipelagoat-node-modules:/project/node_modules electronuserland/builder:<tag> bash -c "npm ci && npm run dist:linux"` (node_modules isolés dans un volume pour ne pas mélanger les binaires Windows/Linux).
- **Scripts npm** : `dev`, `build`, `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `dist:win`, `dist:linux`, `dist:linux:docker`, `icons`.
- **CI GitHub Actions** (prête, non poussée) :
  - `ci.yml` : lint, typecheck et tests sur ubuntu et windows.
  - `release.yml` : sur tag `v*`, matrice windows-latest/ubuntu-latest, `electron-builder --publish always` vers une release brouillon.
- **Auto-update** : `electron-updater` (provider GitHub) branché mais **inactif** tant qu'aucun dépôt n'est configuré ; l'écran « À propos » l'indique.
- **Signature** : non signée en v1. SmartScreen affichera « Windows a protégé votre ordinateur » → « Informations complémentaires » → « Exécuter quand même » ; documenté dans le README. Configuration prête pour un certificat ultérieur.
- **Livrables locaux** : dossier `release/<ver>/` avec les binaires Windows et Linux + `SHA256SUMS.txt`.

---

## 9. Décisions ouvertes (non bloquantes pour l'implémentation)

1. **Automatisation d'archipelago.gg** : le site est géré par des bénévoles ; il est recommandé que l'utilisateur prévienne les mainteneurs (Discord officiel) avant toute diffusion publique. L'app reste en mode « consentement à chaque action » et utilise un User-Agent identifiable.
2. **Signature de code** (budget OV/EV) avant diffusion publique.
3. **Publication** du dépôt GitHub et des releases : sur demande explicite uniquement.
4. **Catalogue agrégé** (`catalog.json` servi par GitHub Pages pour éviter la limite de 60 req/h) : v1.2, nécessite un dépôt public.
5. **Permission** des mainteneurs de l'index ionium et attribution détaillée.

---

### 9.1 Écarts assumés de la v1 (décidés pendant la planification)

- **Téléchargements** (§3.3) : pas de reprise par `Range` en v1 ; un téléchargement interrompu repart de zéro.
- **Réglages verrouillés** (§3.6) : quand un programme AP tourne, l'écriture échoue avec un message clair (`SETTINGS_LOCKED`, avec la liste des processus) au lieu d'être mise en file d'attente.
- **Schéma d'options** (§3.10) : pas de type `counter` distinct ; ces options sont éditées comme `dict`.
- **Statuts de session** (§3.13) : pas de statut `validated` ; la validation est recalculée à la demande.
- **Mots de passe du serveur** (§3.11) : transmis par le `host.yaml` de session, jamais en argument de ligne de commande.

## 10. Critères d'acceptation v1

- [ ] Sur une machine Windows sans AP, l'app installe AP 0.6.8 avec une seule invite UAC et le détecte ensuite (version, chemins).
- [ ] Sous Linux (conteneur), l'app installe AP via tar.gz sans root ni FUSE, et lance `ArchipelagoGenerate`.
- [ ] Le diagnostic signale : APWorld corrompu (bloquant), sans manifeste (alerte 0.7.0), port 38281 occupé, processus AP ouvert.
- [ ] Le catalogue liste les mondes de l'index ionium filtrés pour 0.6.8 ; l'installation d'un monde passe par l'écran de confiance, vérifie le sha256 et place le fichier sous `<dossier>.apworld`.
- [ ] Le Studio YAML produit, pour au moins 10 jeux core, un YAML que la validation accepte et qu'AP génère sans erreur (vérifié lors du test réel).
- [ ] L'assistant de partie refuse de générer tant qu'il reste une erreur, et affiche chaque erreur avec son action.
- [ ] La génération affiche une progression réelle et ne bloque jamais (stdin fermé), succès comme échec.
- [ ] L'hébergement local devient « prêt » sur `server listening on`, la console envoie des commandes, l'arrêt via `/exit` produit un `.apsave`.
- [ ] L'hébergement archipelago.gg fonctionne de bout en bout contre le faux serveur ; consentement affiché avant upload.
- [ ] Rejoindre depuis une URL de room télécharge le bon patch et route vers le bon client ; un jeu BizHawk se lance en un clic quand ROM et BizHawk sont prêts.
- [ ] Le coffre ROM reconnaît les ROMs par MD5 (règles d'en-tête comprises) et écrit les clés `host.yaml`.
- [ ] FR et EN complets (parité testée), langue changeable à chaud.
- [ ] Aucune fenêtre console ne s'ouvre pendant l'utilisation normale.
- [ ] Aucun secret dans les logs ou le bundle de support (test dédié).
- [ ] `ArchipelaGOAT-Setup-<ver>.exe`, le `.exe` portable, l'AppImage, le `.deb` et le `tar.gz` sont produits et démarrent.
- [ ] Tests unitaires, d'intégration et E2E au vert ; lint et typecheck propres.
