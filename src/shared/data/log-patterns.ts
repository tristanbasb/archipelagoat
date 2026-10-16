// Regular expressions over the lines Archipelago 0.6.8 prints, to follow a generation (progress bar,
// final archive) and a local server (ready, hosting address, who joins, what is found). Every pattern
// names the source line it matches. The tests read the captured outputs in tests/fixtures/ap-output.
//
// Lines can start with a `[YYYY-MM-DD HH:MM:SS] ` timestamp (`--log_time` / `--logtime`), so every
// pattern takes it as optional. Patterns have no `g` or `y` flag: they are shared and never keep state.
import type { GenerateStageId } from '../codes'
import type { ServerEvent } from '../types'

const TIMESTAMP = String.raw`(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] )?`

/** A pattern for a whole line (with its optional timestamp), `body` being regular expression source. */
const line = (body: string): RegExp => new RegExp(`^${TIMESTAMP}${body}`)

// --- Generation ---

/**
 * The steps of a generation in the order they are logged, with the progress they stand for (2 to
 * 100). The fill step is the long one: `FILL_STEP_RE` refines the bar between `fill` and the step
 * after it. A line matches at most one stage; stages a run skips (no playthrough with spoiler 1, for
 * instance) simply never show up.
 */
export const GENERATE_STAGES: { id: GenerateStageId; re: RegExp; percent: number }[] = [
  { id: 'init', re: line(String.raw`Archipelago \([^)]*\) logging initialized on `), percent: 2 }, // Utils.py:615
  { id: 'weights', re: line(String.raw`(?:P\d+ )?Weights: `), percent: 4 }, // Generate.py:107,162
  { id: 'generating', re: line(String.raw`Generating for \d+ players?, `), percent: 6 }, // Generate.py:179
  { id: 'worlds', re: line(String.raw`Found \d+ World Types:`), percent: 8 }, // Main.py:54
  { id: 'creating', re: line(String.raw`Creating MultiWorld\.`), percent: 12 }, // Main.py:111
  { id: 'items', re: line(String.raw`Creating Items\.`), percent: 16 }, // Main.py:114
  { id: 'rules', re: line(String.raw`Calculating Access Rules\.`), percent: 20 }, // Main.py:117
  { id: 'plando', re: line(String.raw`Running Item Plando\.`), percent: 24 }, // Main.py:187
  { id: 'prefill', re: line(String.raw`Running Pre Main Fill\.`), percent: 28 }, // Main.py:192
  { id: 'fill', re: line(String.raw`Filling the multiworld with \d+ items\.`), percent: 32 }, // Main.py:196
  {
    id: 'balancing',
    // Main.py:208, Fill.py:1487 and Fill.py:1489
    re: line(
      String.raw`(?:Balancing multiworld progression for \d+ Players\.|Progression balancing skipped\.|Skipping multiworld progression balancing\.)`,
    ),
    percent: 60,
  },
  { id: 'preoutput', re: line(String.raw`Running pre-output steps\.`), percent: 66 }, // Main.py:210
  { id: 'output', re: line(String.raw`Beginning output\.\.\.`), percent: 70 }, // Main.py:222
  { id: 'output-files', re: line(String.raw`Generating output files \(\d+/\d+\)\.`), percent: 76 }, // Main.py:374
  { id: 'playthrough', re: line(String.raw`Calculating playthrough\.`), percent: 84 }, // Main.py:378
  { id: 'archive', re: line(String.raw`Creating final archive at `), percent: 94 }, // Main.py:385
  { id: 'done', re: line(String.raw`Done\. Enjoy\. Total Time: `), percent: 100 }, // Main.py:391
]

/** `Current fill step (<name>) at <done>/<total> items placed.` (Fill.py:26), every 1000 items. */
export const FILL_STEP_RE = line(
  String.raw`Current fill step \((?<name>.+?)\) at (?<done>\d+)/(?<total>\d+) items placed\.`,
)

/** `Creating final archive at <abs path>` (Main.py:385): the zip `path` is the result of a generation. */
export const FINAL_ARCHIVE_RE = line(String.raw`Creating final archive at (?<path>.+?)\s*$`)

// --- Local server ---

/**
 * The server accepts connections: the websockets INFO line `server listening on <host>:<port>`, once
 * per bound address. It is logged after `Hosting game at`, which is logged BEFORE the bind, so the
 * hosting line alone never means ready (brief 1.7).
 */
export const SERVER_READY_RE = line(String.raw`server listening on (?<host>.+):(?<port>\d+)\s*$`)

/**
 * `Hosting game at <ip>:<port> (No password|Password: <pw>)` (MultiServer.py:2852). The password is
 * deliberately not captured: it has no business in a group.
 */
export const SERVER_HOSTING_RE = line(
  String.raw`Hosting game at (?<host>.+):(?<port>\d+) \((?:No password|Password: .*)\)\s*$`,
)

/**
 * Lines of a running server that are events, with the named groups each one gives. They are tried in
 * order and the first match wins: `chat` is the last because it only looks for `Notice (all): <who>: <text>`.
 * Join, leave, goal and chat lines are `Notice (all): ...` broadcasts (MultiServer.py:476), the item
 * line is a plain log line.
 */
export const SERVER_EVENT_PATTERNS: { kind: ServerEvent['kind']; re: RegExp }[] = [
  {
    // MultiServer.py:1056-1059: `<name> (Team #1) playing|tracking|hinting|viewing <game> has joined. Client(x.y.z), [tags].`
    kind: 'join',
    re: line(
      String.raw`Notice \(all\): (?<player>.+?) \(Team #(?<team>\d+)\) (?:playing|tracking|hinting|viewing) (?<game>.+?) has joined\. Client\(`,
    ),
  },
  {
    // MultiServer.py:1087-1089: `... has left the game.` or `... has stopped tracking|hinting|viewing the game.`
    kind: 'leave',
    re: line(
      String.raw`Notice \(all\): (?<player>.+?) \(Team #(?<team>\d+)\) has (?:left|stopped (?:tracking|hinting|viewing)) the game\. Client\(`,
    ),
  },
  {
    // MultiServer.py:1239: `(Team #1) <finder> sent <item> to <receiver> (<location>)`
    kind: 'item',
    re: line(
      String.raw`\(Team #(?<team>\d+)\) (?<player>.+?) sent (?<item>.+) to (?<receiver>.+?) \((?<location>.+)\)\s*$`,
    ),
  },
  {
    // MultiServer.py:946-947
    kind: 'goal',
    re: line(String.raw`Notice \(all\): (?<player>.+?) \(Team #\d+\) has completed their goal\.\s*$`),
  },
  {
    // MultiServer.py:2324
    kind: 'all-goals',
    re: line(
      String.raw`Notice \(all\): Team #(?<team>\d+) has completed all of their games! Congratulations!\s*$`,
    ),
  },
  {
    // MultiServer.py:1512 (a player) and :2342 (the host, as `[Server]`)
    kind: 'chat',
    re: line(String.raw`Notice \(all\): (?<player>(?:(?! \(Team #).)+?): (?<message>.+?)\s*$`),
  },
]
