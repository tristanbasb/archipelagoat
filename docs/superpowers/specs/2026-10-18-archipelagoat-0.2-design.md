# ArchipelaGOAT 0.2 — Spécification de conception

- Date : 2026-10-18
- Statut : design validé section par section en conversation ; spec à relire par l'utilisateur.
- S'appuie sur la spec v1 (`2026-10-16-archipelagoat-design.md`) : architecture, contrat IPC, tâches, design system « Arcade néon », i18n, règles de sécurité. Ce document ne décrit que ce qui change.
- Version visée : **0.2.0**, qui livre aussi la v1.1 et les jeux du wiki seul (déjà sur `main`).

## 1. Compréhension et objectifs

### 1.1 Ce que veut l'utilisateur (dit)

« Dans la prochaine version : les images des jeux, des YAML déjà prêts, la possibilité de connaître le nombre de checks d'un jeu pour adapter, et un one click install. »

Réponses aux questions de cadrage :

| Question | Réponse |
|---|---|
| One click install | **Un jeu prêt en 1 clic** : sur la fiche d'un jeu, un bouton installe l'APWorld et crée un YAML prêt à jouer avec un profil ; l'écran de confiance reste, réduit à une confirmation. |
| Nombre de checks, pour adapter quoi | **Équilibrer les joueurs** d'une session : voir les checks de chacun et recevoir des réglages qui rapprochent les durées. |
| Source des YAML prêts | **Profils ArchipelaGOAT** (Découverte, Standard, Complet) construits automatiquement à partir des options de chaque jeu. |
| Destination du YAML créé | **Au choix à chaque fois** : ajouter à une session, enregistrer le fichier, ou ouvrir dans le Studio. |
| Comptage des checks | **Hybride** : estimation instantanée sur les fiches (datapackage), chiffres exacts par génération de test. |

### 1.2 Faits vérifiés pendant la conception (2026-10-18)

- **Jaquettes du wiki** : 815 des 965 pages d'implémentation ont une image dans leur infobox (item `media`, `source: "boxart"`, `isImage: true`), lue dans `pageprops.infoboxes` que `fetchWiki` récupère déjà. Hôtes : `static.wikitide.net` (812, URL relatives au protocole `//…`) et `upload.wikimedia.org` (3). Chaque item donne `url`, `thumbnail` (300 px), `width`, `height`.
- **Datapackage** : `GET https://archipelago.gg/api/datapackage` répond 200, 11 Mo, 82 jeux ; `games[<jeu>].location_name_to_id` donne toutes les locations possibles (Hollow Knight 740, A Link to the Past 286, Ocarina of Time 1623). C'est un maximum, pas un compte réel.
- **Le spoiler ne convient pas** : sa section `Locations:` inclut les événements (`Defeated_Collector (Knight): Defeated_Collector (Knight)`). Hollow Knight par défaut : 1389 lignes pour 203 vrais checks.
- **Le `.archipelago` donne le compte exact** : 1 octet de version (3 pour AP 0.6.8) puis un pickle compressé zlib (protocole 4). Clés : `checks_in_area, connect_names, datapackage, er_hint_data, locations, minimum_versions, precollected_hints, precollected_items, race_mode, seed_name, server_options, slot_data, slot_info, spheres, tags, version`. `locations[slot]` = les checks du slot (`{location_id: (item_id, player, flags)}`), sans événements. Opcodes rencontrés : `PROTO FRAME EMPTY_DICT EMPTY_LIST EMPTY_SET EMPTY_TUPLE MARK SETITEM SETITEMS APPEND APPENDS ADDITEMS TUPLE TUPLE1 TUPLE2 TUPLE3 BININT BININT1 BININT2 SHORT_BINUNICODE MEMOIZE BINGET LONG_BINGET NONE NEWFALSE STACK_GLOBAL NEWOBJ REDUCE STOP` ; globals : `NetUtils.NetworkSlot`, `NetUtils.SlotType`.
- **Mesure d'un joueur seul** : `ArchipelagoGenerate --player_files_path <p> --outputpath <o> --spoiler 0 --seed 42 --skip_prog_balancing` sur le modèle Hollow Knight : exit 0 en ~0,5 s de génération, 203 checks — le même compte qu'en multiworld (Hollow Knight + A Short Hike : 203 et 131). Le nombre de checks d'un monde ne dépend que de ses propres options.
- Le multidata contient aussi `datapackage[<jeu>]` : le maximum des jeux custom est connu dès qu'ils ont été générés une fois.
- L'app n'a pas encore de nom de joueur dans ses réglages ; `session:addText` et `session:replaceFile` existent ; le Launcher sait régénérer les modèles (`Generate Template Options`, `ap/templates`).

### 1.3 Critères de succès

1. Les cartes du catalogue, la liste des mondes installés, les joueurs d'une session et le sélecteur du Studio montrent la jaquette du jeu quand le wiki en a une, le sprite pixel sinon ; rien ne casse hors ligne.
2. La fiche d'un jeu officiel affiche « jusqu'à N checks » sans attendre ; après mesure, les chiffres des profils.
3. Dans une session, « Mesurer les checks » donne le compte exact de chaque joueur (fourchette si son YAML est aléatoire), signale les écarts à la cible et propose des réglages chiffrés qu'un clic applique.
4. « Jeu prêt » amène un jeu de l'index de rien à un YAML livré (session, fichier ou Studio) avec un seul dialogue et un clic de confirmation.
5. Toutes les vérifications passent (typecheck, lint, tests unitaires/renderer avec la barre de couverture, intégration, build, E2E) et le test réel sur AP 0.6.8 réussit.

### 1.4 Hors périmètre

- Installer automatiquement les mods, clients de jeu, PopTracker ou ROMs (l'app ne fournit jamais de ROM).
- Une bibliothèque de YAML communautaires ; des presets écrits à la main.
- Supprimer l'écran de confiance pour les mondes du wiki ou inconnus.
- Équilibrer automatiquement sans clic ; modifier un YAML sans montrer le diff.
- Images d'autres sources (SteamGridDB, IGDB : clés d'API, conditions d'usage).

## 2. Architecture

### 2.1 Nouveaux modules (main/core)

| Module | Rôle | Dépend de |
|---|---|---|
| `covers/covers.ts` | Jaquettes : URL depuis le wiki, téléchargement vérifié, cache disque, protocole `goat-cover://` | `catalog` (pages du wiki), `http` |
| `checks/datapackage.ts` | Table « jeu → maximum de locations » depuis archipelago.gg et depuis les multidata | `http` |
| `checks/multidata.ts` | Lecteur du `.archipelago` (pickle de données seulement) | — (pur) |
| `checks/measure.ts` | Génération de test d'un joueur seul, lecture du compte, cache | `ap/process`, `ap/generate` (arguments, réglages), `multidata`, `tasks` |
| `checks/balance.ts` | Cible, écarts, variantes d'options, combinaisons, propositions | `measure`, `ap/templates` (schéma), `yaml/writer` |
| `profiles/profiles.ts` | Profils Découverte / Standard / Complet d'un jeu, cache | `ap/templates`, `measure`, `yaml/validate`, `yaml/writer` |
| `ready/ready.ts` | Orchestration « Jeu prêt » : installation, modèles, profil, validation, livraison | `worlds/install`, `ap/templates`, `profiles`, `sessions`, `studio` |

Chaque module reçoit le `CoreContext` injecté et ses dépendances par paramètres, comme les modules v1 ; chacun se teste seul avec des fakes.

### 2.2 Données de l'app (`dataRoot`)

- `covers/<sha256 de l'URL>.<ext>` + `covers/index.json` (URL, type, taille, dernier accès). Plafond 100 Mo, éviction des moins récemment vues.
- `checks/datapackage.json` : `{ fetchedAt, etag, games: { [jeu]: { max: number, checksum: string | null } } }` (quelques Ko).
- `checks/measures.json` : cache des mesures, clé = `jeu` + `version du monde` (manifeste, ou version d'AP pour un monde officiel) + sha256 du YAML normalisé + graine → `{ checks, measuredAt }`.
- `profiles/<fichier sûr du jeu>.json` : profils calculés, clé = jeu + version du monde + empreinte du modèle d'options.
- Dossiers temporaires de mesure : `tmp/measure-<uuid>/`, supprimés après chaque mesure et au démarrage.

### 2.3 Contrat IPC (nouveaux canaux)

| Canal | Entrée | Sortie |
|---|---|---|
| `covers:get` | `{ game }` | `{ url: string \| null }` (`goat-cover://…` si en cache ou téléchargée, null sinon) |
| `checks:estimate` | `{ games: string[] }` | `{ [jeu]: { max: number \| null, profiles: ProfileCounts \| null } }` |
| `checks:measureSession` | `{ sessionId }` | `TaskRef` (résultat : `SessionChecks`) |
| `checks:suggest` | `{ sessionId, fileId, target }` | `TaskRef` (résultat : `BalanceProposal[]`) |
| `checks:apply` | `{ sessionId, fileId, proposalId }` | `{ file }` (YAML réécrit via `session:replaceFile`) |
| `profiles:get` | `{ game }` | `GameProfiles` (calculés ou heuristiques, `measured: boolean`) |
| `ready:prepare` | `{ entryId }` | `ReadyPlan` (confiance, profils, destinations, « À savoir ») |
| `ready:run` | `{ planId, profile, playerName, destination, update }` | `TaskRef` (résultat : `ReadyOutcome`) |

Types partagés (src/shared/types.ts) : `ProfileId = 'discovery' | 'standard' | 'complete'`, `ProfileCounts`, `GameProfiles { game, profiles: { id, changes: OptionChange[], checks: number | null, range: [number, number] | null }[], measured }`, `SessionChecks { target, players: { fileId, name, game, checks, range, status: 'ok' | 'error' | 'estimated', error? }[] }`, `BalanceProposal { id, changes: OptionChange[], checks, diff }`, `ReadyPlan`, `ReadyDestination = { kind: 'session', sessionId: string | 'new' } | { kind: 'file' } | { kind: 'studio' }`, `ReadyOutcome`.

### 2.4 Tâches et réglages

- Nouveaux types de tâche : `measure` (étapes `prepare`, `generate`, `read`, `done`), `ready` (étapes `download`, `inspect`, `install`, `templates`, `profile`, `validate`, `deliver`, `done`). Chaque étape est traduite (garde i18n de `TASK_STAGES`).
- Réglages : `playerName: string` (vide par défaut ; le YAML prend alors `Player{number}`), `readyDestination` (dernière destination choisie).

## 3. Modules

### 3.1 `covers` — images des jeux

- **URL** : `parseWikiPages` lit aussi le premier item `media` avec `isImage: true` de l'infobox (de préférence `source: "boxart"`) et garde sa `thumbnail` (300 px), sinon son `url` ; les URL `//…` deviennent `https://…`. L'entrée de catalogue gagne `cover: string | null` (URL distante), pour les entrées de l'index jointes au wiki comme pour celles du wiki seul. Le catalogue sauvegardé passe à la version suivante.
- **Téléchargement** : seulement `https://static.wikitide.net/…` et `https://upload.wikimedia.org/…` ; 2 Mo au plus ; la réponse doit commencer par la signature d'un PNG, JPEG, WebP ou GIF (le `Content-Type` seul ne suffit pas) ; délai 20 s ; jamais plus de 4 téléchargements à la fois.
- **Cache** : `covers/` (2.2). Une URL déjà en cache n'est plus redemandée ; si l'URL du wiki change, la nouvelle remplace l'ancienne.
- **Protocole** : `goat-cover://<clé>` enregistré dans le main (`protocol.handle`), ne sert que les fichiers de `covers/`, avec le bon type MIME. La CSP du renderer remplace `https://static.wikitide.net https://archipelago.miraheze.org` par `goat-cover:` dans `img-src` (vérifier d'abord qu'aucun autre usage n'en dépend) : le renderer ne charge toujours aucune URL distante.
- **After Dark** : `covers:get` ne sert la jaquette d'un jeu After Dark que si `showAfterDark` est actif.
- **Échec** : silencieux (journalisé) ; le composant affiche le sprite pixel actuel. Hors ligne, le cache suffit.
- **Attribution** : les crédits du wiki (CC BY-NC-SA 4.0, À propos et pied du catalogue) mentionnent aussi les images.

### 3.2 `checks/datapackage` — estimation

- Télécharge `https://archipelago.gg/api/datapackage` au plus une fois par semaine (ETag via `http`), 32 Mo au plus, vérifie la forme avec zod, ne garde que `{ max: nombre de clés de location_name_to_id, checksum }` par jeu.
- Complète la table avec le `datapackage` de chaque multidata lu (mesure ou vraie génération) : les jeux custom y entrent dès leur première génération.
- `checks:estimate` répond depuis cette table et depuis les profils en cache, sans réseau.

### 3.3 `checks/multidata` — lecteur du `.archipelago`

- Entrée : les octets du fichier. Vérifie l'octet de version (3 connu ; une autre valeur donne une erreur claire), décompresse avec `zlib.inflateSync` et `maxOutputLength` = 256 Mo.
- Décodeur pickle en TypeScript, protocoles 2 à 5, **liste fermée** d'opcodes : ceux de 1.2 plus `BINUNICODE`, `BINUNICODE8`, `SHORT_BINBYTES`, `BINBYTES`, `BINFLOAT`, `LONG1`, `NEWTRUE`, `FROZENSET`, `DICT`, `LIST`, `TUPLE`, `BUILD`, `PUT`, `BINPUT`, `LONG_BINPUT`, `GLOBAL`, `NEWOBJ_EX`. Tout autre opcode arrête la lecture avec une erreur.
- `STACK_GLOBAL` / `GLOBAL` ne résolvent jamais rien : ils produisent un marqueur `{ module, name }` ; `REDUCE`, `NEWOBJ`, `BUILD` produisent un objet opaque `{ class, args, state }`. Aucun appel, aucune évaluation. Profondeur maximale 64, mémo borné.
- Sortie utile : `{ version, slots: { slot, name, game, checks }[], datapackage: { [jeu]: { max, checksum } } }`, avec `checks = taille de locations[slot]` et le nom et le jeu tirés de `slot_info` (objets `NetworkSlot`, champs `name`, `game` dans leurs arguments) ou, à défaut, de `connect_names`.

### 3.4 `checks/measure` — mesure exacte

- Mesure **un joueur seul** : copie son YAML dans `tmp/measure-<uuid>/players/`, prépare les mêmes réglages que la génération de la session (fichier de réglages de session, chemins des ROM du coffre), lance `ArchipelagoGenerate --player_files_path … --outputpath … --spoiler 0 --seed <graine> --skip_prog_balancing` (stdin ignoré, sans fenêtre, sortie UTF-8), délai 2 min, annulation = arrêt du processus. Succès : exit 0 et la ligne `Creating final archive at` ; lit le `.archipelago` dans le zip ; supprime le dossier.
- Graine fixe (42) ; si le YAML contient des options pondérées (plus d'un choix de poids non nul, ou `random*`), 3 graines (42, 1337, 2026) et une fourchette.
- Cache (2.2) : une mesure identique n'est jamais relancée.
- Session : mesure tous les joueurs, 2 à la fois au plus ; un échec n'affecte que son joueur, avec l'erreur Archipelago traduite comme pour une génération (`matchApError`). Un jeu qui exige une ROM à la génération sans ROM dans le coffre donne `AP_ROM_MISSING` et le joueur garde l'estimation.
- Après une vraie génération de la session, les comptes sont relus depuis son `.archipelago` (aucune mesure de plus).

### 3.5 `checks/balance` — équilibrage

- Cible : médiane des comptes mesurés ; l'organisateur peut choisir court (≈ 0,6 × médiane), moyen (médiane), long (≈ 1,5 × médiane) ou un nombre. Écart signalé au-delà de ±25 %.
- Candidats : options du schéma du jeu (`ap/templates`) dont le nom ou le type suggère la taille : `*sanity*`, `shuffle_*`, `randomize_*`, `*_count`, `number_of_*`, `*locations*`, `*checks*`, `goal`, `include_*` / `exclude_*`, plages numériques. Exclues : les options communes (`progression_balancing`, `accessibility`, `local_items`, `non_local_items`, `start_inventory*`, `start_hints`, `start_location_hints`, `exclude_locations`, `priority_locations`, `item_links`, `plando_*`, `death_link`).
- Variantes : une option à la fois, vers la valeur qui va dans le sens voulu (choix suivant/précédent, bascule, borne de plage) ; 12 au maximum par joueur, mesurées avec `measure` (cache). Puis combinaison gloutonne de 3 changements au plus, vérifiée par une mesure.
- Propositions : 1 à 3, triées par distance à la cible, chacune avec ses changements, son compte mesuré et le diff du YAML. `checks:apply` réécrit le YAML du joueur avec `yaml/writer` (commentaires et ordre conservés comme le Studio le fait), le valide, puis `session:replaceFile`. Rien sans clic.
- Aucun candidat utile : la réponse le dit (« aucune option de ce jeu ne change sa taille »).

### 3.6 `profiles` — Découverte, Standard, Complet

- Base : le schéma d'options du jeu (`ap/templates`, modèle local régénéré au besoin, sinon celui du site). Sans schéma : `CHECKS_NO_SCHEMA`.
- **Standard** : les valeurs par défaut, `death_link` désactivé s'il existe.
- **Découverte** : options de taille (mêmes candidats que 3.5) vers moins de checks ; options de difficulté (`*difficulty*`, `logic*`, `*glitch*`, `*trick*`) vers le choix le plus facile reconnu (`easy`, `casual`, `beginner`, `normal`, `none`, `off`, `no_glitches`, `vanilla`), sinon inchangées ; pièges (`*trap*` en pourcentage ou en bascule) à 0 / désactivés ; `death_link` désactivé. Visée : 50 à 60 % des checks du Standard quand c'est possible.
- **Complet** : options de taille vers plus de checks ; difficulté par défaut ; `death_link` désactivé.
- Calcul en deux temps : **heuristique** immédiate à partir des noms et des types ; **affinée** en arrière-plan avec `measure` (Standard, chaque candidat, 12 au maximum, puis chaque profil final), qui ne garde que les changements dont l'effet mesuré va dans le bon sens. Lancée après l'installation d'un monde ou à la première demande ; cache par jeu + version du monde + empreinte du modèle.
- Garde-fous : seules des options du schéma, avec des valeurs valides ; validation `yaml/validate` ; un profil identique au Standard est masqué ; chaque profil expose ses changements (`OptionChange { key, from, to }`) et ses checks (`null` = non mesuré).
- YAML produit : `name` = `playerName` des réglages ou `Player{number}`, `description: "ArchipelaGOAT · <profil>"`, `game`, puis la section du jeu.

### 3.7 `ready` — « Jeu prêt »

- `ready:prepare` construit le plan sans rien modifier : entrée du catalogue, état d'Archipelago (absent → le plan le dit), monde déjà installé ou à jour, niveau de confiance, profils (`profiles:get`), sessions en préparation, bloc « À savoir » (ROM requise, PopTracker, guide d'installation du wiki, programmes AP en cours).
- `ready:run`, une tâche `ready` :
  1. `download` / `inspect` / `install` : le parcours `worlds/install` existant (prepare puis confirm) ; sauté pour un monde officiel ou déjà installé (case « mettre à jour » si une version plus récente existe).
  2. `templates` : régénère les modèles si le jeu n'en a pas encore.
  3. `profile` : profil heuristique (ou affiné s'il est en cache) + **une** mesure pour afficher le vrai compte (sautée si impossible, sans échouer la tâche).
  4. `validate` : `yaml/validate` ; une erreur arrête la tâche.
  5. `deliver` : session → `session:addText` (ou création d'une session puis ajout) ; fichier → boîte d'enregistrement, nom par défaut `<joueur> - <jeu>.yaml` ; Studio → ouvre `/studio` avec ce brouillon.
- Chaque étape garde ce qui a réussi (un monde installé le reste) ; l'échec affiche l'erreur traduite et « Réessayer » reprend à l'étape en échec. Les erreurs de release du wiki gardent leurs boutons « Ouvrir la page » / « Choisir le fichier ».
- Confiance : monde officiel → rien à confirmer ; `indexed-verified` → une ligne d'information, le bouton principal vaut confirmation ; `wiki-release` / `unknown` → l'avertissement complet et la case à cocher actuels, dans le même dialogue.

## 4. Interface

- **Composant `GameCover`** : jaquette (`covers:get`) avec ratio fixe et coins du design system, chargement paresseux (visible à l'écran), repli sur `GameSprite`. Utilisé par les cartes du catalogue, la liste des mondes installés, les joueurs d'une session (StepPlayers, StepCheck) et le `GamePicker` du Studio.
- **Cartes du catalogue** : « jusqu'à N checks » (estimation) et, si connus, les checks des profils ; bouton principal **« Jeu prêt »** à côté d'« Installer » (qui reste pour installer sans YAML).
- **Dialogue « Jeu prêt »** : en-tête (jaquette, nom, source, confiance), bloc de confiance selon 3.7, segment Découverte / Standard / Complet avec leurs checks et la liste de leurs changements, nom du joueur, destination (radio : session — liste + « Nouvelle session » ; fichier ; Studio), case « mettre à jour » si utile, bouton « Installer et préparer » / « Préparer ». Progression de la tâche dans le dialogue ; écran final « Prêt ! » (confettis pixel existants), actions (ouvrir la session / le dossier / le Studio) et bloc « À savoir ».
- **Session, étape de vérification** : panneau « Checks » — ligne par joueur (jaquette, nom, jeu, checks ou fourchette, écart à la cible), sélecteur de cible, bouton « Mesurer les checks » (tâche `measure`), « Proposer des réglages » sur un joueur signalé → liste des propositions avec diff et « Appliquer ».
- **Studio** : le menu Presets gagne une section « Profils ArchipelaGOAT » au-dessus des presets du jeu.
- **Réglages** : champ « Nom du joueur ».
- FR + EN pour toutes les chaînes, même typographie que l'existant.

## 5. Erreurs

- Nouveaux codes : `CHECKS_NO_SCHEMA` (pas de modèle d'options : ni profils ni suggestions), `MEASURE_TIMEOUT` (génération de test au-delà de 2 min), `MULTIDATA_UNREADABLE` (version inconnue, opcode hors liste, fichier tronqué) avec `{ reason }`. Traduits dans les deux langues, actions associées dans `lib/errors.ts`.
- Mesures : erreurs Archipelago traduites existantes (`AP_ROM_MISSING`, `AP_YAML_INVALID`, `GENERATION_FAILED`, …).
- Images : jamais d'erreur visible (repli sur le sprite) ; datapackage indisponible : l'estimation est simplement absente.

## 6. Sécurité

- Images : hôtes autorisés, https, signature d'image, 2 Mo, servies par `goat-cover://` uniquement depuis `covers/` (aucun chemin hors du dossier), CSP sans hôte distant pour les images.
- Lecteur pickle : données seulement, liste fermée d'opcodes, aucune résolution de global, limites de taille et de profondeur ; testé contre des fichiers corrompus et hostiles (opcodes interdits, `GLOBAL os system`, profondeur, bombe zlib).
- Générations de test : seulement des mondes déjà installés (donc acceptés à l'écran de confiance), dossier temporaire dédié, stdin ignoré, délai, nettoyage ; jamais de sortie ailleurs que dans ce dossier.
- YAML : profils et propositions validés ; rien n'est réécrit sans clic ni diff.
- Datapackage : 32 Mo maximum, schéma vérifié.
- Inchangé : aucun APWorld exécuté par l'app elle-même, aucun rehébergement, aucune ROM fournie, aucun upload sur archipelago.gg sans accord.

## 7. Tests et vérification

- **Unitaires** (fixtures réelles) : `multidata` sur un `.archipelago` réel d'AP 0.6.8 (Hollow Knight + A Short Hike, 2 slots, 203 / 131) et sur des fichiers corrompus ou hostiles ; `datapackage` sur un extrait réel ; `covers` (URL relatives, hôtes, signature, taille, cache, éviction, After Dark, protocole qui refuse les chemins hors dossier) ; `profiles` sur de vrais modèles d'AP 0.6.8 (Hollow Knight, A Short Hike, Ocarina of Time, Stardew Valley) ; `balance` avec un mesureur simulé (cible, écarts, variantes, combinaison, aucun candidat) ; `measure` avec un faux processus ; `ready` (orchestration, reprise après échec, destinations).
- **Intégration** : le faux `ArchipelagoGenerate` des tests écrit un vrai `.archipelago` (fixture) ; mesure de session de bout en bout.
- **Renderer** : `GameCover` (image, repli), dialogue « Jeu prêt » (confiance selon le niveau, profils, destinations, progression, « Prêt ! »), panneau Checks (mesure, écarts, propositions, appliquer), réglage du nom.
- **E2E** : « Jeu prêt » sur un jeu officiel avec le faux AP jusqu'à la session ; captures d'écran FR et EN.
- **Test réel** (avec accord, comme la Task 36) : sur AP 0.6.8, images du catalogue, mesure de 3 ou 4 jeux, une proposition d'équilibrage appliquée, « Jeu prêt » d'un jeu officiel et d'un jeu de l'index vers une session, génération et hébergement locaux. Aucun upload sur archipelago.gg.

## 8. Livraison

- **Vague 1** : `covers` + `GameCover` partout ; `checks/datapackage` + « jusqu'à N checks » ; réglage « Nom du joueur ».
- **Vague 2** : `checks/multidata`, `checks/measure`, panneau Checks, `checks/balance`, `profiles` (et le menu Presets du Studio).
- **Vague 3** : `ready` + dialogue « Jeu prêt » + destinations + « À savoir ».
- Puis : revue finale, test réel, version `0.2.0` dans `package.json` (et `homepage` → `https://github.com/tristanbasb/archipelagoat`), reconstruction des binaires Windows et Linux.
- Exécution par sous-agents, vague par vague, chaque tâche relue par un agent neuf. Commit et push uniquement sur demande ; le tag `v0.2.0` (qui déclenche la release GitHub) est demandé à part.

## 9. Écarts assumés et décisions ouvertes

- **Jaquettes** : images protégées hébergées par le wiki ; l'app les affiche comme le wiki, avec attribution, les met en cache localement et ne les redistribue jamais dans le paquet.
- **Profils heuristiques** : le repérage des options de difficulté repose sur leurs noms ; la liste visible des changements et la mesure de la taille en limitent les erreurs.
- **Mesure ≠ partie** : le compte est celui d'une graine (ou d'une fourchette sur 3) ; une vraie génération peut différer si le YAML est aléatoire.
- **Ouvert, non bloquant** : seuils exacts (±25 %, 50–60 %, 12 variantes) ajustables après le test réel.

## 10. Critères d'acceptation 0.2

1. Les jaquettes s'affichent pour les jeux qui en ont une sur le wiki, le sprite sinon ; hors ligne, le cache suffit ; aucune URL distante dans la CSP des images.
2. « jusqu'à N checks » s'affiche sur les fiches des jeux officiels sans requête au moment de l'affichage.
3. La mesure d'une session de 4 joueurs réels sur AP 0.6.8 donne des comptes égaux à ceux du `.archipelago` de la vraie génération des mêmes YAML.
4. Pour un joueur signalé, au moins une proposition chiffrée est donnée quand le jeu a des options de taille, et l'appliquer change le compte mesuré comme annoncé.
5. « Jeu prêt » sur un jeu de l'index produit, en un dialogue et un clic, un YAML valide dans la destination choisie ; les mondes du wiki gardent l'avertissement complet.
6. Toutes les vérifications de 1.3 (5) passent.
