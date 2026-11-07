/**
 * everything-search — pi extension wrapping the Everything search engine (es.exe).
 *
 * Recreates the CodingRookie98/everything-search skill (MIT) as native pi tools:
 *   - everything_search      : machine-wide instant file search (name/path/ext/size/date)
 *   - everything_grep        : content search over an Everything-index file list (grep-compatible output)
 *   - everything_folder_size : recursive folder size from the index (instant)
 *   - everything_syntax      : full Everything query syntax reference (bundled syntax.md)
 *   - everything_status      : es.exe + index freshness diagnostics
 *
 * Deploy: copy this folder to ~/.pi/agent/extensions/everything-search/
 * Requires (Windows): es.exe in PATH and the Everything app running (no Windows service).
 *
 * Implementation notes (verified live against es 1.1.0.37 + Everything 1.5.0.1423):
 *   - es.exe stdout uses the environment OEM codepage (lossy for non-ASCII).
 *     Results are therefore ALWAYS captured via -export-txt / -export-tsv /
 *     -export-csv (UTF-8) into a temp file, read, then deleted.
 *   - Sort direction must be hyphen-joined ("size-descending"); a space
 *     ("size descending") silently turns the direction into a second search
 *     term and returns no results. We always pass an explicit direction.
 *   - -n N fetches N items; pagination = fetch offset+limit, slice locally.
 *   - -get-result-count returns the total match count (unaffected by -n).
 *   - -get-total-size returns 2^64-1 for zero-result queries (1.5 beta bug) —
 *     guarded in totalSizeOf(): the sentinel string is reported as 0.
 *   - -export-tsv requires 1.5-era es.exe; on exit code 6 (unknown switch)
 *     details mode falls back to -export-csv + csvLineToTabs() so the
 *     extension also works with es.exe from the Everything 1.4 era.
 *   - -add-columns validates property names ("Error 4: Unknown column");
 *     only the live-verified COLUMN_ALLOWLIST is exposed to callers.
 *   - Several 1.5 search functions are inert or dead on this box: dupe-min/max/count/
 *     from and max-threads parse but remove NOTHING (you get an unfiltered set);
 *     to-number/to-integer/hex/si: and entity-OR return 0; child-count/child-file-
 *     count/descendant-count are folder-valued (a files-only partner is an empty
 *     intersection, not a dead term). Class table with counts:
 *     syntax.md, "Function support on this machine (re-measured 2026-11-04)".
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  decodeForScan,
  escapeControlCharsForDisplay,
  escapeForRegex,
  formatAnchoredLine,
} from "./grep-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYNTAX_REF: string = (() => {
  try {
    return readFileSync(join(__dirname, "syntax.md"), "utf-8");
  } catch {
    return "Everything query syntax reference unavailable (syntax.md not found next to index.ts).";
  }
})();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_FETCH = 2000;
const ES_TIMEOUT_MS = 30_000;
// The count and total-size calls run beside the list fetch, so they get a shorter leash than one.
// This number is what their timeout messages quote (round 18 F-18-1: a message that printed the
// 30 s constant for a 15 s call told the agent it had waited twice as long as it did), so it lives
// here instead of as four inline literals no message can follow.
const COUNT_TIMEOUT_MS = 15_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
// everything_status budgets. The -version probe is also run synchronously on the spawn path
// (esSupportsArgv), where an unbounded call froze the whole tool for the life of a hung Everything
// app; each of these is quoted by the message that fires when it is reached.
const STATUS_VERSION_TIMEOUT_MS = 5_000;
const STATUS_COUNT_TIMEOUT_MS = 10_000;
const STATUS_FRESH_TIMEOUT_MS = 10_000;
// Per-entry-walk PRICING count (the partner-join row count that prices a property walk); the
// sole non-constant budget left after round 151 F-8 named the folder-size literals.
const WALK_PRICE_TIMEOUT_MS = 5_000;
const WHERE_TIMEOUT_MS = 2_000;
/** Whole seconds for a budget a message names, so a changed constant cannot leave stale text. */
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
/** Coarse "how long ago", for a message that has to say whether something is new. */
function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  // Floor from here up: this tier can be read as "how stale is the index", where rounding 13 h to
  // "1 day" contradicts a 24 h rule printed beside it (round 22, measured through a stub es.exe).
  // Hours run up to 47 h on purpose, so the days tier opens at "2 days" (pinned by the e2e case);
  // the singular form stays in place for the day the 48 h gate moves.
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * The "directory on disk, Everything answered nothing" reply. Exported ONLY for
 * test/e2e-spaced-path.mjs: whether a brand-new folder has reached the index yet is a race, so the
 * fresh-folder wording cannot be pinned end-to-end (measured 2026-11-04: the same call answered
 * 12,345 bytes on one run and Error 9 on the next, both within 150 ms of creating the folder).
 *
 * `bornMs` is the QUERIED folder's own NTFS creation time minus now, read at the call site - NOT the age
 * of its contents, so a restored or re-copied folder reads as brand new (round 181 F-6). It is negative
 * in two situations that the caller cannot tell apart and this builder treats alike: a creation time
 * ahead of this clock (a copy or restore artefact), and the -1 the contradiction site passes when its
 * second `statSync` failed, meaning the folder was renamed or deleted mid-call (round 181 F-7). Both
 * mean "no age clause". The gate itself is `bornMs >= 0 && bornMs < 15 * 60 * 1000`; 15 minutes is
 * Everything's own observed indexing lag for a new folder (both READMEs state "under 15 minutes old",
 * and the suite pins the constant against that wording).
 */
export function folderNotIndexedText(target: string, bornMs: number, indexedZero = false): string {
  const fresh = bornMs >= 0 && bornMs < 15 * 60 * 1000;
  if (indexedZero) {
    // Round 160 F-160-4: this wording is for the site reached when es.exe ANSWERED 0 bytes for a folder
    // whose own contents say otherwise. The wording below is false here: Everything did answer a row for
    // this path (that is where the 0 came from), so volume coverage is not the question.
    return `"${target}" is a directory on disk that Everything DOES index, but its indexed total is 0 `
      + "bytes, and the folder's own contents contradict that number. The index has not recorded this "
      + "folder's contents yet, or its folder-size entry is lagging, or Options ▸ Indexes ▸ \"Index folder "
      + "size\" is off in Everything - this tool needs that option. This is NOT a volume-coverage question: "
      + "Everything answered a row for this path."
      + (fresh ? ` The folder is ${agoText(bornMs)} old, so retry in a moment;` : "")
      + ` everything_search with ancestor:"${target}" shows what the index holds for it.`;
  }
  return (
    `"${target}" is a directory on disk, but Everything answered nothing for it. ` +
    (fresh
      ? `It was created ${agoText(bornMs)} ago, so the index may simply not hold it yet: ` +
        "Everything adds new items within seconds to minutes. Retry in a moment - " +
        `everything_search with ancestor:"${target}" shows what is already indexed. Otherwise: `
      : "") +
    "either it is outside the indexed volumes (Everything indexes local NTFS drives, not UNC " +
    'shares like "\\\\server\\share"), or Options ▸ Indexes ▸ "Index folder size" is off in ' +
    "Everything - this tool needs that option. Run everything_search with root: to list the volumes this "
    + "index covers; everything_status reports the app, the item count and the index's freshness, not a "
    + "volume list."
  );
}

/** The two folder-size answers that read es.exe's reply against the DISK (round 174). Exported so the
 *  suite can pin each wording: neither is reachable on demand through the real index - one needs a
 *  SUCCESSFUL `-get-folder-size` reply that is not a number, the other an indexed 0-byte folder whose
 *  own listing cannot be read - so a unit pin is the honest cover, not a skipped live drive. */
export function folderParseFailureText(target: string, out: string): string {
  return `Could not parse folder size for: ${target} (got: ${out || "empty output"}). ` +
    "Check the path exists in the index (everything_search can verify it).";
}

export function folderZeroUnbackedText(target: string): string {
  return `"${target}" answered 0 bytes, and it is not a folder that can be read on disk either - ` +
    `nothing backs that number. Check the spelling with everything_search, or the folder may ` +
    `have been deleted or renamed.`;
}

/** The witness decision for an index total of 0, given the accounts the handler collected (round 181
 *  F-4: this arithmetic lived inline in an if-chain, so its truth table had no seam and no case). A
 *  count of `null` means that `-get-result-count` call was unusable - spawn error, timeout, or a reply
 *  that is not a bare integer - and it contributes NO evidence, which is what the inline chain did.
 *  The handler calls this TWICE: once with `heavyCount` null (witnesses 1 and 2) and, only if that
 *  answers false, again with the `size:>0` count, so the expensive count is still never asked when a
 *  cheaper witness already decided. Exported ONLY for test/e2e-spaced-path.mjs. */
export function zeroWitness(
  childBytes: number,
  underCount: number | null,
  heavyCount: number | null,
): boolean {
  // 1. a direct child holding bytes makes a recursive total of 0 false whatever the index says.
  if (childBytes > 0) return true;
  if (underCount === null) return false;
  // 2. entries on disk and nothing at all under the folder in the index: it has not caught up.
  if (underCount === 0) return true;
  // 3. rows under the folder that DO carry bytes: the index disagrees with itself.
  return heavyCount !== null && heavyCount > 0;
}

/** Keep the index's 0 and say what it leaves out (round 181 F-1, measured live). A folder whose only
 *  child is a link holds bytes the index will never count - `C:\tmp\esq181\resid` carries 5,000 behind
 *  a junction and answered `0 B (0 bytes, recursive, from index)` with no note of any kind, while
 *  sizing the junction ITSELF prints the full link note, so it is the caller of the parent who reads
 *  "empty". `linkChildren` are BASENAMES from the folder's own listing. */
export function linkChildZeroText(target: string, linkChildren: readonly string[]): string {
  const sep = target.endsWith("\\") ? "" : "\\";
  const one = linkChildren.length === 1;
  const named = linkChildren.slice(0, 5).map((l) => `"${l}"`).join(", ");
  const more = linkChildren.length > 5 ? ` +${linkChildren.length - 5} more` : "";
  return "\n[everything_folder_size: " +
    `"${target}" totals 0 in the index, and its own listing holds ` +
    `${one ? "a LINK child " : "LINK children "}${named}${more}. Everything indexes a link as an empty ` +
    `entry and never traverses it, so whatever sits behind ${one ? "it is" : "them are"} NOT in the ` +
    `total above - and this is not index lag, it will not change on retry. Size the link itself to get ` +
    `its target's total, e.g. everything_folder_size with path "${target}${sep}${linkChildren[0]}".]`;
}

/** What the link TARGET leg contributes to a live-link answer: the SECOND `-get-folder-size`, a call of
 *  its own whose failure is therefore its own kind (round 174 F-8). Before this split any non-number read
 *  `Everything returned "nothing"`, which hid a 30 s timeout, a call that never started, and es.exe's own
 *  refusal (for a target the index does not hold, `Error 9: No results found.`) behind one wording.
 *  `tStat` is the stored target's own stat: a FILE target gets its size in prose and NO byte key, which is
 *  why `bytes` is null there and the note's own account is the only place that size appears. `leg` is null
 *  exactly in that FILE case - no second call is made. */
export function linkTargetLeg(
  linkTarget: string,
  leg: EsOutcome | null,
  tStat: { size: number; isDirectory(): boolean } | null,
): { part: string; bytes: number | null } {
  if (tStat && !tStat.isDirectory()) {
    return {
      bytes: null,
      part: ` The link resolves to the FILE "${linkTarget}" (${tStat.size.toLocaleString("en-US")} ` +
        `bytes on disk) - everything_folder_size sizes directories; everything_search with ` +
        `details:true lists a file's own size.`,
    };
  }
  const raw = leg === null ? "" : leg.stdout.toString("utf-8").trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (leg !== null && Number.isFinite(n)) {
    return {
      bytes: n,
      part: ` The target's own total from the index: ${fmtBytes(n)} ` +
        `(${n.toLocaleString("en-US")} bytes).`,
    };
  }
  const why = leg === null
    ? "nothing was asked of it"
    : leg.timedOut
      ? `es.exe did not answer about it within the ` +
        `${Math.round((leg.timeoutMs ?? ES_TIMEOUT_MS) / 1000)}s this call allows`
      : leg.spawnError
        ? `es.exe could not be started for it (` +
          `${(leg.spawnError as NodeJS.ErrnoException).code ?? leg.spawnError.message})`
        : leg.code !== 0
          // es.exe's own words, clamped: this is the shape where the target simply is not in the index.
          ? `es.exe refused it: ` +
            `${leg.stderr.toString("utf-8").trim().replace(/\s+/g, " ").slice(0, 160)}`
          : `Everything returned ${raw ? `"${raw}"` : "nothing"} for "${linkTarget}"`;
  return {
    bytes: null,
    part: ` The target's own size did not answer - ${why} - so the total above describes the link ` +
      `entry alone.`,
  };
}

// Hard cap on response text: at 15 KB the plain-path render fit 187 results for
// ancestor:"C:\Program Files" ext:dll on 2026-11-04 (~81 B/path) - above the default 100.
const MAX_OUTPUT_BYTES = 15 * 1024;
// Upper bound on the length of the "[truncated at …]" marker; reserved from
// the byte budget so content + marker never exceeds MAX_OUTPUT_BYTES.
const TRUNCATION_MARKER_RESERVE = 200;

/** The Windows command-line ceiling (the classic 32,767-character CreateProcess limit), MEASURED on this
 *  box in round 120 by spawning es.exe with growing argument sets: the COUNT shape
 *  (`-argv -get-result-count <query>`) starts at 32,724 bytes of arguments and dies with
 *  `spawn ENAMETOOLONG` at 32,725; the LIST shape (that same query plus `-n 2000 -export-tsv <tmp>`
 *  `-sort name-ascending`, 78 bytes more fixed arguments) starts at 32,719 and fails at 32,720. The two
 *  edges differ by 5 while their fixed arguments differ by 78, because quoting and escaping make the real
 *  command line LONGER than the arguments: an argument of `\" \` repeated 8,000 times starts at 24,022 RAW
 *  bytes and fails at 24,023 - every double quote is escaped and every backslash before it doubled. So the
 *  guard below bounds the ESCAPED length, and this reserve covers the resolved `es.exe` path (34 B here)
 *  plus slack for a machine whose PATH lives deeper. */
const WIN_CMD_LIMIT_BYTES = 32_767;
const CMD_PATH_RESERVE_BYTES = 512;
/** Refuse one caller string above this, before anything is built or spawned. It sits just under the
 *  measured clean-content edge, so ordinary oversized input is refused by NAME (the parameter is named, the
 *  byte count is quoted) and the raw OS string stays out of reach; it is also what bounds the ~26 places
 *  that echo a caller's text VERBATIM into an answer or a refusal (round 85's "details <=517 B at any
 *  answer size" is false for a legal input - a 30,035-byte query pushed detailsBytes to 60,444 B - and the
 *  honest repair is a ceiling on the input, not a clamp on the echo). */
const MAX_PARAM_BYTES = 32_000;
/** A count answer is its NUMBER plus the query it counted; the number is the payload, so the echo yields at
 *  this size instead of the answer growing with the query (it is one seventh of MAX_OUTPUT_BYTES, and the
 *  list answer's own clamp is line-based, so a query echoed past this point would take the header with it).
 *  Values at or under this length are echoed UNCHANGED, byte for byte. */
const MAX_ECHO_BYTES = 2_048;

/** UTF-8 byte length - the unit every ceiling in this file is stated in. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

/** The first `maxBytes` of `value`, never splitting a UTF-8 sequence. */
function headBytes(value: string, maxBytes: number): string {
  const head = Buffer.from(value, "utf-8").subarray(0, maxBytes).toString("utf-8");
  return head.endsWith("\uFFFD") ? head.slice(0, -1) : head;
}

/** The first MAX_ECHO_BYTES of `value`, never splitting a UTF-8 sequence. */
function boundedEchoHead(value: string): string {
  return headBytes(value, MAX_ECHO_BYTES);
}

/** A caller's own text inside an ANSWER: verbatim while it fits, then the head plus the exact total.
 *
 *  THE RULE (round 120), stated once because five surfaces otherwise invent their own: an ANSWER echoes a
 *  caller's text only as far as `MAX_ECHO_BYTES`, because an answer has a byte budget (`MAX_OUTPUT_BYTES`,
 *  `GREP_OUTPUT_MAX_BYTES`) and an oversized echo spends it on the wrong half - measured with a legal
 *  20,480-byte `query`, the zero-result answer collapsed to "[truncated at 15KB: showing 0 of 2 lines]" and
 *  listed NOTHING, and the same query on a non-empty list would have cost its rows. A REFUSAL (a thrown body)
 *  keeps the text VERBATIM: it has no budget, and showing the caller what was rejected is its whole job -
 *  what bounds those echoes is `MAX_PARAM_BYTES` at the input, not a clamp here. Short values come back
 *  UNCHANGED byte for byte, which is why every existing byte-exact pin holds. */
function boundedEcho(value: string): string {
  if (byteLen(value) <= MAX_ECHO_BYTES) return value;
  const head = boundedEchoHead(value);
  return `${head}… [+${(byteLen(value) - byteLen(head)).toLocaleString("en-US")} more bytes; this value is ${byteLen(value).toLocaleString("en-US")} bytes total]`;
}
/** One whole-answer note may not exceed this. Round 120 measured the alternative: a `|`-join note quoting a
 *  legal 20,523-byte `query` rendered 21,446 B, the notes-bytes reservation below then drove the ROW budget
 *  under zero (that answer printed NO rows at all) and the response came back 21,555 B - over
 *  MAX_OUTPUT_BYTES. BACKSTOP CEILING, measured today through the deployed tool (F-120-6): the largest
 *  note this tool prints for a SHORT query is 2,842 B - unscopedBranchNote's own essay is ~2.7 KB of fixed
 *  prose - so a cap under that cuts the tool's OWN explanation, which is what 2,048 did on its first suite
 *  run (five old cases reddened: the "put the scope where Everything ANDs it" clause and a third equation
 *  vanished from the note). Eight times the largest legitimate note is the line: a note only reaches it by
 *  quoting caller text, and caller text is now bounded where the note INSERTS it (boundedEcho at every
 *  insertion site below), so a note whose query is legal prints whole at ANY admitted length and the cap
 *  fires only past 8,192 B of it. (cases 99/135/138/165 keep their byte-exact note pins) */
const MAX_NOTE_BYTES = 8_192;

/** And the ASSEMBLED set of whole-answer notes may not exceed this. The LIST answer appends ELEVEN
 *  whole-answer notes (every `trailingNotes += capAnswerNote(` site - case 211 pins the count), so the
 *  per-note cap alone bounds the set at 11 x MAX_NOTE_BYTES = 90,112 bytes - more than the answer itself -
 *  which is
 *  why the set gets its own line: with it here the row budget never falls below MAX_OUTPUT_BYTES -
 *  TRUNCATION_MARKER_RESERVE - MAX_NOTES_TOTAL_BYTES - this helper's own disclosure, and the response never
 *  exceeds MAX_OUTPUT_BYTES (the count_only return has no truncateHead, so its notes are capped at their own
 *  sites - case 211 drives both ceilings). No SHORT-query shape measured today reaches it (two essay notes plus the
 *  join and "!" notes is ~8 KB), and the row budget floor this leaves is MAX_OUTPUT_BYTES -
 *  TRUNCATION_MARKER_RESERVE - MAX_NOTES_TOTAL_BYTES = 2,872 bytes, give or take the ~100 bytes
 *  of this helper's own disclosure suffix - it rides OUTSIDE the 12,288 it discloses against (the driven
 *  suffix is 100 bytes as case 211 drives it today), and case 211 pins the floor, the suffix and this
 *  ceiling on both the list and the count_only shape. */
const MAX_NOTES_TOTAL_BYTES = 12_288;

/** Cap ONE whole-answer note and disclose the cut. A note's EXPLANATION lives at its head and the text it
 *  quotes from the caller sits at its tail, so the head is what survives. Notes are never DELETED (round 19
 *  found a long page deleting them), only cut, and the cut states the note's true size. */
function capAnswerNote(note: string): string {
  if (byteLen(note) <= MAX_NOTE_BYTES) return note;
  return `${headBytes(note, MAX_NOTE_BYTES)}… [note cut at ${MAX_NOTE_BYTES.toLocaleString("en-US")} of ${byteLen(note).toLocaleString("en-US")} bytes - it quotes the text you sent, and an answer echoes a full value only up to ${MAX_ECHO_BYTES.toLocaleString("en-US")} bytes]`;
}

/** Cap the assembled note set the same way, disclosing how much of it was cut. What reaches it is NOTES x
 *  ECHOES, not notes at their own ceiling: measured 2026-11-06 (driven by cases 168 and 211) THREE grammar
 *  notes whose caller-text insertions saturate at `boundedEcho` (2,048 B each), plus their own prose, made a
 *  15,826-byte set and took this cut with NO note anywhere near MAX_NOTE_BYTES. */
function capNotesTotal(notes: string): string {
  if (byteLen(notes) <= MAX_NOTES_TOTAL_BYTES) return notes;
  return `${headBytes(notes, MAX_NOTES_TOTAL_BYTES)}… [notes cut at ${MAX_NOTES_TOTAL_BYTES.toLocaleString("en-US")} of ${byteLen(notes).toLocaleString("en-US")} bytes so the answer itself stayed inside its ${MAX_OUTPUT_BYTES.toLocaleString("en-US")}-byte ceiling]`; // round 155 F-4: also used on count/zero sets, which have no rows; round 180 F-5: the tail no longer cites a row SHARE those shapes never implemented
}

/** The refusal behind `MAX_PARAM_BYTES`. It names the number the caller broke and why the number is there,
 *  and it does NOT point at everything_status: an index probe cannot see a command-line ceiling (round 85
 *  established that a cause everything_status cannot diagnose must not send the caller there). */
/** Which family a rejected string value belongs to, because the reason a ceiling exists is NOT the same for
 *  every one of them: a `query`, a `path` and a column name go onto es.exe's command line, while
 *  everything_grep's `pattern` never does (its scan opens the selected files and matches them in-process).
 *  F-123-1, round 123 - the shared body told a pattern caller that their text was on a command line it never
 *  reached, which that parameter's own description contradicts. */
type ParamShape = "sent" | "pattern" | "path";

/** The refusal behind `MAX_PARAM_BYTES`. It names the number the caller broke and why the number is there,
 *  and it does NOT point at everything_status: an index probe cannot see a command-line ceiling (round 85
 *  established that a cause everything_status cannot diagnose must not send the caller there). The
 *  command-line paragraph prints only for a value this tool actually sends; `pattern` gets the reason that is
 *  true for it, and `path` keeps the command-line reason but gets advice a path can act on. */
function paramTooLongBody(name: string, bytes: number, shape: ParamShape = "sent"): string {
  // 32,725 is the OBSERVED Windows point (round 120, spawning es.exe directly): an argument set that Node
  // renders to 32,725 bytes dies with ENAMETOOLONG before es.exe runs. It is measurement prose - no constant
  // equals it - and the case pins its PLACEMENT as arithmetic instead of re-measuring it, because
  // re-measuring means spawning a child with a 32 KB argument set: it must stay BELOW
  // WIN_CMD_LIMIT_BYTES (the number in the sentence) and ABOVE this tool's own command-line ceiling.
  const ownCeiling = (WIN_CMD_LIMIT_BYTES - CMD_PATH_RESERVE_BYTES).toLocaleString("en-US");
  const head = `${name} is ${bytes.toLocaleString("en-US")} bytes, over the ${MAX_PARAM_BYTES.toLocaleString("en-US")}-byte limit this tool puts on one value.`;
  if (shape === "pattern") {
    return head
      + ` This tool never starts es.exe with a pattern value - everything_grep opens the files its query`
      + ` selected and matches them in-process - so for THIS value the ceiling is NOT a command-line limit. It`
      + ` is the one input limit this tool puts on every string it accepts, and a refusal echoes this value`
      + ` back verbatim, so a pattern this long would be printed whole by every answer and error that names`
      + ` it. Shorten the expression: no scope term makes a regular expression shorter, and one this long is`
      + ` a mistake, not a search.`;
  }
  const commandLine = ` Two facts set it: es.exe is STARTED with this text on its command line, and Windows refuses a command line`
    + ` ${WIN_CMD_LIMIT_BYTES.toLocaleString("en-US")} characters or longer (measured here: an argument set of 32,725 bytes dies with`
    + ` ENAMETOOLONG before es.exe runs, and quoting and escaping add to it), so this tool refuses any call whose`
    + ` arguments would build a command line over ${ownCeiling} bytes - Windows' limit less a`
    + ` ${CMD_PATH_RESERVE_BYTES}-byte reserve for es.exe's own switches and the temp file it writes - and every`
    + ` answer and refusal echoes this value back verbatim.`;
  const advice = shape === "path"
    ? ` Point at the folder you mean: a path has no scope terms to narrow - ancestor:, ext: and size: are query`
      + ` syntax, not path syntax - so a value this long is a mistake, not a folder.`
    : ` Split the search into several narrower calls - a deeper ancestor:, fewer names per call, or a size:/ext:`
      + ` bound - rather than lengthening one.`;
  return head + commandLine + advice;
}

/** The spelling Everything's index actually stores for a path Windows accepts: it strips the
 *  extended-length and device prefixes, a trailing dot or bare-dot segment, and puts the separator back
 *  on a bare drive root. String work only - no second es.exe call and no extra stat (round 24's rule:
 *  classify from ONE statSync). Returns the input unchanged when there is nothing to strip. ONE builder
 *  for both surfaces that name a plain path back to the caller: the retry-with-this-spelling refusal and
 *  the FILE arm's size-this-folder advice (F-123-2, round 123 - that arm used to hand back the caller's
 *  own device spelling, which the very next arm refuses). */
export function plainFormOf(p: string): string {
  let out = p;
  if (out.startsWith("\\\\?\\UNC\\")) out = "\\\\" + out.slice(8);
  else if (out.startsWith("\\\\?\\")) out = out.slice(4);
  else if (out.startsWith("\\\\.\\")) out = out.slice(4);
  out = out.replace(/[\\/]+\.[\\/]*$/, "");
  if (/^[A-Za-z]:$/.test(out)) out += "\\";
  return out;
}

/** An UPPER bound on the command line Node builds for these arguments: each argument's bytes, plus one
 *  character for every double quote (it becomes \\") and every backslash (doubled before a quote), plus the
 *  two quoting characters an argument holding a space gets, plus the separators. Deliberately generous: the
 *  real command line is never LONGER than this. */
function commandLineBytes(args: string[]): number {
  let n = Math.max(0, args.length - 1);
  for (const a of args) {
    let quotes = 0;
    let backslashes = 0;
    for (const ch of a) {
      if (ch === '"') quotes++;
      else if (ch === "\\") backslashes++;
    }
    n += byteLen(a) + quotes + backslashes;
    if (a === "" || /["\s]/.test(a)) n += 2;
  }
  return n;
}

// everything_grep — content scan over an Everything-index-selected file list;
// output shapes are byte-compatible with the grep tool's hashline rendering.
const MAX_CANDIDATE_FILES = 2000; // refuse above: caller must narrow the query
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than this
const GREP_MAX_MATCHES_PER_FILE = 10; // per-file cap (applied when total > 50)
const GREP_TRUNCATION_THRESHOLD = 50; // per-file cap activates above this total
const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LIMIT = 500; // everything_grep match ceiling (bounds marker digits too)
// 20 KB (tighter than pi-core's DEFAULT_MAX_BYTES = 50 KB): a single tool response stays small
// (user decision, 2026-09-10) and the scan stops as soon as this budget is
// full — no post-hoc cut of a larger result. See the repo README (project doc).
const GREP_OUTPUT_MAX_BYTES = Math.min(DEFAULT_MAX_BYTES, 20 * 1024);
// Footer appended when any displayed line hit the 500-char cap (parity text
// with pi's builtin grep). 500 = pi's builtin grep per-line threshold
// (GREP_MAX_LINE_LENGTH in pi-core's truncate module; not re-exported from
// the package root, so it is stated literally here).
const LINE_TRUNC_FOOTER = "[Some lines truncated to 500 chars. Use read tool to see full lines]";
// Worst-case suffix block (limit marker + line-cap footer + budget marker,
// incl. the blank line before it) reserved from the scan budget so the
// FINAL text never exceeds the cap. Round 92 tried 512 (its notes add ~360 B in the worst case) and
// put it straight back: the reserve is not a free knob, it moves bytes out of the ROW budget, so the
// scan-side budget stop lands EARLIER and consumes all of the trimming - measured on the 405-candidate
// fixture at 512, the answer carried the scan-side marker alone and the assembly trim stopped firing,
// which is the second byte-cut account the staging assertion at the "a further" case exists to check.
// A TYPICAL note set still fits 320, and the assembly trim below (the answer-cap backstop, which keeps
// every note and drops whole trailing groups) is what covers an oversized one.
const GREP_MARKER_RESERVE = 320;
// Parameters that belong to everything_search and NOT to everything_grep. pi validates NOTHING
// at runtime (round 82), so passing one to grep is legal and does nothing: measured 2026-11-05
// over a 40-file fixture at limit:5, calls carrying sort:"name-descending", order, offset,
// count_only, columns, total_size, regex, case_sensitive, whole_word, match_path, diacritics and
// a bogus key ALL answered byte-identically to the call without it - same five files, same
// `details` - and `details.esQuery` proves no -sort or match flag reached es.exe. The silence
// matters most for `sort`, because the scan order decides WHICH files a truncated answer covers:
// grep sends no -sort, so candidates arrive in Everything's own name order. Measured equal to
// `-sort name-ascending` (first 8 identical) for four scopes of varied provenance - Program Files
// exe, System32 dll, npm js, pi docs md - and NOT equal to `-sort path-ascending` on the three
// whose names and paths disagree; confirmed on a folder where one file was RENAMED after
// creation, where the unsorted order and name-ascending put the renamed file LAST while
// `-sort date-created-ascending` puts it FIRST, so the order is name order, not arrival order.
// Hence the notes beside the coverage note: name the ignored keys instead of letting a caller
// believe their sort was applied. `query` and `limit` exist in both tools, so they are not here. The list
// is held against the registered schema by suite case 133 - that is how `details` joined in round 93,
// twelve names where round 92 hand-built eleven.
const SEARCH_ONLY_PARAMS = [
  "sort", "order", "offset", "columns", "details", "count_only", "total_size", "regex",
  "case_sensitive", "whole_word", "match_path", "diacritics",
] as const;

// The same measurement in the other direction (round 167 F-167-01): a caller who sent one of
// everything_grep's parameters to everything_search got a byte-identical answer with it dropped, just as
// round 92 measured for search's parameters at grep. `pattern` is included although grep's `pattern` and
// this tool's `query` play the same role, because the NAME is what a caller confused. `query` and `limit`
// exist in both tools and are not here - the rule that keeps them out of SEARCH_ONLY_PARAMS. Suite case
// 133 holds both lists against the registered schemas.
const GREP_ONLY_PARAMS = ["pattern", "ignoreCase", "literal", "context", "summary"] as const;

// Parameters belonging to a third tool of this extension, paired with the owner to name. Neither search
// nor grep can honour them, and pi validates nothing, so they arrive and vanish unless they are named.
const OTHER_OWNED_PARAMS: ReadonlyArray<readonly [string, string]> = [
  ["path", "everything_folder_size"],
  ["force", "everything_status"],
  ["include_columns", "everything_syntax"],
];

/**
 * One bracketed note naming every parameter `params` carries that belongs to another tool, each with the
 * tool that owns it, or "" when there is nothing to say. `foreign` is the [name, owner] list the calling
 * tool needs; a key that belongs to NO tool of this extension stays silent, as it always has - only
 * names this extension owns are claimed.
 */
function foreignParamNote(thisTool: string, params: object,
  foreign: ReadonlyArray<readonly [string, string]>): string {
  const hits = foreign.filter(([k]) => k in params);
  if (hits.length === 0) return "";
  const owners = new Map<string, string[]>();
  for (const [k, owner] of hits) {
    const bucket = owners.get(owner);
    if (bucket) bucket.push(k);
    else owners.set(owner, [k]);
  }
  // The verb belongs to the OWNER, which is always one tool: "everything_grep has summary, context".
  const ownerText = [...owners.entries()]
    .map(([o, ks]) => `${o} has ${ks.join(", ")}`)
    .join("; ");
  const names = hits.map(([k]) => k);
  const one = names.length === 1;
  return `\n[${thisTool}: ${names.join(", ")} ${one ? "is not a parameter" : "are not parameters"} of this ` +
    `tool and ${one ? "was" : "were"} ignored - ${ownerText}.]`;
}

const FOREIGN_AT_GREP: ReadonlyArray<readonly [string, string]> = OTHER_OWNED_PARAMS;
const FOREIGN_AT_SEARCH: ReadonlyArray<readonly [string, string]> = [
  ...GREP_ONLY_PARAMS.map((k): readonly [string, string] => [k, "everything_grep"]),
  ...OTHER_OWNED_PARAMS,
];

// es 1.5 returns this from -get-total-size when the result set is empty.
// Compared as a string: 2^64-1 exceeds Number.MAX_SAFE_INTEGER, so a numeric
// literal would silently round to 2^64.
const UINT64_MAX_STR = "18446744073709551615";
// `\` immediately before a colon-operator = escape in Everything (the operator becomes literal
// text); warn on it — a common LLM JSON-escape mistake (`\ext:ts` -> 0 results). The colon is
// REQUIRED: without it a plain Windows path (`ancestor:"C:\tmp\path-demo"`) matched on its `\path`
// separator and the advice would have deleted a path separator from a correct query (round 152). A
// Windows name can never contain `:` at all, so a longer name list buys no false positive: `\size:`
// and `\ancestor:` are never part of a real path.
//
// Round 184 found the two query guards DISAGREEING about which functions they know: this one lacked
// `ancestor`, so `\ancestor:"C:\Program Files" ext:exe` answered a false zero with NO warning - the
// exact silent failure this arm exists to catch - while the spaced-value arm already named it. The
// name set is now SPACED_FUNCTION_VALUE_RE's (declared below): the union of what both guards had
// already committed to. Widening it to every function `syntax.md` documents (it names ~70, type
// macros and mode switches included) is the wider change; this round found no uncovered name that
// takes a value. Longest name first so a short name can never shadow a longer one it prefixes.
// The name group STAYS CAPTURED: the warning quotes `\${escMatch[1]}:` back to the caller, and a
// non-capturing alternation here prints `\undefined:` (round 184 caught it on the first run of its own
// new case, which asserts the name appears).
export const ESCAPED_OPERATOR_RE =
  /\\((?:descendant-count|volume-label|parent-name|child-count|child-name|descendant|resulttype|childname|ancestor|sibling|attrib|folder|parent|child|regex|file|name|path|size|stem|type|zone|ext|da|dc|dm)):/i;

// ---------------------------------------------------------------------------
// Native command-argument passing (`-argv`)
//
// es.exe parses its own command line with a private parser that ignores `\"`
// escapes, so a quoted search-function value is mis-split into two arguments and
// the search silently returns 0 — while the Everything server answers the same
// query correctly. Vendor-confirmed: voidtools/ES issue #7 ("Users come across
// this issue often"). The fix is `-argv`, which switches es.exe to
// CommandLineToArgvW; it was added in es 1.1.0.37 and is honoured only as the
// FIRST argument. Verified live against es 1.1.0.37 + Everything 1.5.0.1423 on
// 2026-11-04, comparing every row with the named-pipe server:
//   ancestor:"C:\Program Files" ext:exe -> 1,961 with -argv, 0 without
//   path:"C:\Program Files" ext:exe     -> 3,181 with -argv, 0 without
//   ancestor:"C:\Program Files\Git"     -> 10,458 with -argv, 0 without
// Every quote-free query stays byte-identical with and without `-argv` (ext:exe,
// quoted phrases, ext:a|b, !<...|...>, size:>, dm:, -sort, -case, -match-path,
// -whole-word, -add-columns, -export-txt/-tsv, -get-result-count,
// -get-total-size, -get-folder-size). Older es.exe rejects the switch with
// "Error 6: Unknown switch", so the switch is gated on the version below.
// ---------------------------------------------------------------------------
const ES_ARGV_MIN_VERSION = [1, 1, 0, 37];

// A search function whose quoted value contains a space: on a missing `-argv` a PATH-valued
// function is a false zero and a NAME-valued one is a plausible WRONG non-zero (syntax.md's two
// measured classes). The PATH class matches syntax.md exactly; the NAME class is syntax.md's set
// plus the `child-name`/`child-count`/`descendant-count` twins - unmeasured there, same shape and
// same failure, so they ride along.
//
// Its name set is now IDENTICAL to ESCAPED_OPERATOR_RE's (round 184: the two guards disagreed, and
// this one already knew `ancestor` while the escape arm did not); the suite pins that the two
// alternations carry the same names in the same order, so they cannot drift apart again. The
// look-behind is a CLASS, not `^|\s`: the shipped reference glues a function straight after `<`, `|`
// or `(` in its own examples (`<ancestor:"C:\Program Files" | *.bin>`), and the anchored form let
// exactly those spellings reach an aged build un-warned - a false zero with no warning, which is the
// one thing this guard exists to prevent.
export const SPACED_FUNCTION_VALUE_RE =
  /(?:^|[\s<|(!])!?\b(?:descendant-count|volume-label|parent-name|child-count|child-name|descendant|resulttype|childname|ancestor|sibling|attrib|folder|parent|child|regex|file|name|path|size|stem|type|zone|ext|da|dc|dm):"[^"]*\s[^"]*"/i;

// Exported ONLY so the suite can pin them (the csvLineToTabs precedent at case 26): these two decide whether
// every es.exe call gets `-argv`, which is the whole spaced-quoted-value capability, and a shorter-than-min
// version array fails `versionAtLeast` on purpose (undefined > number is false), so an unreadable version
// never turns the switch on.
export function parseEsVersion(text: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? m.slice(1, 5).map(Number) : null;
}

export function versionAtLeast(v: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

let argvSupport: boolean | null = null;

/**
 * true when es.exe understands `-argv` (>= 1.1.0.37). Probed once per process
 * with a synchronous `-version` call, because the answer is needed on the spawn
 * path itself; a missing, unreadable or UNANSWERING es.exe reads as "no".
 * The probe is bounded on purpose: with no timeout a hung es.exe froze every call
 * that reaches this function (measured 2026-11-04 with a stub es.exe - one
 * everything_status call took 65 s, 60 of them spent right here).
 */
function esSupportsArgv(): boolean {
  if (argvSupport != null) return argvSupport;
  try {
    const r = spawnSync("es.exe", ["-version"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: STATUS_VERSION_TIMEOUT_MS,
    });
    const v = r.status === 0 ? parseEsVersion(String(r.stdout ?? "")) : null;
    argvSupport = v ? versionAtLeast(v, ES_ARGV_MIN_VERSION) : false;
  } catch {
    argvSupport = false;
  }
  return argvSupport;
}
/** The -argv gate's CURRENT state WITHOUT probing: null = never probed in this process,
 *  true/false = what the spawn path will do. `everything_status` prints this instead of
 *  inferring the gate from its own `-version` probe, which is a SEPARATE call with its own
 *  cache - the two can disagree, and the report must state the gate, not a guess. */
export function argvGateState(): boolean | null {
  return argvSupport;
}

// Property columns: all 55 re-verified ACCEPTED live with -add-columns on 2026-11-05 (es 1.1.0.37, the same
// build as the 2026-09-10 verification; a bad name dies with "Error 4: Unknown column"). Population is per FILE
// KIND. Five names carry no value for any kind sampled on this box; four more (word-count, line-count,
// last-author, slide-count) fill ONLY legacy OLE documents - they are named in the columns= text and in the
// everything_syntax appendix, which is where a caller chooses a name.
const COLUMN_ALLOWLIST: string[] = [
  "date-created", "date-accessed", "date-changed", "attributes", "extension",
  "run-count", "date-run", "date-recently-changed", "volume-label",
  "hard-link-count", "width", "height", "length", "date-taken", "date-acquired",
  "artist", "album", "title", "comment", "genre", "track", "year", "frame-rate",
  "audio-bitrate", "video-bitrate", "total-bitrate", "audio-channels",
  "audio-sample-rate", "audio-bits-per-sample", "bit-depth", "aspect-ratio",
  "camera-maker", "camera-model", "lens-model", "iso-speed", "f-stop",
  "latitude", "longitude", "people", "tags", "author", "last-author", "software",
  "company", "product-name", "product-version", "version", "kind",
  "content-type", "file-signature", "page-count", "word-count", "line-count",
  "slide-count", "parent-name",
];

// ---------------------------------------------------------------------------
// es.exe runner
// ---------------------------------------------------------------------------

interface EsOutcome {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  spawnError?: Error;
  timedOut?: boolean;
  /** Set on an ABORTED outcome, which is a CALLER cancellation and not an es.exe fault: "beforeStart"
   *  means the signal was already aborted when the call was made, "during" that it fired while es.exe
   *  ran (the child was killed and its partial output discarded). */
  aborted?: "beforeStart" | "during";
  /** Set when this tool refused to spawn at all because the arguments would build too long a command line
   *  (`commandLineBytes` over `WIN_CMD_LIMIT_BYTES - CMD_PATH_RESERVE_BYTES`). Before round 120 the only
   *  report was the OS's own `Could not start es.exe: spawn ENAMETOOLONG. Run everything_status to
   *  diagnose.` - a raw string that named no limit and pointed at a tool which cannot see one. */
  argvTooLong?: { bytes: number; limit: number };
  /** Set when this tool refused to spawn because the arguments carried a control switch (`-exit` and
   *  friends). Like `argvTooLong` this is a refusal by THIS tool, not an es.exe fault: es.exe never
   *  started, so the message must not read like a broken installation. */
  controlSwitches?: string[];
  /** The budget the call was given; set only on a timed-out outcome, so error text
   *  can name the wait that actually happened (count calls get 15 s, list fetches 30 s). */
  timeoutMs?: number;
}

function runEs(
  args: string[],
  signal?: AbortSignal,
  timeoutMs = ES_TIMEOUT_MS,
): Promise<EsOutcome> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("aborted before start"),
        code: null,
        spawnError: new Error("aborted before start"),
        aborted: "beforeStart",
      });
      return;
    }
    const cmdBytes = commandLineBytes(args);
    const cmdLimit = WIN_CMD_LIMIT_BYTES - CMD_PATH_RESERVE_BYTES;
    if (cmdBytes > cmdLimit) {
      const err = new Error(`command line of ${cmdBytes} bytes refuses to start`);
      resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("command line too long"),
        code: null,
        spawnError: err,
        argvTooLong: { bytes: cmdBytes, limit: cmdLimit },
      });
      return;
    }
    // Control switches are refused by NAME here, not merely avoided by the callers: `es -exit`
    // terminates the Everything app itself, and nothing but that app serves the index, so every
    // later call answers `Error 8: Everything IPC not found` (es.exe's own reply, quoted verbatim)
    // until a human restarts it. One hand-rolled probe did exactly that on 2026-11-04 (flag names
    // guessed, index down mid-review). Only the SWITCH REGION is scanned: query terms sit behind the
    // `--` terminator, where an argument is a search for a name and not a switch, so a file literally
    // named `-exit` stays searchable, and so does an expression that merely STARTS with one of these
    // names: behind `-regex` the element that follows it is es.exe's PATTERN, not a switch (measured
    // 2026-11-06 with raw es.exe on C:\tmp\esq82-fix: `-regex -case alpha ancestor:…` answered 0 rows, the
    // pattern having become the text `-case`, where `-case -regex alpha …` answered 2), so that ONE element
    // is exempt below - refusing it denied a caller a legal expression while the same text as an ordinary
    // search answered. The refusal is an outcome, never a throw: an unspawned es.exe is
    // not a broken installation, and esFailureMessage says so in its own arm.
    const dashDash = args.indexOf("--");
    let switchRegion = dashDash === -1 ? args : args.slice(0, dashDash);
    const regexSlot = switchRegion.indexOf("-regex");
    if (regexSlot !== -1) switchRegion = switchRegion.filter((_, i) => i !== regexSlot + 1);
    const forbidden = switchRegion.filter((a) =>
      ["-exit", "-quit", "-restart", "-save-settings", "-save-db"].includes(String(a).toLowerCase()));
    if (forbidden.length) {
      const err = new Error(`refusing to pass ${forbidden.join(", ")} to es.exe: control switches`);
      resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(String(err)),
        code: null,
        spawnError: err,
        controlSwitches: forbidden,
      });
      return;
    }
    let child;
    try {
      // `-argv` must be the first argument. `-version` is left alone because it
      // is the probe that decides whether `-argv` may be sent at all.
      child = spawn(
        "es.exe",
        args[0] === "-version" || !esSupportsArgv() ? args : ["-argv", ...args],
        { windowsHide: true },
      );
    } catch (err) {
      resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(String(err)),
        code: null,
        spawnError: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }
    const out: Buffer[] = [];
    const errBuf: Buffer[] = [];
    let settled = false;
    const finish = (r: EsOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errBuf),
        code: null,
        timedOut: true,
        timeoutMs,
      });
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      finish({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errBuf),
        code: null,
        spawnError: new Error("aborted"),
        aborted: "during",
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => errBuf.push(d));
    child.on("error", (err: Error) =>
      finish({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errBuf),
        code: null,
        spawnError: err,
      }),
    );
    child.on("close", (code: number | null) =>
      finish({ stdout: Buffer.concat(out), stderr: Buffer.concat(errBuf), code }),
    );
  });
}
/** The FIRST term in this query that Everything can only evaluate here by scanning the whole index. This is
 *  the classifier the refusals already use, shared on purpose: until round 69 F-69-2 this site kept a SECOND
 *  copy of the pattern, and the two had drifted - the copy never knew the long date spellings or the coordinate
 *  functions, and still fired on an empty `attrib:`, which answers in 61 ms. Returns the spelling so a message
 *  can name what it found instead of quoting a fixed list. A pure string test; it never runs the scan itself. */
function unindexedTermOf(query: string): string | null {
  for (const t of splitQueryTerms(query)) {
    const s = scanTermOf(t);
    if (s) return s;
  }
  return null;
}

/** The header clause for a count that did not answer: empty when nothing in the query scans, so the header
 *  stays silent rather than guessing a term. */
function unindexedTermClause(query: string): string {
  const term = unindexedTermOf(query);
  return term === null ? "" : `; it uses ${term}, a term this index does not carry, which scans every entry`;
}

/**
 * The scan-only term a query consists of ENTIRELY, or null when anything else narrows the candidate
 * set. This decides whether asking for a count is worth spawning anything. Measured 2026-11-04 with a
 * 75 s leash: `-get-result-count dc:today` and `-get-result-count content:zip` never answered at all
 * (killed at 75 s, exit 124), while `dc:2026-11-01 ext:exe` answered 97 in 116 ms (2026-11-06; the same query
 * read 99 in 2 s on 2026-11-04) - an un-indexed term is
 * only countable once something indexed has restricted the candidates. When nothing has, the 15 s count
 * budget just buys an admission at the end of it, so the call is skipped and the reason is printed now.
 * A grouped `<a|b>` query or any mixed query returns null: an unrecognized shape keeps the normal leash.
 */
export function soleScanOnlyTerm(terms: string[]): string | null {
  // ONE rule with scanTermOf, its exception included: `attrib:` with an EMPTY argument answers the whole
  // index in 162 ms rather than scanning (3,779,775 rows, measured 2026-11-05), and this site kept its own
  // copy of the pattern, so `attrib:` alone was still refused (round 68 F-68-6).
  if (terms.length === 0) return null;
  if (!terms.every((t) => scanTermOf(t) !== null)) return null;
  // Round 204 (the naming half of the first-term-wins audit): this read `terms[0]` alone, so a query carrying TWO
  // un-indexed families (`dc:today content:zip`) named one and left the other unnamed, and the caller who dropped
  // the named one was refused again by the term nobody mentioned. The gate is identical for both - no count is
  // askable at all - so only the account was partial; every such term is named now, in query order.
  const named = [...new Set(terms.map((t) => {
    const m = /^(?:!)?([A-Za-z]+):/i.exec(t);
    return m ? `${m[1].toLowerCase()}:` : "dc:";
  }))];
  return named.join(", ");
}
/** Which term is scan-only - `dc:`/`datecreated:`, `da:`/`dateaccessed:`, `dateacquired:`, `attrib:`
 *  (+`attributes:`, `attribute:`), `content:`, `latitude:`, `longitude:` - ignoring a leading `!` (`!dc:today`
 *  is Everything's NOT over an un-indexed term: never answered in 20 s) but NOT a leading `(` - a paren-headed
 *  term is a literal NAME: `(dc:today)` answers 0 rows in 59 ms and `<…answertrim | (dc:today)>` answers 405 in
 *  69 ms (round 68 F-68-7, the same fact parenAtom() uses). A QUOTED `"dc:today"` is a NAME too. The long date
 *  spellings and the two coordinate functions were MISSING until round 69: this box has date-created,
 *  date-accessed, date-acquired and the coordinate columns OFF (Everything > Options > Indexes), and
 *  `datecreated:today`, `dateaccessed:today`, `dateacquired:today`, `latitude:47`, `longitude:47` each never
 *  answered in 20 s - alone, as either side of a union, and with a folder ANDed onto it - while
 *  `datemodified:today` (14,463 rows), `dateviewed:today`, `dateinstalled:today` and `daterun:today` all answer,
 *  so only the first set is scan-only. A leading `<` IS stripped: that is a function glued directly behind a
 *  group OPENER, which is how Everything reads it - `<…answertrim | longitude:>`, `<…answertrim | latitude:>47>`
 *  and `<content:>x | …answertrim>` each never answered in 20 s, so the empty-argument function inside the group
 *  really was evaluated there (round 69 F-69-3; before this the classifier saw no function at all in such a term,
 *  which also cost the list header its "this index does not carry" clause). A leading `(` is still NOT stripped.
 *  A `d`-ONLY `attrib:`/`attributes:`/`attribute:` value is the exception below: the DIRECTORY filter is indexed,
 *  every other value of that family walks. */
function scanTermOf(text: string): string | null {
  const core = text.replace(/^[!<\s]+/, "").replace(/[)\s]+$/, "");
  const m = /^(datecreated|dateaccessed|dateacquired|latitude|longitude|dc|da|attrib|attributes|attribute|content):(.*)$/i.exec(core);
  if (!m) return null;
  // `attrib:` with an EMPTY argument is not a scan: it answers the WHOLE INDEX in 61 ms, and
  // `<…answertrim | attrib:>` answers in 45 ms, so refusing that count is a false refusal. Every OTHER name
  // above scans with an EMPTY argument too: `<…answertrim | dc:>`, `| da:>`, `| datecreated:>`, `| dateaccessed:>`
  // and `| dateacquired:>`, `| latitude:>`, `| longitude:>`, `| content:>` each failed to answer inside 20 s
  // (measured 2026-11-05), so they stay scan-only with no argument.
  if (/^attrib/i.test(m[1]) && m[2] === "") return null;
  // `attributes:d` is the DIRECTORY filter, and Everything answers THAT value from the index: 738,526 rows in
  // 45 ms (2026-11-07, C:/tmp/esq199) with NOTHING else in the query, and `<folder | attributes:d>` at 740,856
  // in 55 ms, while every OTHER value
  // walks — `attributes:h` 7,651 in 60.9-61.3 s, `attribute:h` 7,651 in 60.9 s, `attributes:hd` 1,246 in 67.7 s,
  // `attributes:rd` 1,015 in 86.8 s (round 195 F-195-06, C:/tmp/esq195). So a `d`-ONLY value is not scan-only:
  // refusing its count was a false refusal that cost an answer its disclosure, because the candidate-cap family's
  // folder probe never learned the row count of an all-folder scope (`everything_grep` with query `attributes:d`
  // printed `the Everything query selected 0 candidate files` with no folder sentence at all for a scope of
  // the whole folder population, 738,466 of them on 2026-11-05). The `!`/`>`/`<` decoration inside the value is
  // admitted because es.exe 1.5 IGNORES it (F-195-07): `attributes:!d` and `attributes:>d` answer the IDENTICAL
  // folder count as the bare value - one population, three spellings, re-measured equal in every drive since
  // round 195 (F-199-05's rule: an equivalence states the relation, because the absolute number moves between
  // drives - 738,467 / 738,501 / 738,526 across three sittings). So
  // a decorated value is the same indexed filter asked with noise, not a different question. Any value that
  // carries a second flag walks even with `d` in it, and stays scan-only.
  // Round 196 F-196-05 asked whether that exception should be WIDER and measured that it should not. Everything
  // IGNORES a letter it does not know, so those counts answer from the index too (`-argv -get-result-count`,
  // C:/tmp/esq196: `attributes:q` 3,758,871 in 289 ms, `attributes:zz` 3,758,870 in 45 ms, and `attributes:dq`
  // the SAME 738,482 as `attributes:d` in 189 ms). But the ignored set is not every unknown token:
  // `attributes:x` answered 1 after 68,530 ms, `attributes:directory` 0 after 67,952 ms and `attributes:dat` 0
  // after 68,385 ms - walks that answered, in exactly the shapes a caller mistypes. This tool cannot tell a
  // letter Everything ignores from a flag it has never timed, so the exception names only the value proven
  // indexed: a mistyped `attributes:q` gets a refusal in 2 ms instead of a 3.7 M whole-index "count".
  if (/^attrib/i.test(m[1]) && /^[<>!]?d$/i.test(m[2])) return null;
  return `${m[1].toLowerCase()}:`;
}

/** True for a term that matches the WHOLE INDEX, so ANDing it onto a query restricts nothing. Measured
 *  2026-11-05 on a 3,779,185-row index: `*`, `**`, `***` and a bare `<` each answered 3,779,189-3,779,229,
 *  and so did `regex:`, `len:`, `type:`, `ancestor:`, `path:`, `name:`, `dm:`, `attrib:` (plus `attributes:`
 *  and `attribute:`) with an EMPTY argument - while `ext:` empty = 246,263, `childname:` empty = 529,192,
 *  `file:` empty = 3,039,410, `size:` empty = 3,428,967 and `parent:` empty = 4, so an empty argument is
 *  NOT a shortcut for "everything", and `.*` (12,263) and `?` (108,207) are ordinary name patterns. The cost
 *  of counting one as narrowing is the whole leash: `<…answertrim | dc:today>` ANDed with `*`, `**`, `<`,
 *  `len:`, `type:` or a spaced `regex:` never answered inside 20 s, exactly like the union alone, while the
 *  same union ANDed with `ext:bin` answered 46 rows in 88-249 ms.
 *
 *  Round 97 added the `## Modifiers` family, measured on a 3,781,052-row index (C:/tmp/esq97/p1-p2.mjs):
 *  `ww:`, `whole-word:`, `case:`, `prefix:`, `suffix:`, `start-with:`, `end-with:`, `^:`, `$:`, `soundex:`,
 *  `ignore-punctuation:`, `ignore-whitespace:`, `diacritics:`, `wildcards:`, `ascii:`, `fullpath:` and
 *  `dotall:` each answered the index total 3,781,052 with an EMPTY argument - and that is what a SPACED
 *  modifier really is: `ww: readme93` is the empty `ww:` term ANDed with a plain name term, so the
 *  whole-word reading is silently lost while the term bounds nothing. Before this line the same union ANDed
 *  with `ww:` or `case:` burned the full 15 s count leash where `*` refuses in 7 ms. Ten `no-` twins were
 *  measured the same way (`no-ww:`, `no-case:`, `no-prefix:`, `no-suffix:`, `no-start-with:`,
 *  `no-end-with:`, `no-soundex:`, `no-ignore-punctuation:`, `no-wildcards:`, `no-diacritics:`), so the twin
 *  rides the same `(no-)?`. NOT admitted, with their measured empty counts: `whole:` = 0 and `wfn:` = 0,
 *  `separator:` = 0, `unescape:` = 0, `lastsegment:` = 0, `hasslash:` = 0 (a 0-row term restricts HARD, so
 *  it stays narrowing), `folder:` = 739,909, `file:` = 3,041,143, `child:` = `childname:` = 529,112,
 *  `ext:` = 247,254, `size:` = 3,430,664, `parent:` = 4. */
function wholeIndexTerm(text: string): boolean {
  const core = text.replace(/^\s+/, "").replace(/\s+$/, "");
  return core === "<" || core === "*" || core === "**" || core === "***"
    || /^(regex|len|type|ancestor|path|name|dm|attrib|attributes|attribute):$/i.test(core)
    || /^(no-)?(ww|whole-word|case|prefix|suffix|start-with|end-with|soundex|ignore-punctuation|ignore-whitespace|diacritics|wildcards|ascii|fullpath|dotall|\^|\$):$/i
      .test(core);
}

/** True when a term supplies search criteria of its own - anything but a scan-only term, anything but a
 *  whole-index term (see wholeIndexTerm), anything but a bare `!`/`(`/`)`, and never an empty string. The head
 *  is NOT stripped here: `scanTermOf` reads a leading `!` itself, and a `!`-headed term is a NOT that restricts
 *  hard - `<…answertrim | dc:today>` ANDed with `!*` or `!regex:` answers 0 rows in under 60 ms, while it ANDed
 *  with `*` or `**` never did. A bare `>` still counts as narrowing: it is a term matching 0 rows. */
function narrowingTermText(text: string): boolean {
  const core = text.replace(/^\s+/, "").replace(/\s+$/, "");
  // A bare operator character restricts nothing: `andParts` hands the bang of a `!<G>` query over as its own
  // term, and counting it as narrowing hid `!<…answertrim | dc:today>` from the refusal (round 68).
  if (core === "" || /^[!()]+$/.test(core)) return false;
  return scanTermOf(core) === null && !wholeIndexTerm(core);
}

/** The `|` splits at THIS level of one expression: outside quotes, and outside a `<...>` group, where a `>`
 *  glued to `word:` is a comparator and does not close the group (see comparatorGt). Any `<` opens a level
 *  here, including the one a function argument glues to `:` (`ext:<bin|txt>`): that `|` belongs to the
 *  function, so it must not be read as an alternative of this expression. */
function topLevelAlternatives(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inQuote) {
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === "<") {
      depth++;
      continue;
    }
    if (ch === ">" && depth > 0 && !comparatorGt(text, i)) {
      depth--;
      continue;
    }
    if (ch === "|" && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** One ANDed expression cut into its plain terms and its `<...>` groups (spans from groupsIn, so a function
 *  argument and a quoted `<` stay terms). */
function andParts(text: string): Array<{ kind: "term"; text: string } | { kind: "group"; body: string }> {
  const out: Array<{ kind: "term"; text: string } | { kind: "group"; body: string }> = [];
  const pushTerms = (chunk: string) => {
    for (const t of splitQueryTerms(chunk)) out.push({ kind: "term", text: t });
  };
  let pos = 0;
  for (const g of groupsIn(text, -1)) {
    // groupsIn reports EVERY group, a nested one as its own entry right after the group holding it. Taking
    // both spans would leave the outer group's closing `>` behind as a term of its own, and one `>` is
    // non-empty text, so it would read as a narrowing term and hide the shape (`<AQ | <dc:today | *.bin>>`
    // came back unrestricted for exactly that reason). A group already inside a taken span is skipped.
    if (g.start < pos) continue;
    pushTerms(text.slice(pos, g.start));
    out.push({ kind: "group", body: g.body });
    pos = g.end;
  }
  pushTerms(text.slice(pos));
  return out;
}

/**
 * Which term of ONE KIND in this expression is asked of the WHOLE INDEX, and whether a union put it there.
 * An AND restricts: one narrowing part narrows every other part. An alternative does NOT: each side of a
 * `|` or `<a|b>` is evaluated on its own, so a term standing alone on one side is unrestrictable by anything
 * else in the query, and `union` comes back true. An unrescued term inside a group makes the GROUP unrestricted
 * too, so it does not count as the narrowing part of the AND above it.
 * `rules` says which kind of term is hunted and what counts as narrowing for it, because the scan families (see
 * `soleScanOnlyTerm` / `unionScanOnlyTerm`) and the per-entry value functions (see `perEntryPropertyAsk`) ask one
 * question about two kinds of un-indexed term. Round 69 grew a second copy of this analysis for the value
 * functions and the two immediately disagreed about what `narrows` means, so there is one body and two rule sets.
 */
interface SideRules {
  /** The term this analysis hunts, named the way its refusal names it, or null when this term is not one. */
  classify: (text: string) => string | null;
  /** Whether this term bounds a search for the OTHER parts of its AND. */
  narrows: (text: string) => boolean;
}
const SCAN_SIDE_RULES: SideRules = { classify: (t) => scanTermOf(t), narrows: (t) => narrowingTermText(t) };
/** A per-entry value function rescues its own AND no more than a scan term does (Everything still walks to
 *  answer for it), so it is taken out of `narrows`. That is the ONLY difference from the scan rules. */
const PROPERTY_SIDE_RULES: SideRules = {
  classify: (t) => perEntryTermOf(t),
  narrows: (t) => narrowingTermText(t) && perEntryTermOf(t) === null,
};

function unrescuedSideBy(
  text: string,
  depth: number,
  rules: SideRules,
): { term: string; union: boolean } | null {
  if (depth > 8) return null;
  const alts = topLevelAlternatives(text.trim());
  if (alts.length > 1) {
    for (const alt of alts) {
      const inner = unrescuedSideBy(alt, depth + 1, rules);
      if (inner) return { term: inner.term, union: true };
    }
    return null;
  }
  const parts = andParts(text);
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p.kind === "term") {
      if (rules.narrows(p.text)) return null;
      continue;
    }
    if (!unrescuedSideBy(p.body, depth + 1, rules) && splitQueryTerms(p.body).length > 0) return null;
  }
  for (const p of parts) {
    if (p.kind === "term") {
      const term = rules.classify(p.text);
      if (term) return { term, union: false };
      continue;
    }
    const inner = unrescuedSideBy(p.body, depth + 1, rules);
    if (inner) return inner;
  }
  return null;
}

function unrescuedScanSide(
  text: string,
  depth: number,
): { term: string; union: boolean } | null {
  return unrescuedSideBy(text, depth, SCAN_SIDE_RULES);
}

/** A per-entry value function this query can ask of nothing but the whole index, or null when something narrows
 *  it (measured: `latitude:47 ext:mp3` = 0 rows / 131 ms with a 167-row partner, `latitude:47` alone silent in
 *  20-30 s - see PER_ENTRY_PROPERTY_FUNCTIONS for the set and the row-scale limit). Refused as a count AND as a
 *  list. `patternIndex` is deliberately NOT consulted, because under `-regex` a `word:`-prefixed pattern is still
 *  the FUNCTION: measured today, `-r` and plain counts are EQUAL for `ext:bin` (3,536 = 3,536),
 *  `datemodified:today` (14,613 = 14,613), `zz:qq` (0 = 0) and `height:>100` (silent BOTH ways), while `*.bin`
 *  DIFFERS (0 as a regex, 3,845 as a pattern) - that last row is what proves regex mode really was on for the
 *  equal ones. */
export function perEntryPropertyAsk(
  query: string,
): { term: string; union: boolean; why: "perEntryProperty"; columns?: string[] } | null {
  const hit = unrescuedSideBy(query, 0, PROPERTY_SIDE_RULES);
  if (!hit) return null;
  // An AND of TWO un-indexed columns used to name the first one only. A UNION refusal is about one side, so it keeps
  // naming that side; the AND case names every column the query carries, ordered by name so the account cannot
  // depend on typing order (round 204 F-204-08).
  const cols = hit.union ? [] : [...new Set(splitQueryTerms(query)
    .map((t) => perEntryTermOf(t)).filter((t): t is string => t !== null))];
  return { term: hit.term, union: hit.union, why: "perEntryProperty",
    columns: cols.length > 1 ? cols.sort((a, b) => a.localeCompare(b)) : undefined };
}

/**
 * The scan-only term sitting on ONE SIDE of a union with nothing ANDed onto it, or null.
 * `soleScanOnlyTerm` covers a query made ONLY of scan terms and deliberately lets every grouped shape keep
 * the normal leash; this is the shape that leash cannot answer. Measured 2026-11-05 on a healthy index
 * (`<>` = 79 ms, 3,778,723 rows) with a 20 s leash, `AQ` = `ancestor:"C:/tmp/esq-e2e-fixtures/answertrim"`:
 * NEVER ANSWERED - `AQ | dc:today`, `<AQ | dc:today>`, `<AQ | dc:today | *.bin>`, `<AQ | attrib:dat>`,
 * `!<AQ | dc:today>`, `<AQ | <dc:today | *.bin>>`, `<<AQ | dc:today> | *.bin>`, `dc:today | *.bin`;
 * ANSWERED - `dc:today AQ` 405/167 ms, `AQ dc:today | *.bin` 405/65 ms, `ext:bin <AQ | dc:today>` 46/88 ms,
 * `AQ <ext:bin | dc:today>` 405/64 ms, `attrib:dat AQ` 0/63 ms, `!dc:today AQ` 0/189 ms,
 * `ext:bin <AQ | <dc:today | *.bin>>` 3,536/47 ms (an AND outside the OUTER group reaches the inner union),
 * `"dc:today"` 0/211 ms and `<AQ | "dc:today">` 405/62 ms (a quote makes it a name). Under `regex: true` the
 * first term is the engine's PATTERN, whose `|` is regex alternation and not Everything's union, so
 * `patternIndex === 0` keeps the leash - `soleScanOnlyTerm` still refuses a pattern made only of scan terms,
 * which is right: `-regex dc:today` never answered either (20 s), while `-regex dc:today` with `ext:bin`
 * behind it counted 46 in 193 ms. CALENDAR TRAP (round 80): every `dc:today` row above was read on the day the
 * fixture folder WAS "today" - on 2026-11-05 `dc:today AQ` counts 0 (63 ms) and `-regex dc:today` + `ext:bin`
 * counts 4, while the FIXED-date forms keep the grammar evidence: `dc:2026-11-04 AQ` 405/65 ms, `dc:2026-11-04`
 * and `<AQ | dc:2026-11-04>` never in 22 s, `-regex dc:2026-11-04` never in 22 s, `-regex dc:2026-11-04 ext:bin`
 * 57/317 ms. User-facing examples quote the dated spellings for that reason.
 */
export function unionScanOnlyTerm(query: string, patternIndex = -1): string | null {
  if (patternIndex === 0) return null;
  const hit = unrescuedScanSide(query, 0);
  return hit && hit.union ? hit.term : null;
}

/** What this query's count can never return, and which shape put it there; null when the count is askable.
 *  `why` is absent for the scan-only families (then `union` says which of the two it is) and names the other
 *  two, which are not about narrowing at all: see NEVER_COUNTABLE and PER_ENTRY_PROPERTY_FUNCTIONS. */
export interface ScanSkip {
  term: string;
  union: boolean;
  why?: "neverCountable" | "perEntryProperty" | "propertyWalkWide";
  /** `propertyWalkWide` only: the entries the ANDed partners match, and what this leash can pay for. */
  rows?: number;
  /** `propertyWalkWide` only, and only when the query carries more than one: EVERY per-entry column priced, and
   *  `usPerRow` is their SUM. `term` is the dominant one. */
  columns?: string[];
  leaseRows?: number;
  leaseMs?: number;
  usPerRow?: number;
}

/** `da:`/`dateaccessed:` cannot be counted here at all, and nothing makes them countable. Measured 2026-11-05
 *  on a 30 s leash, 15 shapes, every one silent: `da:today` alone, with a 405-entry folder ANDed, with a
 *  2,045-entry one, with `ext:mjs`, with `ext:exe` (the narrowing that DOES rescue `dc:` - `dc:2026-11-01
 *  ext:exe` = 99 rows / 357 ms), with `size:>1kb`, with `dm:>monday`, as `!da:today`, as `<AQ | da:today>`, as
 *  a `|` side, under `sort:name`, as `da:>2026-01-01`, as `da:h`, as empty `da:`, and a bounded listing of the
 *  folder-scoped form. What answered then was a bounded listing with NO scope: `-n 5 da:today` = 5 rows in 5.1 s,
 *  because Everything can stop as soon as it holds 5 rows - and a DENSE partner answers too (`da:2026-11-07
 *  !attributes:d` filled 2,001 rows in 4.2 s). Round 196 deleted this comment's folder-blaming mechanism clause:
 *  the discriminator is how DENSE the conjunction is, not whether a folder is named.
 *  Round 73 re-ran the family WARM, twice at each of four partner scales (167 / 1,104 / 9,669 / 10,439 entries,
 *  `C:/tmp/esq73/p1.mjs` A): all eight counts were still silent at 20 s, so this is NOT the cold-cache effect
 *  that moved round 72's walk constant. The lesson is the mechanism - an ANDed partner bounds a `da:` walk NOT AT
 *  ALL (a 167-entry partner is as silent as a 10,439-entry one), which is why this family cannot be priced the
 *  way `widePropertyWalk` prices a per-entry value function. */
const NEVER_COUNTABLE = /^(da|dateaccessed):/i;

/** Functions whose value Everything does not index, so answering for one means testing every entry. Measured
 *  2026-11-05 on healthy-index leashes of 18-30 s. UNSCOPED, each of these answered NEITHER `-get-result-count`
 *  NOR a bounded `-n 3`/`-n 5` listing: `latitude:47`, `longitude:12`, `dateacquired:today`, `width:>100` (round
 *  69) and, today, `height:>100`, `page-count:>10`, `pagecount:>10`, `author:nobody`, `bitrate:>100`,
 *  `duration:>10`, `channels:>1`, `sample-rate:>10`, `dimensions:>0`, `date-taken:today`, `datetaken:today`,
 *  `artist:x`, `title:x`, `album:x`, `genre:x`, `comment:x`, `description:x`, `copyright:x`, `company:x`,
 *  `dateprinted:today`. Three neighbouring spellings ANSWERED and are deliberately NOT here: `framewidth:>100`
 *  0 rows / 472 ms, `frameheight:>100` 0 / 64 ms, `trackno:>1` 0 / 473 ms. An indexed date is not either
 *  (`datemodified:today` = 3 rows / 447 ms unscoped).
 *  ROUND 70'S CORRECTION to round 69's reason ("only a place scope bounds them"): a partner whose OWN result set
 *  is small rescues them - `latitude:47 ext:mp3` = 0 rows / 131 ms and `artist:x ext:mp3` = 1 row / 524 ms, with
 *  `ext:mp3` = 167 rows - while a broad one does not (`ext:png` 68,637, `ext:mjs` 116,240, `*.dll` 113,781,
 *  `size:>1kb` 2,274,644, all silent). So the rule below asks only whether ANYTHING narrows the term; a query
 *  with a broad partner stays on the normal leash, because the row count separating 167 from 68,637 is
 *  unmeasured. Under `-regex` these are still the functions, not patterns (see perEntryPropertyAsk).
 *  ROUND 75 added ten names, each measured the same two ways - SILENT unscoped at a 15-16 s cap, then answering
 *  in 281-334 ms once `ancestor:"C:/tmp/esq-e2e-fixtures/answertrim"` bounded it (`C:/tmp/esq75/p1.mjs` 2,
 *  `p2.mjs` A, `p3.mjs`, `p4.mjs`): `orientation:`, `keywords:`, `cameramodel:`, `camera-model:`,
 *  `camera-maker:`, `frame-rate:`, `bit-depth:`, `bit-rate:`, `date-acquired:` (the hyphen form of the listed
 *  `dateacquired:`) and `date-printed:`. Six spellings answered UNSCOPED and are deliberately NOT here, which is
 *  what makes the ten a measurement and not a pattern guess: `track-number:>1` 0 rows / 48 ms,
 *  `height-of-sample:x` 0 / 48 ms, `system-title:x` 0 / 257 ms, and Everything's compound shortcuts
 *  `photo:today` 0 / 47 ms, `video:today` 1 / 48 ms, `media:today` 0 / 48 ms.
 *  ROUND 101 added `hard-link-count:` and its two dashless twins, from the same two-sided test. UNSCOPED it
 *  answered neither a count (never inside the 15 s leash) nor a bounded `-n 5` listing (`>1` never inside 25 s;
 *  `>0`, which every row satisfies, took 5.6-5.8 s), while `ancestor:"…\mod93"` answered it in 76-83 ms and
 *  `ancestor:"…\mod93" hard-link-count:1` = 38 of that scope's 40 rows in 52 ms (every plain file is one link;
 *  the two names of the hard-linked pair are the other two). Before this it was an UNGUARDED cost: the deployed
 *  tool spent its whole leash and threw a generic timeout (count 15,050 ms, list 30,048 ms, grep 30,042 ms). It
 *  is the CHEAPEST gathered column measured (9 us an entry - `ext:mjs` 116,417 candidates in 1,036 ms, `ext:ts`
 *  324,990 in 3,055 ms), so it gets a rate pair of its own below. `C:/tmp/esq101/p3.mjs` E-F, `p4.mjs` 1-2,
 *  `p5.mjs` 1. */
const PER_ENTRY_PROPERTY_FUNCTIONS = /^(latitude|longitude|dateacquired|width|height|page-count|pagecount|page_count|author|bitrate|duration|channels|sample-rate|samplerate|sample_rate|dimensions|date-taken|datetaken|date_taken|artist|title|album|genre|comment|description|copyright|company|dateprinted|date-printed|date-acquired|bitdepth|bit-depth|bit-rate|framerate|frame-rate|orientation|keywords|cameramodel|camera-model|camera-maker|hard-link-count|hardlink-count|hardlinkcount):/i;

/** How many SPELLINGS that set admits - the number the per-entry refusals quote. DERIVED, because the count used
 *  to be re-typed: the list body still said "all 24 such functions" two rounds after the set passed 40 spellings
 *  (rounds 71 and 75 grew it and round 108 found the number). A spelling is a way of writing a name, so this is
 *  deliberately not "functions" - `page-count`, `pagecount` and `page_count` are three of these. */
const PER_ENTRY_PROPERTY_SPELLINGS = (() => {
  const src = PER_ENTRY_PROPERTY_FUNCTIONS.source;
  return src.slice(src.indexOf("(") + 1, src.lastIndexOf(")")).split("|").length;
})();

/** The per-entry value function this term is, named the way the refusal names it, or null. The head strip is the
 *  one `scanTermOf` uses (a function glued behind a group opener IS that function, round 69); a leading `(` is
 *  not stripped (a paren-headed term is a literal name) and a QUOTE shields (`"width:10"` is a name). */
export function perEntryTermOf(text: string): string | null {
  const core = text.replace(/^[!<\s]+/, "").replace(/[)\s]+$/, "");
  if (!PER_ENTRY_PROPERTY_FUNCTIONS.test(core)) return null;
  const m = /^([A-Za-z][A-Za-z0-9_-]*):/i.exec(core);
  return m ? `${m[1].toLowerCase()}:` : null;
}

/** Microseconds Everything spends per entry once an ANDed term has bounded a per-entry value walk, measured on a
 *  WARM index. Round 72 re-ran round 71's own ladder (`C:/tmp/esq72/p3.mjs` A): `latitude:47` with partners of
 *  1,104 / 2,328 / 9,669 / 9,900 / 10,439 entries answered in 124 / 217 / 701 / 725 / 897 ms - 70 to 110 us per
 *  entry - and with 74,767 entries in 6,039 and 6,042 ms on two repeats. Seven columns at 74,767 entries
 *  (`C:/tmp/esq72/p2.mjs` B-C): `duration:` 6,030 ms, `latitude:` 6,046, `longitude:` 6,063, `author:` 6,118
 *  (about 81 us each), `width:` 11,318, `bitrate:` 11,514, `height:` 11,556 (151-155 us each); the slowest
 *  marginal rate seen anywhere is `height:>100 ext:json` at 83,454 entries = 10,736 and 13,580 ms (129-163 us).
 *  170 us is that worst rate rounded up, so the guarantee runs the other way from how the constant reads: an
 *  ACCEPTED walk is one that fits the leash even at the slowest speed this box has shown, and a refusal is a
 *  query a FASTER column might still have finished inside it. The constant promises nothing about refusals.
 *  A column whose own counts measure past this band leaves it and gets a row of its own - `dimensions:` at 1,000 us,
 *  `orientation:` at 600 us (round 203 measured 420-511 us an entry on it at scales this default leases freely).
 *  ROUND 71 SET THIS TO 1,000 us from the COLD curve of ONE column and that over-refused by up to ten times: it
 *  refused `height:>100 ext:json` (answered in 10.7 s) and `latitude:47 *.md` (answered in 6.0 s) after 47 ms.
 *  A cold first walk really is several times slower - round 71's `latitude:47 *.md` never answered inside 25 s
 *  while a later run answered it in 6.0 s - so this number cannot promise a COLD walk fits the leash either; it
 *  is the floor of what the walk costs, and the cold penalty is not measured per column. */
const PROPERTY_WALK_US_PER_ROW_COUNT = 170;
/** The SAME walk asked for a LISTING costs several times more per entry, because a listing materialises names and
 *  a count does not. Measured back to back twice each (`C:/tmp/esq72/p5.mjs`): `latitude:47` answered `-n 3` with
 *  167 candidates in 292 and 298 ms, with 1,104 in 649 and 638 ms, with 9,669 in 5,058 and 5,138 ms - 0.52 to
 *  0.59 ms per entry against the count path's 0.06-0.09 for the same sizes - and with 74,767 candidates it never
 *  answered inside 40 s either time, which is the timeout this constant exists to refuse.
 *  ROUND 74 re-measured that rate on FOUR columns against ONE partner (`ext:xml`, 9,669 candidates, two runs
 *  each, `C:/tmp/esq74/p1.mjs` 2): `latitude:` 5,081 and 5,019 ms (525 / 519 us an entry), `author:zz` 5,098 and
 *  5,026 ms (527 / 520), `duration:>1` 4,936 and 4,937 ms (510) - but `height:>100` 9,007 and 8,996 ms (931 /
 *  930). The 600 us above came from `latitude:` ALONE, and it UNDER-priced the same family round 72 found slow on
 *  the count path (`width:`/`bitrate:`/`height:`): at 600 us the list lease admitted 50,000 entries, and a
 *  50,000-entry `height:` walk costs about 46 s of a 30 s leash - the guard let through a walk that cannot fit.
 *  So this constant is now the WORST rate seen on any column (1,000 us, 7% over the 931 observed), the way the
 *  count constant is the worst count rate. A per-column table would need LIST-path rates for all 30 names and only
 *  four have any. The same cold penalty applies, so it is a floor, not a prediction. */
const PROPERTY_WALK_US_PER_ROW_LIST = 1000;

/** `dimensions:` is a measured outlier and gets its own pair: 2,242 ms for a count over a 9,669-entry partner
 *  (232 us an entry, against 68-73 for twelve other columns) and 16,863 ms for a listing of the same candidates
 *  (1,744 us, against 505-544, and 1.8x `height:`'s 931). `C:/tmp/esq75/p1.mjs` section 1.
 *  Round 196 F-196-13 raised the COUNT half from 250: `dimensions:>0 size:>16mb` - 20,578 entries, which the
 *  250 us rate bought at a 60,000-entry lease - spent the whole 15 s count leash and never answered, while the
 *  LIST half refused the same query at 70 ms (C:/tmp/esq196/out196.txt A12 vs B10). A 20,578-entry count costing
 *  over 15 s puts this column's count rate above 728 us an entry at that scale: superlinear over round 75's
 *  9,669-entry reading, not a contradiction of it. 1,000 us buys a 15,000-entry lease, which keeps the measured
 *  9,669-entry answer (2,242 ms) and refuses the shape that only loses the leash.
 *  ROUND 200 re-drove the LIST half over two OTHER partners (`C:/tmp/esq200`, `-argv -n 5`, counts taken the same
 *  hour, every rate below FLOORED): a 0-match `dimensions:>100000` listed 4,649 `ext:ini` candidates in 17,900 ms
 *  (3,850 us an entry) and 9,942 `ext:html` candidates in 40,637 ms (4,087 us), while those same two queries COUNTED
 *  0 in 4,092 and 6,892
 *  ms. Round 75's 1,744 us is the SAME SHAPE on a third corpus, not an easier one: `p1.mjs` swept
 *  `dimensions:x ext:xml` at `-n 3` over a 9,669-entry partner and divided ms by that whole partner, and `ext:xml`
 *  carries no dimensions values, so that walk read all 9,669 and returned nothing.
 *  ROUND 201 moved this half from 1,800 to 5,000. Five corpora now carry a 0-match `dimensions:x` listing at `-n 3`
 *  (a sixth, `ext:svg`, is over every lease in play), which is the only shape this column has ever been timed on: a
 *  predicate nothing holds, so es.exe reads every candidate and returns nothing. No listing whose candidates MATCH
 *  has been measured, because `dimensions:>1 ext:jpg` and `dimensions:>100 ext:png` answered nothing inside 20 s of
 *  count and 40 s of listing either - the values are not indexed, so there is no dense corpus to stand on
 *  (C:/tmp/esq201/out201.txt, out201b.txt). Every rate quoted is that drive's MILLISECONDS over the partner's ROW
 *  COUNT, FLOORED. 2026-11-07: `ext:xml` 9,657 at 2,839 and 3,678; `ext:ini` 4,649 at 3,898 and 3,929; `ext:html`
 *  9,942 at 4,254 and 4,275 (out201.txt); `ext:css` 6,897 at 2,098 and 2,186 and `ext:log` 8,054 at 1,770 and 1,755
 *  (out201b.txt).
 *  THE FINDING IS NOT THE SPREAD, IT IS THE DRIFT. The 2,098 us `ext:css` walk measured at 08:00 cost 4,400 us an
 *  entry when the SAME query was re-driven at 08:10 (14,470 ms, then 30,349 ms), and the 1,770 us `ext:log` walk
 *  measured at 08:00 blew this call's 30 s budget at 08:06 (>= 3,725 us). One corpus, ten minutes, 2.1x - so the
 *  rate is neither a column constant nor a day constant, and no midpoint of any window stays right for long. Two
 *  controls say the drift is the box and not the call: page size (the identical `ext:ini` 0-match walk took 16,802 ms
 *  at `-n 3` and 9,106 ms at `-n 500`) and call shape (the bare `-n 3` stdout probe, the same fetch with
 *  `-export-txt`, and this tool's own list path cost 18,441 / 18,221 / 20,561 ms - about 10% apart).
 *  So this half follows the discipline the other constants state out loud - price above the WORST rate this box has
 *  shown, with a margin: 5,000 us an entry, 8.7% over the worst measured 4,601 (the 21,394 ms the suite's own
 *  admitted-side drive spent over `ext:ini` 4,649 at 08:31, after the 4,486 of its 20,858 ms run at 08:18 - the same
 *  corpus, the same query, thirty minutes apart), which buys a 6,000-entry lease. A drive that lands ABOVE 5,000 is a
 *  finding, not a surprise: the constant is re-derived from it, and a rate past 6,452 would refuse even `ext:ini`. That admits exactly one of the
 *  five corpora - `ext:ini` 4,649, the only corpus that held still: 16.8-20.9 s across nine `-n 3` drives in two
 *  days, its `-n 500` reading not comparable - and refuses `ext:css` 6,897 (14.5 s warm, 30.3 s cold: the coin flip
 *  this rate decides against), `ext:log` 8,054, `ext:xml` 9,657, `ext:html` 9,942 and `ext:svg` 25,206 - the last in
 *  every rate in play. At the old
 *  1,800 (16,666 entries) every corpus in the set but `ext:svg` was admitted, and six of the drives named in this
 *  comment spent the whole 30 s to answer nothing (`ext:html` 40,637, 42,295 and 42,504; `ext:xml` 35,525; `ext:css`
 *  30,349; `ext:log` through this tool at 30,166); at the midpoint this round first chose (3,060, a 9,803-entry
 *  lease) `ext:css`, `ext:log` AND `ext:xml` were still admitted and three of those six drives sat inside it anyway.
 *  A refused `dimensions:` LIST costs the caller 40-62 ms and a measured number to narrow against; an admitted one
 *  costs up to 30 s. Nothing here forecasts a COLD walk - the cold penalty is not measured per column - so the
 *  timeout steer is still what a caller who is admitted gets. */
const PROPERTY_WALK_US_PER_ROW_COUNT_DIMENSIONS = 1000;
const PROPERTY_WALK_US_PER_ROW_LIST_DIMENSIONS = 5000;

/** `orientation:` is the mirror case of `dimensions:`: its LIST path is almost free - but for one spelling family
 *  only - while its COUNT path walks like every other column. The same queries that counted in 661 ms, 11,458 ms
 *  and 58,220 ms over partners of 9,669,
 *  68,389 and 113,674 entries LISTED in 47 ms, 47 ms and 50 ms (`-n 3` and `-n 500` alike), while four control
 *  columns (`keywords:`, `cameramodel:`, `bit-rate:`, `date-acquired:`) were still listing 68,389 entries when the
 *  probe's 60 s expired. Pricing a listing at the default 1,000 us therefore refused `orientation:>1 ext:png`
 *  (68,389 entries) - an answer that costs 47 ms. That rate is 0.7-5.2 us an entry (round 202 re-drove the same
 *  shape at `-n 3`: 46-50 ms over a 9,657 corpus and 49-51 ms over a 68,323 one), so 50 us is a 9.6-70x margin,
 *  which still refuses a whole-index listing. Round 196 F-196-03 killed this comment's claim that the big scale was
 *  "unreachable anyway - an unscoped `orientation:` is refused by `perEntryPropertyAsk` before any price is
 *  consulted": round 195 made the indexed DIRECTORY value a narrowing PARTNER, so `orientation:>0 attributes:d`
 *  prices at the whole folder population (738,482 entries on that drive; 738,526 on 2026-11-07's) and
 *  `orientation:>0 !attributes:d` at the file half (3,020,389 there; 3,020,538 on 2026-11-07), and both are
 *  refused in 44-46 ms (C:/tmp/esq196/out196.txt B7/B8, re-counted C:/tmp/esq199/out199.txt). Unscoped is still refused by `perEntryPropertyAsk`; an indexed partner is
 *  now what reaches the price. `C:/tmp/esq76/p1b.mjs`, `p3.mjs`. Its COUNT rate stays the default - and that
 *  asymmetry is what F-196-04 in `fetchEsList` now handles.
 *  ROUND 202 FOUND THE CHEAPNESS BELONGS TO THE VALUE, NOT TO THE COLUMN. Nine `orientation:` spellings were run
 *  at `-n 3` over two partners (`C:/tmp/esq202/out202d.txt`, 2026-11-07: 9,657 `ext:xml`, 68,323 `ext:png`). The
 *  four `>` comparisons (`>0`, `>1`, `>=1`, `>2`) each answered 0 ROWS - 46-50 ms on `ext:xml` (4.8-5.2 us an entry)
 *  and 49-51 ms on `ext:png` (0.7). Every other value paid a walk - `orientation:x` 15,504 ms and
 *  `orientation:landscape` 17,510 ms over `ext:xml` (1,605 and 1,813 us an entry) - and `orientation:1`,
 *  `orientation:<2`, `orientation:<1000000` and `orientation:x` were each silent past the probe's 40 s cap on at
 *  least one corpus (>= 4,143 us an entry on `ext:xml`, 0 rows). BOTH families were timed on 0-match listings: the
 *  `>` shapes are cheap at ZERO rows, which is the shape that elsewhere means "read every entry" - `orientation:x`
 *  over the same `ext:xml` needed 15,504 ms to answer the same 0 rows, an 800x gap at an identical match count -
 *  and no `>`-family listing that MATCHES has ever been timed. A listing whose candidates MATCH stops early and is
 *  cheap whatever the spelling (`orientation:landscape ext:png`: 1,483 ms, 3 rows), which no per-entry price can
 *  see in advance. `orientation:>x` (a `>` with no digit) also came in at 51 ms on `ext:xml`, and stays on the
 *  expensive price on purpose: one 0-match drive on one corpus is not a reason to widen an admit. So the 50 us
 *  price covers the `>`-with-a-digit family only now, and every other value of this column prices at 5,000 us - the
 *  worst-of-observed rule `dimensions:` follows, with the caveat that 4,143 us is a floor a 40 s cap established
 *  rather than an observed completion - a 6,000-entry lease, 20% over that floor. That deliberately refuses answers
 *  this box gives (`orientation:x ext:xml` lists in 15.5 s) to bound
 *  one it cannot (`orientation:1 ext:xml`, past 40 s), and leaves a `>`-comparison listing of up to 600,000 entries
 *  untouched, which is what round 76 built the exception for.
 *  ROUND 203 SETTLED THE COUNT SIDE, AND FOUND THAT THE `>` FAMILY HAS NEVER ANSWERED A ROW HERE. Round 202 left
 *  the count rate at the default 170 us and called it an open price. Its rungs are 68, 167 and 512 us an entry (the
 *  three quoted above), plus two measured 2026-11-07 over 58,928 `ext:jpg` (`C:/tmp/esq203/out203a.txt`,
 *  `out203b.txt`): `orientation:landscape ext:jpg` counted its 10,546 matches in 24,773 and 24,850 ms = 420-422 us
 *  an entry, and the mid-scale pair over `ext:jpg size:>1mb` (1,721 candidates) counted 1,132 `landscape` matches in
 *  881 ms and 434 `portrait` in 882 ms = 511-512 us, the worst rate measured on this column. So this column counts
 *  at 600 us an entry - 17% over the worst measured 512 - a 25,000-entry lease, and 25,000 x 512 us = 12.8 s stays
 *  inside the leash instead of spending it. Under the default 170 us these 58,928 candidates sat INSIDE the
 *  88,235-entry lease, which is what a list call the guard prices at 10.0 s is accepted to wait for on a 15 s leash
 *  (the 10.0 s is the arithmetic; that call was not driven through the tool this round). WHAT THE 50 us LIST PRICE
 *  BUYS IS A ZERO-ROW ANSWER, NOT A FAST LISTING: `>0`, `>1` and `>=1` have answered 0 rows at every size tried
 *  here - 9,657 `ext:xml`, 68,323 `ext:png` and these 58,928 `ext:jpg`, where `orientation:` (any value) answers
 *  3,924, `landscape` 10,546 and `portrait` 5,499, so the population holding a value is larger than any single
 *  spelling's count and no `>` spelling has touched any of it. `orientation:1` matches 2 of them and BOTH also
 *  match `orientation:landscape`, yet `orientation:1` ANDed with `>0` or with `>=1` counts 0 (`out203c.txt`). That
 *  is an index-scoped fact, not a claim about what a numeric comparison can mean: `orientation:<1000000`, which the
 *  same reading would call equally empty, walked past a 55 s cap instead of answering instantly (`out203b.txt`), so
 *  the instant LIST answer is spelling-specific behaviour and its mechanism is not measured. The COUNT path does
 *  not share it: the same 0 rows cost 12,364 and 12,350 ms over those 58,928 entries (209-210 us an entry), and
 *  `orientation:>0 attributes:!d` was still counting past 70 s. So ONE rate prices every spelling of this column's
 *  counts - the `>` family's 108-210 us count rungs (the 108 and 118 divide by an `ext:png` population this round
 *  never printed, carried from round 202) are knowingly over-priced, the same one-rate-per-column convention the
 *  rest of this table uses. The error runs toward a refusal that costs the caller a 40-62 ms message rather than a
 *  15 s wait, and the price is not free: in the 25,001-88,235 partner band it withholds counts this box answered
 *  inside the leash (12.0-12.4 s at 204-210 us an entry over 58,928, `out203a/b/c.txt`). */
const PROPERTY_WALK_US_PER_ROW_COUNT_ORIENTATION = 600;
const PROPERTY_WALK_US_PER_ROW_LIST_ORIENTATION = 50;
/** An `orientation:` value that is NOT a `>` comparison: 1,605-1,813 us an entry measured over a 9,657-entry
 *  corpus, and >= 4,143 us past a 40 s cap on that same corpus (the block above), so 5,000 us buys a
 *  6,000-entry lease. */
const PROPERTY_WALK_US_PER_ROW_LIST_ORIENTATION_OTHER = 5000;

/** `hard-link-count:` is the CHEAPEST gathered column measured, so the default pair over-prices it 8.5x and
 *  16.7x and would refuse listings that answer. Measured (`C:/tmp/esq101/p4.mjs` 1, `p5.mjs` 1): COUNT 9 us an
 *  entry at three scales (`ext:mjs` 116,417 candidates -> 984, 1,036 and 1,046 ms; `ext:ts` 324,990 -> 3,021
 *  and 3,055 ms). A `-n 5` LISTING costs 4-10 us an entry when matches are dense (`ext:mjs` 1,167 ms,
 *  `ext:ts` 1,406 ms) and 34-36 us in the worst shape a listing can be - a value NOTHING holds, so es gathers
 *  every entry and then answers 0 (`hard-link-count:99999 ext:mjs` 3,922 ms, `… ext:ts` 11,761 ms). 20 us and
 *  60 us keep 2.2x and 1.7x over the worst observed rates, which puts the leases at 750,000 entries (count)
 *  and 500,000 (listing): `hard-link-count:>1 ext:ts` (324,990 candidates, 1.4-3.0 s) stays ANSWERED, while the
 *  shape that genuinely costs (~27 s: `hard-link-count:>1 !attributes:d`, every file on the index) is refused
 *  before any es call. Nothing here is a prediction - the unscoped sides are the zeros in the set's own note. */
const PROPERTY_WALK_US_PER_ROW_COUNT_HARDLINK = 20;
const PROPERTY_WALK_US_PER_ROW_LIST_HARDLINK = 60;

/** The µs-per-entry pair for ONE column, chosen by the name the refusal will quote. Every family name without a
 *  row of its own rides the default pair, and round 75's sweep supports that: twelve columns with no earlier
 *  timing (`page-count:`, `channels:`, `samplerate:`, `bitdepth:`, `framerate:`, `dimensions:`, `date-taken:`,
 *  `dateprinted:`, `title:`, `album:`, `comment:`, `company:`) all measured 656-708 ms counts and 4,877-5,256 ms
 *  listings against one partner, and only `dimensions:` left that band. Round 76 timed the ten names round 75
 *  added and none needed a pair of its own on the COUNT path (660-1,243 ms at 9,669 entries = 68-128 us); nine
 *  listed inside the default too (4,829-9,461 ms = 500-978 us), and `orientation:` left the band from the OTHER
 *  side. Rounds 74-77 then finished the table: all forty names now have a count timing and a listing timing of
 *  their own against one partner (`C:/tmp/esq77/p2.mjs`, `p3.mjs` added the last fifteen), and only `dimensions:`
 *  (slow on both paths) and `orientation:` (a cheap listing - but only for a `>` comparison, so round 202 split
 *  that pair by value spelling) need a pair of their own. The shell-property columns
 *  sit just UNDER the list constant - `height:` 931, `width:` 948, `bit-rate:` 968-978, `bitrate:` 985 us - so the
 *  margin is 1.5-7%, and widening it by raising the constant would shrink the listing lease below walk sizes this
 *  box answers inside its leash (alias spellings cost the same: `bitrate:` 985 vs `bit-rate:` 968-978, `pagecount:`
 *  and `page_count:` 525 and 514, `sample_rate:` 515, so no alias needs a row). A future SLOW column therefore
 *  shows up as an over-asked leash, not as a wrong answer; a future CHEAP one shows up as a withheld answer, which
 *  is why a name is timed when it joins the family. */
function propertyWalkRates(term: string, rawTerms: string[] = []): { countUs: number; listUs: number } {
  if (/^dimensions:$/i.test(term)) {
    return {
      countUs: PROPERTY_WALK_US_PER_ROW_COUNT_DIMENSIONS,
      listUs: PROPERTY_WALK_US_PER_ROW_LIST_DIMENSIONS,
    };
  }
  if (/^orientation:$/i.test(term)) {
    // Round 202: the cheap listing belongs to the VALUE spelling, not to the column. `perEntryTermOf` hands this
    // function the name with the value stripped, so the caller passes every raw term that resolved to this name.
    // Only `orientation:` opening a term with a `>` or `>=` and a digit is the measured-cheap family (`>0`, `>1`,
    // `>=1`, `>2`: 46-51 ms at 0 rows over a 9,657 and a 68,323 corpus); a negated term, a digitless value
    // (`>x`: 51 ms once, refused on purpose) or any other value pays the expensive price, because those measured
    // 1,605 to past 4,143 us an entry. An AND of two values has to evaluate BOTH, so the expensive price wins
    // unless EVERY term resolving to this column is in the cheap family. The COUNT price is per COLUMN, not per
    // spelling: round 203 measured 420-511 us an entry over corpora the 170 us default leases freely, and the `>`
    // family's cheaper 118-210 us count rungs ride the same 600 us rate on purpose.
    const cheap = rawTerms.length > 0 && rawTerms.every((t) => /^\s*orientation:\s*>=?\s*\d/i.test(t));
    return {
      countUs: PROPERTY_WALK_US_PER_ROW_COUNT_ORIENTATION,
      listUs: cheap
        ? PROPERTY_WALK_US_PER_ROW_LIST_ORIENTATION
        : PROPERTY_WALK_US_PER_ROW_LIST_ORIENTATION_OTHER,
    };
  }
  if (/^hard-?link-?count:$/i.test(term)) {
    return { countUs: PROPERTY_WALK_US_PER_ROW_COUNT_HARDLINK, listUs: PROPERTY_WALK_US_PER_ROW_LIST_HARDLINK };
  }
  return { countUs: PROPERTY_WALK_US_PER_ROW_COUNT, listUs: PROPERTY_WALK_US_PER_ROW_LIST };
}

/** The AND of every narrowing term beside a per-entry value function - the entries the walk has to visit - or
 *  null when this shape is NOT priced. A union is deliberately not priced: round 72 measured `latitude:47
 *  ext:csv | *.md` (75,871 candidate entries) answering in 7,416 ms and the grouped form `latitude:47
 *  <ext:csv | *.md>` in 6,222 ms, so an AND's row count and a union's row count do not cost the same and pricing
 *  the union shape with this rate false-refused answers. Also null for a group inside the AND and for a term that
 *  bounds nothing. A value function with NO partner is not this case: `perEntryPropertyAsk` refuses that one
 *  outright, with no es call at all. */
function propertyPartnerJoin(query: string): string | null {
  if (topLevelAlternatives(query).length > 1) return null;
  const partners: string[] = [];
  for (const p of andParts(query)) {
    if (p.kind !== "term") return null;
    if (perEntryTermOf(p.text)) continue;
    if (wholeIndexTerm(p.text) || !narrowingTermText(p.text)) return null;
    partners.push(p.text.trim());
  }
  return partners.length > 0 ? partners.join(" ") : null;
}

/** A per-entry value walk whose partners are too many to test inside this leash, or null when the walk can be
 *  paid for, cannot be priced, or is not a walk at all. The price is ONE indexed count of the ANDed partners
 *  themselves (40-60 ms measured), which is why it is affordable on every such query: the alternative is
 *  spending the 15 s count leash or the 30 s list leash to learn the same fact from a timeout. */
export async function widePropertyWalk(
  query: string,
  matchFlags: string[],
  signal: AbortSignal | undefined,
  kind: "count" | "list",
): Promise<ScanSkip | null> {
  // The kind picks BOTH the budget and the rate, so no caller can pair the count's leash with the listing's rate
  // (or the reverse) and mis-price the walk: asking for a listing costs several times more per entry.
  const leaseMs = kind === "count" ? COUNT_TIMEOUT_MS : ES_TIMEOUT_MS;
  const terms = splitQueryTerms(query);
  // Round 204: EVERY per-entry column the query carries is priced, not the first one typed, because an AND of value
  // functions can read every candidate entry against EACH of them. The guard prices such a walk at the SUM of their
  // rates - an upper bound, never a forecast. Driven 2026-11-07 over a 68,323-entry `ext:png` partner, `width:>100`
  // counted 33,294 rows in 8,060 ms (118 us an entry) and `orientation:landscape ext:png` counted 15,414 in 15,214 ms
  // (223 us); ANDed they counted 13,114 rows in 15,340 ms, past the 15 s a count gets, while the old price - the FIRST
  // per-entry term only, 170 us and an 88,235-entry lease - admitted it. The truth is each clause's rate over the
  // entries its predecessors left: Everything evaluates ANDed clauses in the order typed and stops a clause at the
  // first test that fails, so a filtering first column makes a later one nearly free. Over 9,657 `ext:xml` the same
  // pair cost 1,207 ms against 1,254 ms and 2,329 ms for its halves, and 2,300 ms typed the other way. How many
  // entries survive a clause costs another walk to learn, so the guard prices the worst case and accepts the
  // over-refusal it can make: measured, `width:>100 height:>100 ext:png` is refused on a summed 340 us although that
  // walk answered 32,063 rows in 11,876 ms. The class is every pair whose FIRST clause filters hard - including an
  // `orientation:` spelling from the cheap `>` family ANDed with an ordinary column, which lists in tens of ms alone.
  const priced = [...new Set(terms.map((t) => perEntryTermOf(t)).filter((t): t is string => t !== null))]
    .map((col) => ({ col, ...propertyWalkRates(col, terms.filter((t) => perEntryTermOf(t) === col)) }));
  if (priced.length === 0) return null;
  const rateOf = (p: { countUs: number; listUs: number }) => (kind === "count" ? p.countUs : p.listUs);
  const usPerRow = priced.reduce((s, p) => s + rateOf(p), 0);
  // `term` stays ONE name - every single-column sentence this tool prints reads it that way - and it is the
  // DOMINANT column of the priced set, not the one the caller happened to type first. Rate first, then NAME: two
  // columns can share a rate (`width:` and `height:` both price at the default), and a bare `>` comparison would
  // hand the account to whichever of them the caller typed first. `columns` is ordered by the same rule, so the
  // refusal an AND of value columns prints depends on the SET it prices and not on the order it was typed in.
  const valueTerm = priced.slice().sort((a, b) => rateOf(b) - rateOf(a) || a.col.localeCompare(b.col))[0].col;
  // The rate belongs to the COLUMN, so it is looked up only once the column is known. Measured against one
  // 9,669-entry partner (`C:/tmp/esq75/p1.mjs` 1), twelve columns walk at 68-73 us an entry on a count and
  // 505-544 us on a listing, `height:` listed at 931 us, and `dimensions:` at 232 us / 1,744 us. Folding that
  // worst rate into ONE constant would have refused `latitude:47 *.md` - a 74,767-entry walk this box answers in
  // 6.0 s - to guard against a column seven times slower, so the slow column is priced at its own speed instead.
  // The VALUES decide `orientation:`'s listing rate and the column names have already lost them, so every raw term
  // that resolved to a column travels alongside its name (a cheap value ANDed with an expensive one is expensive).
  if (perEntryPropertyAsk(query) !== null) return null;
  const join = propertyPartnerJoin(query);
  if (join === null) return null;
  const r = await runEs(["-get-result-count", ...termArgs(matchFlags, splitQueryTerms(join))],
    signal, WALK_PRICE_TIMEOUT_MS);
  if (r.spawnError || r.code !== 0) return null;
  const rows = parseCountAnswer(r.stdout.toString("utf-8").trim());
  if (rows === null) return null;
  const leaseRows = Math.floor((leaseMs * 1000) / usPerRow);
  if (rows <= leaseRows) return null;
  return { term: valueTerm, union: false, why: "propertyWalkWide", rows, leaseRows, leaseMs, usPerRow,
    columns: priced.length > 1 ? priced.map((p) => p.col).sort((a, b) => a.localeCompare(b)) : undefined };
}

/** The term in this query that can never be counted here at all, and why - or null when every term can be.
 *  ONE family lives here now: round 69's place-required values moved to `perEntryPropertyAsk`, because round 70
 *  measured that a NARROW ANDed partner rescues those (`latitude:47 ext:mp3` = 0 rows / 131 ms) while nothing
 *  tried rescues a date-accessed count. `kind` matters for this family alone: a date-accessed query can still
 *  produce a bounded LIST as long as NOTHING scopes it (5,251 ms raw and 4,851 ms through this tool at
 *  `limit:5`, and 5,097 ms to FETCH 2,001 rows at candidate size, 2026-11-07, `C:/tmp/esq197/out197.txt`). The
 *  bare ask is DENSITY-dependent too: that same shape on `da:2026-11-01` answered 5 rows in 5.1 s on 2026-11-05
 *  and nothing inside 35,016 ms on 2026-11-07, because accessed-date density decays as files are re-accessed.
 *  But a place-scoped one is the shape that hangs. Round 196 measured WHY, and it is not the
 *  folder - it is how DENSE the conjunction is. `da:2026-11-07 !attributes:d` filled 2,001 rows in 4.2 s and
 *  `da:today size:>10mb` in 10.2 s, while `da:today ext:exe`, `da:2026-11-01 ext:exe`, `da:2026-11-01
 *  size:>10mb`, `da:2026-11-01 attributes:d`, `da:yesterday ext:txt` and `da:today ancestor:"…\Documents"` each
 *  walked past 35 s (`C:/tmp/esq196/raw196.mjs`, `raw196c.mjs`); round 198 added `ext:ttf`, `size:>100mb` and
 *  `!path:node_modules`, all at `-n 5` and all past 35 s (`C:/tmp/esq198/out198.txt`). Density is not knowable
 *  from the query and the
 *  count that would reveal it is the very thing unaskable here, so the TRIGGER stays the measured place-scoped
 *  family, and a scarce partner that is not a place term stays an OPEN limitation the refusal body names.
 *  A QUOTED `"da:today"` is a name and does not match, because the head strip never removes a quote. */
export function unaskableTerm(
  terms: string[],
  kind: "count" | "list",
): { term: string; why: "neverCountable" } | null {
  const hasPlace = terms.some((t) => placeFunction(t));
  for (const t of terms) {
    const core = t.replace(/^[!<\s]+/, "").replace(/[)\s]+$/, "");
    const m = /^([A-Za-z][A-Za-z0-9_-]*):/i.exec(core);
    if (!m || !NEVER_COUNTABLE.test(core)) continue;
    if (kind === "count" || hasPlace)
      return { term: `${m[1].toLowerCase()}:`, why: "neverCountable" };
  }
  return null;
}

/** Why a LIST was refused before it was asked (see unaskableTerm and perEntryPropertyAsk). Shares its
 *  measurements with metadataNotAskedBody so the count refusal and the list refusal cannot drift apart. */
/** The un-indexed families a scan-only account named: one name, or every family the query carries (round 204). */
function scanFamilies(term: string): string[] {
  return term.split(", ");
}

/** One family reads singular; `dc:, content:` - every un-indexed family a query carries - reads plural, and the
 *  count comes from the family list, not from whether the rendered name happens to hold a comma. */
function scanVerb(term: string): string {
  return scanFamilies(term).length > 1 ? "are" : "is";
}

/** The clause an un-partnered per-entry refusal pays when the query carries MORE THAN ONE un-indexed column: the
 *  body names one column, and a caller that drops it would be refused again by a column nobody mentioned (the same
 *  partial account `soleScanOnlyTerm` fixed for the scan-only families; round 204 F-204-08). `connector` is the
 *  joining text, because one body lands mid-sentence and the other lands after a full stop. */
function extraColumnsSentence(columns: string[] | undefined, connector: string): string {
  if (!columns || columns.length < 2) return "";
  return connector + "this query carries " + columns.length + " of them ("
    + columns.map((c) => "`" + c + "`").join(" + ")
    + "), so dropping the one named above leaves the other testing every entry";
}

function listNotAskedBody(
  v: { term: string; why?: ScanSkip["why"]; union?: boolean; rows?: number; leaseRows?: number; leaseMs?: number;
    usPerRow?: number; candidateFetch?: number; columns?: string[] },
): string {
  // Round 196 F-196-01: the arm the count guard always had and this one never did - at the ONE fetch size the
  // measurements say is expensive. A BOUNDED listing of a scan-only scope is cheap, because es.exe may stop once
  // it holds enough rows: `-n 5` over `attributes:h` answered in 6,299 ms, over `content:zip` in 4,243 ms and
  // over `<ancestor:"C:\tmp" | attributes:h>` in 61 ms (C:/tmp/esq196/out196.txt B1-B3; B20 is that same scope).
  // A candidate fetch asks for 2,001 rows and cannot stop early: those two scopes cost 30,057 ms ending in
  // es.exe's timeout and 23,971 ms ending in a candidate-cap refusal (B19/B20). So the FETCH SIZE decides, not
  // the family: `everything_search`'s list path fetches at most 2,000 rows and keeps its answers untouched; a
  // candidate fetch on a scope nothing indexed narrows is refused here, in milliseconds, naming the term it
  // would have walked.
  if (v.candidateFetch)
    return `${v.term} ${scanVerb(v.term)} not indexed on this box, and ${v.union
      ? "it stands on ONE SIDE of a union, where nothing ANDed onto it restricts the candidates"
      : "nothing indexed narrows the query"}, so this call asked neither -get-result-count nor `
      + "-get-total-size - this is not a timeout. And no candidate list is asked for either: this fetch is not a "
      + "bounded listing that can stop early - it asks " + `${v.candidateFetch.toLocaleString("en-US")} rows. Measured ` 
      + "2026-11-07 on the two shapes this refuses: `content:zip` spent the whole 30 s list leash and answered " 
      + "nothing, and `<ancestor:\"C:\\tmp\" | attributes:h>` spent 24.0 s to reach a candidate-cap refusal - " 
      + "while bounded `-n 5` listings of those SAME terms answered in 4.2 s and 6.3 s, and `everything_search` " 
      + "with a small `limit` still answers them. Put an indexed term beside the scope (`ext:`, an absolute " 
      + "`path:`, a `parent:` or `ancestor:` folder, or a `size:` bound that leaves only the big files) and both "
      + "the count and the candidate list become askable.";
  // Round 197 F-197-01: this arm used to close " - the one es.exe call it waited on." `fetchEsList` runs
  // `prepareEsQuery` BEFORE this guard, and its spaced-value check can spawn the `-argv` `-version` probe when
  // the process has no memo, so the claim was refutable: the same refusal (`latitude:47 ancestor:"C:\Program
  // Files"`) cost 136 ms cold and 85 ms warm on 2026-11-07 (C:/tmp/esq197/out197.txt). The gate's own comment
  // states the invariant (round 192 F-192-02): a refusal must not be refutable by the probe. The tail is gone
  // rather than qualified; the surviving clause names only the two query calls this answer started or skipped.
  if (v.why === "propertyWalkWide")
    return `${v.term} is a value Everything has no index for, so listing it tests the entries the rest of this `
      + "query leaves it, and this call counted those entries instead of walking them, "
      + propertyWalkWideSentence(v)
      + " No listing was spawned for this query, and the count above is the only query call this answer "
      + "started.";
  return v.why === "perEntryProperty"
    ? `${v.term} is a value Everything has no index for, so it tests every entry, and nothing in this query `
      + "narrows it, so this listing is refused with the count: unscoped, none of the "
      + `${PER_ENTRY_PROPERTY_SPELLINGS} function spellings this set admits answered a count inside 18-30 s, `
      + "and the shapes that were also silent as bounded `-n 5` listings are `latitude:47`, `width:>100`, "
      + "`artist:`, `comment:`, `page-count:>10`, `date-taken:today` and `channels:>1` - re-measured 2026-11-05, "
      + "where `dimensions:>0`, `width:>100` and `channels:>1` answered nothing unscoped in 25 s, count or "
      + "listing. A shape over this set CAN answer at once when NOTHING carries the value (`orientation:>0` "
      + "returned no rows in under 0.4 s), but an empty answer is not the listing the caller wanted and no count "
      + "exists to tell the two apart in advance, so the set stays refused unscoped"
      + (v.union
        ? ", and on ONE SIDE of a union nothing ANDed elsewhere restricts the candidates (`latitude:47 | *.bin` "
          + "never answered in 20 s)"
        : "")
      + extraColumnsSentence(v.columns, "; ")
      + ". Put a place term beside it (`ancestor:`, `parent:`, an absolute `path:`) or a term that matches few "
      + "files - `latitude:47 ext:mp3` counted 0 in 61 ms because `ext:mp3` is 167 rows, while `ext:png` "
      + "(68,637 rows, round 70's run 2026-11-05) did not rescue it. No search of this query was started and "
      + "nothing was waited on for one."
    : `${v.term} with a place term ANDed onto it never answered here inside 30 s, in every one of the 15 `
      + "shapes measured, while the SAME function with no scope at all filled a bounded listing fast: `da:today` "
      + "answered 5 rows at `limit:5` in 4.9 s, and 2,001 rows at a 2,001-row fetch in 5.1 s. That bare-ask speed "
      + "is density too - the bare ask `da:2026-11-01`, which answered 5 rows in 5.1 s on 2026-11-05, answered "
      + "nothing inside 35 s on 2026-11-07 - so what decides is "
      + "how DENSE the conjunction is, not what kind of term was ANDed on: `da:2026-11-07 !attributes:d` filled "
      + "2,001 rows in 4.2 s and `da:today size:>10mb` in 10.2 s, while `da:today ext:exe`, `da:2026-11-01 "
      + "ext:exe`, `da:2026-11-01 size:>10mb`, `da:2026-11-01 attributes:d` and `da:yesterday ext:txt` each "
      + "walked past 35 s. Density cannot be read off a query and the count that would reveal it is the one this "
      + "call cannot ask, so this refusal fires on the measured place-scoped family and a SCARCE partner that is "
      + "not a place term is a known open gap this body states rather than hides. The listing was skipped "
      + "instead of waiting out the leash: drop the folder term, or ask the same question with `dm:` (indexed: "
      + "`dm:today` counted 19,909 in 411 ms on 2026-11-07). `dc:` is NOT the drop-in this body used to offer beside it: unscoped it "
      + "costs a 30 s list here and a count that answered only at 61.7 s (both 2026-11-07), and it rescues "
      + "nothing until a NARROW indexed term sits beside it (`dc:2026-11-01 ext:exe` counted 97 in 116 ms).";
}

/** The on-demand terms THIS query actually carries, for the timeout steer (round 196 F-196-09). The text this
 *  replaces named `content:, attributes:/attrib:, latitude:` whatever the caller had sent, so the timeout of a
 *  `da:2026-11-01 ext:exe` call told its caller to drop three terms that were not in the query and named none of
 *  the terms that were (C:/tmp/esq196/out196.txt B4). A value this index has no entry for is what the call was
 *  waiting on, and only the caller can drop it. An indexed value like `attributes:d` is never named, because
 *  `scanTermOf` does not treat it as on-demand. */
function onDemandSentence(query: string): string {
  const named = [...new Set(splitQueryTerms(query)
    .map((t) => scanTermOf(t) ?? perEntryTermOf(t))
    .filter((t): t is string => t !== null))];
  // Round 198 F-198-04: "pair it with a term that matches few files" is round 70's finding about PLACE-REQUIRED
  // values (`latitude:47 ext:mp3` = 0 rows / 131 ms). For the date-accessed family it is FALSE - a SCARCE partner
  // is exactly what walked past 35 s here (`ext:ttf`, `size:>100mb`), so the tail goes by family.
  const daTail = unaskableTerm(splitQueryTerms(query), "count")
    ? "drop it, or ask the same question with `dm:`: no ANDed partner measured here rescues this family. "
    : "drop it, or pair it with a term that matches few files. ";
  // Round 204 F-204-09: `named` is the deduped family list, so a query carrying two of them reads plural here too -
  // the scan-only refusal beside it already did, and one plural tail beside one singular tail is the drift.
  const oneFamily = named.length === 1;
  return named.length === 0
    ? "This query carries no on-demand term this tool can name, so the narrowing above is the only lever. "
    : `This query carries ${named.join(", ")}, ${oneFamily
      ? "a value this index has no entry for: that term, not the narrowing above, is what this call was "
      : "values this index has no entry for: those terms, not the narrowing above, are what this call was "}`
      + "waiting on - " + daTail;
}

export function uncountableScanTerm(
  query: string,
  terms: string[],
  patternIndex = -1,
): ScanSkip | null {
  const unaskable = unaskableTerm(terms, "count");
  if (unaskable) return { term: unaskable.term, union: false, why: unaskable.why };
  const prop = perEntryPropertyAsk(query);
  // `columns` travels: the count body is the half that tells the caller to drop the named term, and the tail naming
  // the unnamed columns can only print if this rebuild keeps the list (round 204 F-204-08).
  if (prop) return { term: prop.term, union: prop.union, why: prop.why, columns: prop.columns };
  const sole = soleScanOnlyTerm(terms);
  if (sole) return { term: sole, union: false };
  const u = unionScanOnlyTerm(query, patternIndex);
  return u ? { term: u, union: true } : null;
}

/**
 * Which question was not asked, and why - one body of text shared by the list header's parenthetical
 * and the count_only answer, so the two shapes cannot drift apart.
 */
/** The priced-walk measurement, shared by the count refusal and the list refusal so the two cannot drift. */
function propertyWalkWideSentence(
  s: { rows?: number; leaseRows?: number; leaseMs?: number; usPerRow?: number; term?: string;
       columns?: string[] },
): string {
  const rows = (s.rows ?? 0).toLocaleString("en-US");
  const lease = (s.leaseRows ?? 0).toLocaleString("en-US");
  // The priced set. One column prices at its own rate, so the one-column sentence can call that number THAT
  // column's worst rate; a price built from SEVERAL columns is their SUM, and attributing that figure to the
  // dominant column alone prints a false rate (`orientation:`'s own count rate is 600 us, not the 770 the pair
  // pays) beside the true list two sentences later, so the multi-column branch attributes the figure to the set it
  // priced (round 204 F-204-05). The column list is the guard's `columns`, already ordered by rate then name.
  const cols = s.columns ?? [];
  const namedCols = cols.map((c) => "`" + c + "`").join(" + ");
  return `that is ${rows} entries, and \`${s.term ?? "that column"}\` is priced at about `
    + `${(s.usPerRow ?? PROPERTY_WALK_US_PER_ROW_COUNT).toLocaleString("en-US")} microseconds an entry on this `
    + "path - "
    + (cols.length > 1
      ? "the SUM of the " + cols.length + " per-entry columns this query carries (" + namedCols + "), each of "
        + "them priced at the worst rate measured for THAT column, rounded up, because an AND of them can read "
        + "every candidate entry against each. "
      : "the slowest count-path rate measured for ANY term of this family (for a column that has a row of its "
        + "own in the table, the worst rate measured for THAT column, rounded up), not this term's own "
        + "measurement (a term with its own pair of numbers walks faster, and pricing every term at the worst "
        + "rate is what keeps this call from starting a walk that cannot fit). ")
    + "So the number is a conservative bound, not a forecast of this walk. "
    + (cols.length > 1
      ? "The columns named above are what that summed rate prices. "
        + "Everything evaluates the clauses in the order typed and stops at the "
        + "first that fails, so a query whose FIRST clause filters the corpus really does cost less than this sum "
        + "(measured 2026-11-07 over 9,657 `ext:xml`: `width:>100` 1,254 ms, `orientation:landscape` 2,329 ms, "
        + "both together 1,207 ms, because no XML passes `width:` and `orientation:` is never read there) - but "
        + "how many entries survive is not readable without paying another walk, so the bound is the sum. "
      : "")
    + "At that rate "
    + `${lease} entries is more than ${(s.leaseMs ?? 0).toLocaleString("en-US")} ms pays for. `
    + "Measured warm against ONE 9,669-entry "
    + "partner (`ext:xml`, `C:/tmp/esq75/p1.mjs`): on the COUNT path 656-708 ms (68-73 us an entry) for "
    + "`page-count:`, `channels:`, `samplerate:`, `bitdepth:`, `framerate:`, `date-taken:`, `dateprinted:`, "
    + "`title:`, `album:`, `comment:` and `company:`, against 2,242 ms (232 us) for `dimensions:`; on a LISTING, "
    + "4,877-5,256 ms (505-544 us) for those same columns, 8,996-9,007 ms (931 us) for `height:` and 16,863 ms "
    + "(1,744 us) for `dimensions:` - except `orientation:` beside a `>` comparison, which LISTED three corpora - "
    + "9,669 (`ext:xml`), 68,389 (`ext:png`) and 113,674 (`*.dll`) - in 37-50 ms, every one of them answering "
    + "0 rows, while counting them took "
    + "661-58,220 ms. That free listing is the value's doing, not the column's: the SAME `-n 3` listing of "
    + "`orientation:x` over `ext:xml` took 15,504 ms (1,605 us) on 2026-11-07, so only `orientation:` terms whose "
    + "value is a `>` comparison price at 50 us, and every other value of this column prices at 5,000 us - a "
    + "6,000-entry lease. And no `>` comparison has answered a ROW at any size measured here, the largest being "
    + "58,928 `ext:jpg` (where `orientation:1` finds 2 files, both also `landscape`, yet `>0` ANDed with "
    + "`orientation:1` is 0), while `orientation:<1000000` walked past a 55 s cap - so the 50 us price buys a ~50 ms "
    + "zero-row answer on this index, a spelling-specific behaviour whose mechanism is not measured, not a fast "
    + "orientation listing. Its COUNT path does not share that behaviour: 12.3 s for those same 0 rows, which is why "
    + "this column's counts price at 600 us (a 25,000-entry lease) against a worst measured 512 us. At the "
    + "74,767-entry scale the COUNT path took "
    + "6,030-11,556 ms across seven "
    + "columns and a LISTING never answered inside 40 s either time. One column's own rate has moved under the "
    + "guard since that table was written: on 2026-11-07 the same 0-match `ext:css` listing of `dimensions:` cost "
    + "14,470 ms at 08:00 and 30,349 ms at 08:10, so where this column is priced above, the price is the WORST its "
    + "drives produced and not the pleasant one. A FIRST (uncached) walk of a query is "
    + "slower than any of those numbers. Narrow the ANDed terms (a place term bounds the walk to one folder) or "
    + "ask a smaller slice.";
}

function metadataNotAskedBody(skip: ScanSkip): string {
  const { term, union } = skip;
  // `why` decides FIRST: a per-entry value function standing on a union side has its own body below, which
  // names the family and what rescues it. Letting the scan-union wording win instead tells a `latitude:47 | *.bin`
  // caller to "move the date/attribute/content term", which is not what its refusal measured.
  if (union && !skip.why) {
    return `${term} is not indexed on this box, and here it stands on ONE SIDE of a union, where nothing `
      + "ANDed onto it restricts the candidates: a term supplied by a single alternative is evaluated across "
      + "the WHOLE INDEX whatever the rest of the query names, so this call asked neither -get-result-count "
      + "nor -get-total-size - this is not a timeout. Measured here on a 20 s leash (AQ is an `ancestor:` folder "
      + "term, and the date below is FIXED so the row does not move with the calendar): `<AQ | dc:2026-11-04>` "
      + "never answered in 22 s, while `dc:2026-11-04 AQ` counted 405 in 65 ms. Move the "
      + "date/attribute/content term out of the alternative, or drop that alternative, to make it countable.";
  }
  if (skip.why === "neverCountable") {
    return `${term} cannot be counted on this box at all, and nothing in this query could make it countable: 15 `
      + "shapes of it were silent on a 30 s leash here - alone, with a 405-entry and a 2,045-entry folder ANDed, "
      + "with `ext:mjs`, with `ext:exe` (the narrowing that rescues `dc:`), with `size:>1kb`, with `dm:>monday`, "
      + "as `!da:today`, inside `<AQ | …>`, as a `|` side, under `sort:name`, as `da:>2026-01-01`, as `da:h`, as "
      + "empty `da:`, and as a folder-scoped listing. What ANSWERED was a fetch that could stop early or a DENSE "
      + "partner: `-n 5 da:today` filled 5 rows in 5,251 ms raw and 4,851 ms through this tool on 2026-11-07, and "
      + "`da:2026-11-07 !attributes:d` filled 2,001 rows in 4.2 s at candidate size. What decides is how DENSE the "
      + "conjunction is, not whether a folder is named - round 196 measured that reversal, and this body used to "
      + "blame the folder. A plain `da:` search still returns rows; this call asked neither "
      + "-get-result-count nor -get-total-size, and that is not a timeout.";
  }
  if (skip.why === "perEntryProperty") {
    return `${term} is a value Everything has no index for, so it has to test every entry to answer for it. `
      + "Measured here on 15-30 s leashes: unscoped, none of these answered `-get-result-count`, and the same "
      + "shapes were silent as bounded `-n 5` listings: `latitude:47`, `longitude:12`, `dateacquired:today`, `width:>100`, `height:>100`, "
      + "`page-count:>10`, `pagecount:>10`, `author:nobody`, `bitrate:>100`, `duration:>10`, `channels:>1`, "
      + "`sample-rate:>10`, `dimensions:>0`, `date-taken:today`, `datetaken:today`, `artist:x`, `title:x`, "
      + "`album:x`, `genre:x`, `comment:x`, `description:x`, `copyright:x`, `company:x`, `dateprinted:today` "
      + "and `hard-link-count:>1` (its own numbers: count silent at 15 s, `-n 5` silent at 25 s, and 83 ms once "
      + "`ancestor:` named the one folder holding a hard-linked pair). Re-measured 2026-11-05 the same way: "
      + "`dimensions:>0`, `width:>100` and `channels:>1` answered neither a count nor a `-n 5` listing in 25 s. "
      + "The one fast case over this set is a shape whose value NO row carries - `orientation:>0` returned zero "
      + "rows in under 0.4 s - and an empty answer is not worth waiting for."
      + (union
        ? " And here it stands on ONE SIDE of a union, where nothing ANDed onto it restricts the candidates: a "
          + "term one alternative supplies is evaluated across the WHOLE INDEX whatever the rest of the query "
          + "names (measured: `latitude:47 | *.bin` never answered in 20 s)."
        : " Nothing else in this query narrows it, so Everything would walk every entry to build this count.")
      + extraColumnsSentence(skip.columns, " And ")
      + " What DOES answer: a place term beside it - `ancestor:`, `parent:`, or an absolute `path:` (0 rows in "
      + "105-616 ms) - or a term that matches FEW files: `latitude:47 ext:mp3` counted 0 in 61 ms because "
      + "`ext:mp3` is only 167 rows, while a broad partner does not rescue it (`ext:png` 68,637, `ext:mjs` "
      + "116,240, `*.dll` 113,781 and `size:>1kb` 2,274,644 - all four round 70's run, 2026-11-05 - were every "
      + "one silent beside these functions; how "
      + "small is small enough is not measured, so a query that DOES name a partner stays on the normal leash). "
      + "This call asked neither -get-result-count nor -get-total-size - this is not a timeout.";
  }
  if (skip.why === "propertyWalkWide") {
    return `${term} is a value Everything has no index for, so it tests the entries the rest of this query leaves `
      + "it, and this call counted those entries rather than walking them, "
      + propertyWalkWideSentence(skip)
      + " This call asked no count of the query itself and no -get-total-size - this is not a timeout.";
  }
  return `${term} ${scanVerb(term)} not indexed on this box and nothing indexed narrows the query, so this call asked `
    + "neither -get-result-count nor -get-total-size - this is not a timeout. Measured here on a 75 s "
    + "leash, and again on a 25 s one on 2026-11-05: `dc:today` and `content:zip` never answered a count at all, "
    + "while `dc:2026-11-01 ext:exe` - a FIXED date beside an indexed extension, so the row does not move with the "
    // The four narrowers are written BARE here (no backticks), unlike the per-entry bodies, so a check that
    // reads this body for quoted function names sees only the measured shapes - case 156 pins that split.
    + "calendar - counted 97 in 116 ms. Put a NARROW indexed term beside the date/attribute/content "
    + "term (ext: on few files, an absolute path:, a parent: or ancestor: folder, or a size: bound "
    + "that leaves only the big files) and the count answers; a partner that still names millions of "
    + "rows does not - size:>1kb covers most of this index and spent the whole 15 s leash beside "
    + "dc:2026-11-01 (driven 2026-11-06).";
}
// One note, shared by everything_search's zero and everything_grep's zero so the two tools cannot
// drift apart. Measured here: 0 of 3,772,610 indexed paths start with a backslash - the index is the
// USN index of local volumes - so a UNC or \\?\ root can never match, and sending the reader to
// everything_status (which reports healthy) for that shape is a dead end. Round 16 F-16-1.
// The double backslash may also sit right after an opening QUOTE, which is how a scope VALUE is
// spelled - ancestor:"\\server\share" - so the class carries " too (F-122-2, round 122: without it
// the quoted form kept the bare "run everything_status" dead end this note exists to retract).
function backslashRootNote(query: string): string {
  if (!/(^|[ ("|:])\\\\/.test(query)) return "";
  return (
    "\n\nNote: no path in this index starts with a backslash (measured 0 of every entry), so a UNC " +
    "share (\\\\server\\share) or a \\?\\ device path can never match, whatever the index holds - " +
    "this is not index decay and everything_status will not explain it. Query the volume path " +
    "instead: E:\\docker, C:\\Users."
  );
}

// Exported so the suite can pin the budget-quoting rule (round 18 F-18-1) through this pure builder
// instead of waiting out a real 15 s count timeout on a load-sensitive term.
/**
 * A timeout on a query that holds a UNION needs its own sentence: a term that only one side of the union
 * supplies is still evaluated across the whole index, so the scopes sitting elsewhere in the query cannot
 * rescue it. Measured again 2026-11-05 on a healthy index: `dc:2026-11-04 ancestor:"…answertrim"` answered 405
 * in 65 ms, while `<ancestor:"…answertrim" | dc:2026-11-04>` and `dc:2026-11-04` alone never answered in 22 s.
 * Round 80 moved this example off `dc:today` on purpose: that population is the calendar's (it read 405 on
 * 2026-11-04, when the fixtures were new, and 0 on 2026-11-05), while a FIXED date beside the same folder keeps
 * answering 405. Telling such a
 * caller to "add ancestor:" is advice the query already satisfies.
 */
/** The regex clause: inside a PATTERN term the grouping characters are pattern grammar, but a `word:` prefix
 *  is still a function, so the count still scans. Empty unless the pattern actually holds a scan-only one. */
function patternScanClause(query: string, patternIndex: number): string {
  if (patternIndex !== 0) return "";
  const pat = splitQueryTerms(query)[0] ?? "";
  if (!/(?:^|[^A-Za-z0-9_-])(?:dc|da|attrib|attributes|attribute|content):/i.test(pat)) return "";
  return (
    "This query is a regex query, so this message does not blame a union: the pattern's own \"<\", \">\" and " +
    "\"|\" are PATTERN characters, not Everything's grouping or union. A `word:` prefix inside the pattern is " +
    "still a FUNCTION, though - measured again 2026-11-05: `-regex ext:bin` counted 3,541, exactly the plain " +
    "`ext:bin`, and `-regex dc:2026-11-04` never answered inside 22 s - so a date/attribute/content term written " +
    "inside the pattern makes the count scan the whole index. Put an indexed term AFTER the pattern (es.exe " +
    "gets it behind `--`), which does restrict it: `-regex dc:2026-11-04` with `ext:bin` behind it counted 57 " +
    "in 317 ms."
  );
}

function unionTimeoutHint(query: string, patternIndex = -1): string {
  // A regex query hands its FIRST WHITESPACE TERM to es.exe as the pattern, and inside it `|` is regex
  // alternation rather than Everything's union (round 52: `-regex "<ancestor:"…answertrim" |>"` answered
  // 3,777,998 through regex alternation, not group grammar). Taking that pipe for a union told a regex query
  // to "narrow or delete that alternative" - advice about a union the query does not contain.
  let text = query;
  if (patternIndex === 0) {
    const pat = splitQueryTerms(query)[0] ?? "";
    const at = pat === "" ? -1 : query.indexOf(pat);
    text = at < 0 ? "" : `${query.slice(0, at)} ${query.slice(at + pat.length)}`;
  }
  const union = (() => {
    const grouped = /<[^\s][^>]*\|/.test(text);
    if (!grouped && queryAtoms(text).pipes.length === 0) return "";
    return (
      'This query also holds a union: a term that only ONE side of a "|" or of a "<...>" alternative ' +
      "supplies is evaluated across the WHOLE INDEX even when another term names a folder, so adding a scope " +
      "somewhere else cannot rescue it - narrow or delete that alternative (measured 2026-11-05: " +
      'dc:2026-11-04 ancestor:"…answertrim" answered 405 in 65 ms, while ' +
      '<ancestor:"…answertrim" | dc:2026-11-04> never answered in 22 s). '
    );
  })();
  const clause = patternScanClause(query, patternIndex);
  return union || clause ? `${union}${clause} ` : "";
}

/** The failure text for a call that could not be answered. `callShape` names what `query` CARRIES: a
 *  search query (the default - the timeout arm then names the narrowing functions that would make the
 *  query cheap) or ONE ABSOLUTE PATH (`everything_folder_size`, whose only parameter is a path and which
 *  therefore has no narrowing to name at all, round 174 F-3). */
export function esFailureMessage(
  o: EsOutcome, query: string, patternIndex = -1, callShape: "query" | "path" = "query",
): string {
  if (o.spawnError) {
    const code = (o.spawnError as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return (
        "es.exe not found in PATH. Install the Everything CLI from " +
        "https://www.voidtools.com/downloads/#cli and add its folder to PATH, " +
        "then retry. (Fallback until then: use find/grep.)"
      );
    }
    if (o.argvTooLong) {
      return (
        `This call was never started: its arguments would build a command line of about ` +
        `${o.argvTooLong.bytes.toLocaleString("en-US")} bytes, over the ` +
        `${o.argvTooLong.limit.toLocaleString("en-US")}-byte ceiling this tool enforces. Windows refuses a command ` +
        `line of ${WIN_CMD_LIMIT_BYTES.toLocaleString("en-US")} characters, and quoting plus backslash escaping make a query ` +
        `longer than it looks, so a shorter one may still be refused by the parameter check. Nothing about the ` +
        `index can cause this, so everything_status cannot help: split the search into several narrower calls.`
      );
    }
    if (o.controlSwitches) {
      const one = o.controlSwitches.length === 1;
      return (
        `This call was never started: ${o.controlSwitches.join(", ")} ${one ? "is a" : "are"} control ` +
        `switch${one ? "" : "es"} this tool refuses by name. \`es -exit\` stops the Everything app itself, and ` +
        `nothing else serves the index, so every later call answers es.exe's own \`Error 8: Everything IPC ` +
        `not found\` until a person starts the app again. Nothing about the index or the executable caused ` +
        `this, so everything_status cannot help, and no retry helps while the switch stays in the arguments. ` +
        `A search for a file actually NAMED that is never refused: only the arguments before the ` +
        `\`--\` terminator are checked.`
      );
    }
    if (o.aborted) {
      // Not an installation fault: the CALLER cancelled this call. Both abort shapes used to read
      // "Could not start es.exe: aborted. Run everything_status to diagnose." (measured 2026-11-05
      // through execute(): a signal aborted before the spawn, and one aborted 300 ms into a 4.4 s list
      // fetch), which sent a caller who had just interrupted a search to a health tool whose only answer
      // was that the index is fine.
      return o.aborted === "beforeStart"
        ? "Cancelled by the caller: this call was aborted before es.exe was started, so nothing was searched."
        : "Cancelled by the caller: this call was aborted while es.exe was running, so its child was stopped and no answer was read.";
    }
    // A call that never spawned is not an index question either: no es.exe process ever ran, so
    // nothing the index holds can have caused it. Measured 2026-11-06 with an es.exe copy whose ACL
    // denies read and execute placed first on PATH (the tool spawns bare "es.exe"), driven through
    // execute() on all four es.exe tools: each threw "Could not start es.exe: spawn EPERM. Run
    // everything_status to diagnose.", while the healthy control answered normally. The advice was
    // inverted - everything_status reports the INDEX, which was fine, and says nothing about the one
    // fact that mattered (the file would not start); the report's own third line is what carries a
    // start failure and it was already correct: "es.exe not found in PATH (or not startable)". The
    // argvTooLong arm above and the argument-rejection arm below both already state this rule; this
    // is round 124's F-124-1 correction applied to the one arm that kept the pointer.
    return (
      `Could not start es.exe: ${code ?? o.spawnError.message}. ` +
      "Nothing about the index can stop es.exe from starting, so everything_status cannot help here: " +
      "the executable itself is the problem - it was found on PATH but would not start. Check its " +
      "file and folder permissions, and any security software that could be blocking it."
    );
  }
  if (o.timedOut) {
    // Report the budget THIS call was given, not the constant: the count calls run on
    // 15 s while a list fetch gets 30 s, and quoting ES_TIMEOUT_MS told the agent it had
    // waited twice as long as it actually did (measured 2026-11-04: count_only on
    // `dc:today` returned at 15.1 s with a message that said "timed out after 30s").
    //
    // Round 124 F-124-1: the budget is a measurement, the CAUSE was an inference. Round 64 drafted a
    // fix for this arm and rejected it for lack of evidence; round 65 supplied evidence for the UNION
    // case only (`unionTimeoutHint`) and left the generic sentence, which told a caller to add
    // `ancestor:`/`ext:` to a query already carrying both. Measured 2026-11-05 with a compiled stub
    // es.exe that hangs on every non-`-version` call (C:/tmp/esq124/p4.mjs, real index healthy and
    // answering 324,994 rows after cleanup): `ancestor:"C:\tmp\esq124stub" ext:cs`, which names none of
    // the slow-term families, still read "add parent:, ancestor:, ext:, or size: constraints". The
    // advice is now derived from `CAP_NARROWING` by the same rule round 106 built for the candidate-cap
    // refusal, and the two remaining causes are both named, because a timeout cannot tell them apart.
    if (callShape === "path") {
      // A folder path is not a query: driven live, the query arm below told a caller whose folder-size call
      // timed out to "Narrow it: none of ext:, ancestor:, size:, or !path: is in the query yet", to drop
      // an on-demand term it does not have, and closed "Query was: C:\some\folder" about a path. The only
      // actionable facts are the budget that fired and who answers es.exe.
      return (
        `es.exe did not answer within the ${Math.round((o.timeoutMs ?? ES_TIMEOUT_MS) / 1000)}s this call ` +
        "allows. It asked for ONE folder's total, so there is no query to narrow and no slow term to drop: " +
        "the Everything app is what answers es.exe, so run everything_status, then retry the same path - " +
        `a busy or rebuilding index is the usual cause. Folder was: ${showParamValue(query)}`
      );
    }
    const missingN = missingNarrowingNames(query);
    // Round 179 F-179-07: both ALL-FOUR arms used to RE-TYPE the four names while their CONDITION already
    // read CAP_NARROWING, so editing the constant would leave these sentences advertising a set the refusals
    // no longer offer. Both enumerate the constant now; the rendered text is byte-for-byte what it was.
    const allN = capNarrowingNames();
    // Round 198 F-198-04: for THIS family the four narrowing functions are levers measured DEAD - `da:2026-11-01`
    // beside `ext:ttf`, `ext:exe`, `size:>100mb`, `size:>10mb`, `attributes:d` or `!path:node_modules` each walked
    // past 35 s at `-n 5` (C:/tmp/esq198/out198.txt, C:/tmp/esq196/out196.txt). Round 199 F-199-09 closed the last
    // allowed class the sentence had not named: a NON-path `path:` value is not a place term (so `unaskableTerm`
    // lets it through) and it walked too - `da:2026-11-01 path:edg` 35,019 ms and
    // `da:2026-11-01 path:program files` 35,015 ms against `path:edg` alone in 330 ms
    // (C:/tmp/esq199/out199b.txt) - so the sentence now names every class the tool offers, and a place term is this call's
    // OWN list refusal (`unaskableTerm` returns for kind "list" exactly when one is present). Recommending them
    // anyway buys the caller another 30 s or a millisecond refusal, and this arm's closing sentence used to call
    // that same set "the only lever this call has" in one breath with offering `dm:`. daAsk is the GUARD's own
    // classifier, so the refusal and the advice cannot disagree about which queries are in this family.
    const daAsk = unaskableTerm(splitQueryTerms(query), "count");
    const daNarrow = "No narrowing partner rescues this ask: beside a sparse date-accessed term, `ext:ttf`, "
      + "`ext:exe`, `size:>100mb`, `size:>10mb`, `attributes:d`, `!path:node_modules` and a NON-path `path:` value "
      + "(`path:edg`, `path:program files`) each walked past 35 s at `-n 5`, and a place term this call refuses "
      + "outright - the date-accessed term itself is what has to go, or the question has to be asked with `dm:`.";
    const narrow = daAsk !== null ? daNarrow :
      missingN.length === CAP_NARROWING.length
        ? `Narrow it: none of ${allN.slice(0, -1).join(", ")}, or ${allN[allN.length - 1]} is in the query `
          + "yet."
        : missingN.length > 0
          ? `Narrow it: ${missingN.join(" and ")} ${missingN.length === 1 ? "is" : "are"} the narrowing`
            + ` function${missingN.length === 1 ? "" : "s"} this query does not apply yet. `
            + "The ones it already carries cannot help again."
          : `The query already applies ${allN.slice(0, -1).join(", ")} and ${allN[allN.length - 1]}, so a `
            + "fifth function will not "
            + "save it - tighten a value it has: a deeper ancestor:, a narrower ext:, a larger size: bound.";
    return (
      `es.exe did not answer within the ${Math.round((o.timeoutMs ?? ES_TIMEOUT_MS) / 1000)}s this call allows. ` +
      `${narrow} ${onDemandSentence(query)}` +
      `${unionTimeoutHint(query, patternIndex)}` +
      "A timeout does not prove the query is at fault: if one this narrow also times out, run " +
      "everything_status, because the Everything app - not the index contents - is what answers es.exe. " +
      "On this box dc: (created) and da: (accessed) are not indexed either, so they scan every entry: unscoped " +
      "they answer only PAST every leash this box offers (`dc:2026-11-01` counted 5,424 in 61.7 s and " +
      "`da:2026-11-01` 43,574 in 63.8 s, both 2026-11-07), and it is the unscoped LISTING of them that times " +
      "out here; ask the same question with dm: (modified) if a " +
      "modified-date answer will do - re-spelling the un-indexed term cannot make it cheap" +
      (daAsk !== null
        ? "; for this family no narrowing partner measured here answers inside a leash, so `dm:` is the only "
          + "rewrite that answers fast (`dm:today` counted 19,909 in 411 ms and listed 5 rows in 44 ms, "
          + "2026-11-07). "
        : ", and the narrowing named above is the only lever this call has. ") +
      `Query was: ${query}`
    );
  }
  // es.exe's own messages already end in a period, so appending one printed "No results found.."
  const stderr = o.stderr.toString("utf-8").trim().replace(/\.$/, "");
  if (o.code !== 0) {
    // es.exe's ARGUMENT complaints used to wear the index pointer, which sent the caller to everything_status
    // for a problem only the caller's own arguments can have (measured 2026-11-04 through a direct execute()
    // call: sort "nonsense" answered "es.exe exited with code 4. stderr: Error 4: Unknown sort: nonsense" and
    // then told the caller to check the index state, while the index was fine and answering in 140 ms). pi does
    // NOT validate parameters at runtime - round 82 measured sort "run-count" and sort "bitrate" reaching es.exe
    // through execute() - so this path is reachable, which is why the message has to be true: an es.exe older
    // than the names in that enum reaches it too, and a wrong pointer costs the caller a detour.
    const badSort = /Unknown sort:\s*(\S+)/i.exec(stderr);
    if (/^(?:Error \d+: ?)?(?:Unknown|Invalid|Unrecognized|Unsupported)/i.test(stderr)) {
      return (
        `es.exe rejected an argument this call gave it` +
          (badSort
            ? `: it does not know the sort column "${badSort[1]}" - this build accepts ` +
              `${SORT_COLUMNS.join(", ")}`
            : "") +
        `. Nothing about the index can cause that, so everything_status cannot help: drop the parameter or ` +
        `use a supported name. es.exe said: ${stderr}.`
      );
    }
    return (
      `es.exe exited with code ${o.code}. ` +
      (stderr ? `stderr: ${stderr}. ` : "") +
      "Run everything_status to check the Everything index state."
    );
  }
  // Defensive default, and UNREACHABLE by predicate: every non-abort call site gates on
  // `spawnError || code !== 0` (fetchEsList, the count call, folder_size's runEs arm), and the
  // aborted-probe site cannot arrive here because a spawnError is tested first - so no live call can
  // hand this function a zero code with no error, no timeout and no abort. Live probe 2026-11-06
  // agrees: with es.exe made unstartable, all four es.exe tools threw an install/start answer and
  // nothing reached this sentence. It stays because a future call site could reach it, and a bare
  // throw with no text would be worse than one that names the query.
  return `es.exe failed unexpectedly for query: ${query}`;
}

/** The sort columns this tool forwards to es.exe's `-sort` (each suffixed `-ascending`/`-descending`). The
 *  schema enum and the argument-rejection message both read this list, so a message can never advertise a
 *  name the schema refuses or hide one it accepts. All nine were measured accepted by this box's es.exe
 *  (2026-11-04: 18/18 column+direction calls ok, 137-187 ms each on a 20-file scope). That scope held TWENTY
 *  files. Rounds 78 and 79 re-measured at scale; round 80 confirmed both WARM on 2026-11-05 (`es.exe -n 500`).
 *  SIX of the nine stay flat at every scale the `sort` schema names -
 *  35-49 ms as es.exe at every one of those scales - the `sort` schema carries that band and the 54-77 ms
 *  through-the-tool figure, so comments quote it rather than restate a measurement (the SIX are `name`, `path`,
 *  `size`, `extension`, `date-modified` and `date-recently-changed` - the same six both refusal bodies list) -
 *  and THREE track the match set at 12.5-25 us an entry at the rungs from 324,987 entries up (a per-query rate, not
 *  a per-entry constant - 9.1-17.9 us apparent below that): `attributes`
 *  (758-783 ms at 83,454; 4,264-4,339 ms at 324,987), `date-created` (174 ms at 9,669; 4,182-4,219 ms at
 *  324,987) and `date-accessed` (154 ms at 9,669; 4,129-4,184 ms at 324,987) - all three in either direction, and
 *  none of the three ever finishing in
 *  below; the other six Everything sorts from the index itself. */
const SORT_COLUMNS = ["name", "path", "size", "extension", "date-created", "date-modified",
  "date-accessed", "date-recently-changed", "attributes"] as const;

/** The three accepted sorts that order EVERY match before returning a page: each one materializes a per-entry
 *  property for every match to order on, so all three cost 12.5-25 us per entry of the MATCH SET at the rungs from
 *  324,987 entries up (the smaller rungs quoted below are fixed-cost-dominated) and `-n 500` buys nothing - one
 *  envelope for the three names, but NOT one number per row count: driven 2026-11-07 (`date-accessed` not
 *  re-driven) `attributes` ran at 12.5-12.8 us over 1,461,299 entries and 13.3-22.8 us over 1,059,906, and
 *  `date-created` reached 25.1 us over 1,816,088. Round 78 found
 *  `attributes`; round 79 found `date-created` and `date-accessed` (its p9.mjs: 174 / 4,260 / never-in-30 s and
 *  154 / 4,226 / never-in-30 s at 9,669 / 324,987 / 3,777,046 entries, index counts as of 2026-11-05). */
const PER_ENTRY_SORT_COLUMNS: readonly string[] = ["attributes", "date-created", "date-accessed"];

/** What each of the three cost at 324,987 entries, measured WARM on 2026-11-05 (`es.exe -n 500
 *  -sort X-ascending`, two runs each, `C:/tmp/esq80/p1.mjs`), so a refusal quotes its own name's numbers. */
const PER_ENTRY_SORT_MEASURED: Record<string, string> = {
  attributes: "4,264-4,339 ms",
  "date-created": "4,182-4,219 ms",
  "date-accessed": "4,129-4,184 ms",
};

/** The most matches one of the match-set sorts may be asked to order. The line is a MEASURED BRACKET plus a
 *  POLICY, not a capacity: under it the worst readings this box produced are 24,150 ms (attributes over 1,059,906)
 *  and 24,092 ms (date-created at the same scale), and attributes answered 1,461,299 in 18.3-18.7 s; over it,
 *  1,816,088 took 40.3-43.1 s (attributes) and 45.5 s (date-created), and the whole index never answered in 30 s -
 *  so the line sits between a shape measured to finish and a shape measured to overrun. It is NOT a capacity: no
 *  rate predicts one. The older derivation - divide the 30 s leash by one measured per-entry band, leave 33% for
 *  the fetch and a cold pass - is retired because that band is a spread over queries: the same sort ran at 12.5 us
 *  an entry over 1,461,299 and at 22.8 us over 1,059,906, and projecting the worst observed rate (25.1 us) onto
 *  1,500,000 puts it at 37.6 s, past the leash. The refusal therefore says "the most this tool will order". The
 *  shared list runner refuses the sort past this line instead of spending the leash to learn it from a timeout,
 *  and pays its count call first for those sorts only. */
const PER_ENTRY_SORT_MAX_ROWS = 1_500_000;

/** The renderer behind every MEASURED byte figure (`2.5 MB (2,590,171 bytes)`): the unit steps at 1024, a
 *  value of 100 or more prints as a whole number, anything smaller keeps one decimal, and plain bytes are
 *  never decimal. Exported ONLY so test/e2e-spaced-path.mjs can pin that rule as a table - every number it
 *  renders comes from a live index, so no single answer is stable enough to assert against. NOT
 *  interchangeable with pi's `formatSize` (imported above: no space before the unit), which this tool uses
 *  only to name its OWN budgets and caps, in grep's house style. */
export function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** es.exe answers a count with a bare integer; anything else means "I did not answer", which is not
 *  the same fact as zero. Round 21 measured the count_only path printing "0 file(s) match" when
 *  es.exe answered "n/a" (exit 0): `parseInt` → NaN → `|| 0`. The list path already reported null
 *  for that shape; both call this now. Exported so the suite can pin the accepted shape. */
export function parseCountAnswer(raw: string): number | null {
  const t = raw.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** The `-get-total-size` answer kept as (bytes, why-not) instead of bytes-or-null: a blank, an
 *  unparseable reply, a failed call and a timeout are four different facts, and a caller that only
 *  gets null cannot say which one it printed. Round 21 measured the count_only path printing no
 *  size line at all for every one of those shapes, and `Number("") === 0` turning a blank reply
 *  into a confident "0 B (0 bytes)".
 *  `matchCount` decides what the 2^64-1 sentinel means: es.exe answers it for zero-result queries,
 *  so it is 0 bytes only when the count is 0 or unknown. Over a non-zero count the two answers
 *  disagree and no size is printed — a genuine 0-byte total arrives as "0", never as the sentinel
 *  (verified: a folder of three 0-byte files answers "0"). */
export function sizeAnswerOf(
  res: EsOutcome | null,
  matchCount: number | null = null,
): { bytes: number | null; note: string | null } {
  if (!res) return { bytes: null, note: "no -get-total-size call was made" };
  if (res.aborted)
    return { bytes: null, note: "cancelled by the caller before -get-total-size answered" };
  if (res.spawnError)
    return { bytes: null, note: `es.exe could not run: ${res.spawnError.message}` };
  if (res.timedOut)
    return {
      bytes: null,
      note: `es.exe did not answer -get-total-size within ${
        (res.timeoutMs ?? COUNT_TIMEOUT_MS) / 1000
      }s`,
    };
  if (res.code !== 0)
    return {
      bytes: null,
      note: `es.exe failed the size call (${res.stderr.toString("utf-8").trim() || `exit code ${res.code}`})`,
    };
  const raw = res.stdout.toString("utf-8").trim();
  if (raw === UINT64_MAX_STR) {
    if (matchCount === null || matchCount === 0) return { bytes: 0, note: null };
    return {
      bytes: null,
      note: `es.exe answered the zero-result sentinel ${UINT64_MAX_STR} while the count said ${matchCount.toLocaleString("en-US")} row(s) - the two answers disagree, so no size is claimed`,
    };
  }
  if (!/^\d+$/.test(raw))
    return {
      bytes: null,
      note: `es.exe answered ${raw ? `"${raw.slice(0, 40)}"` : "nothing"} to -get-total-size`,
    };
  return { bytes: Number(raw), note: null };
}

/** One size sentence for BOTH everything_search paths. Round 19 fixed the list path's silence and
 *  the count_only path stayed silent; sharing the sentence is what keeps them from drifting again.
 *  Round 54 F-54-6: the sentence names WHICH rows the bytes cover, because the header above it can read
 *  "showing 3" - measured 2026-11-04, a 405-match query with limit 3 answered "total size: 10.7 MB
 *  (11,215,296 bytes)", which is the size of all 405 files, not of the 3 rows on screen. `count` is the
 *  match total when the answer knows it.
 *  Round 187 F-1: that match total counts ROWS, while -get-total-size sums FILE rows only, so the sentence
 *  says "the FILE rows among all N matching rows" - a folder is a row and puts no bytes in the figure. A
 *  folders-only query is the proof: the count answers 633 rows while the byte call returns the zero-result
 *  sentinel (which is the disagreement the unknown-branch sentence reports). */
export function sizeSentence(a: {
  bytes: number | null;
  note: string | null;
  count?: number | null;
  /** The caller's query. With it the sentence can say whether THIS query holds a term that hides a byte
   *  total; without it the sentence only names the terms that would. Round 160 F-160-9. */
  query?: string;
}): string {
  if (a.bytes != null) {
    const over =
      a.count != null
        ? ` of the FILE rows among all ${a.count.toLocaleString("en-US")} matching rows`
        : " of the matching FILE rows";
    return `\ntotal size${over}: ${fmtBytes(a.bytes)} (${a.bytes.toLocaleString("en-US")} bytes)`;
  }
  const scanHere = a.query === undefined
    ? null
    : splitQueryTerms(a.query).find((t) => /(?:^|[^A-Za-z0-9_-])(?:dc|da|attrib|attributes|attribute|content):/i
      .test(t)) ?? null;
  const scanName = scanHere === null ? null : scanHere.slice(0, scanHere.indexOf(":")).toLowerCase();
  // Round 193 F-193-01: the sentinel-disagreement note names its OWN cause, and the query-shaped advice printed
  // beside it contradicted the answer carrying it - the count HAD answered (that IS the disagreement), the
  // "put an indexed term beside it (…, parent:, …)" remedy named a term the query already begins with (driven:
  // `parent:"<dir>" attributes:d` blamed `attributes:` while `parent:` is its first term), and the no-scan arm
  // told the caller to RETRY a call whose answer is the row population, not a transient. Measured on this box:
  // a scanning term does not hide a byte total that exists (`dc:2026-11-01 ext:exe` answered 1.2 GB) and a
  // folders-only match set answers the sentinel every time. So when the note IS the sentinel, say what the
  // sentinel means, and name the scanning term only as the other candidate cause.
  const sentinel = a.note !== null && a.note.includes(UINT64_MAX_STR);
  const why = sentinel
    ? scanName === null
      ? "The byte total is summed over FILE rows only, and nothing among the matched rows is a FILE row, so no "
        + "byte figure exists here: select the files themselves, or drop total_size."
      : "The byte total is summed over FILE rows only: either nothing among the matched rows is a FILE row, or "
        + `the scanning term \`${scanName}:\` defeated the sum the way it can defeat a count. Either way the `
        + "thing to change is the query - select the files themselves, or drop total_size."
    : a.query === undefined
      ? "The scanning terms that hide a count (dc:, da:, attrib:/attributes:, content:, and a per-entry "
        + "property like width: or latitude:) hide the byte total too if the query holds one; narrow the "
        + "query or drop total_size."
      : scanHere !== null
        ? `${scanName}: is a scanning term in this query, and a scanning term hides the byte total the way it `
          + "hides the count; put an indexed term beside it (ext:, path:, parent:, ancestor:) or drop "
          + "total_size."
        : "Nothing in this query holds a term that hides a count, and the byte total is summed from the "
          + "index, so retry the call, or drop total_size.";
  return `\ntotal size: unknown - ${a.note ?? "there is no size answer"} for this query. ${why}`;
}

// Minimal CSV line parser for the es.exe -export-csv fallback (paths with commas
// are double-quoted, "" = literal quote). Joins fields with tabs so downstream
// TSV-shaped handling is unchanged. Exported ONLY so the suite can pin its field
// semantics: this box runs es 1.1.0.37, which never exits 6, so the fallback that
// calls it cannot be reached end-to-end here (see test case 26).
export function csvLineToTabs(line: string): string {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\t");
}

// ---------------------------------------------------------------------------
// Regex dialect guard — JavaScript RegExp vs ripgrep (pi's builtin grep engine)
// ---------------------------------------------------------------------------

/** Index of the `]` closing the character class that opens at `open`; -1 when unterminated. A `]` in
 *  the first position is a literal member, so the scan starts past it. */
function classEndIndex(pattern: string, open: number): number {
  let j = open + 1;
  if (pattern[j] === "^") j++;
  if (pattern[j] === "]") j++;
  for (; j < pattern.length; j++) {
    if (pattern[j] === "\\") {
      j++;
      continue;
    }
    if (pattern[j] === "]") return j;
  }
  return -1;
}

/**
 * Constructs whose JavaScript RegExp meaning differs from ripgrep's. Both tools
 * take a `pattern` string, so an agent carries ripgrep syntax over and gets a
 * SILENTLY different answer. Measured 2026-11-04 on one file, pi's grep vs this
 * tool: `[[:alpha:]]` 46 rows / 1 row; `\p{L}` 46 / 0; `\Aclass` 1 / 0;
 * `EsStub22\z` 1 / 0; `(?i)Out` 22 / raw "Invalid group". The four silent ones are
 * rejected with the substitute named, and the flag case says what to use instead.
 * Round 27 added the same trap on the other side of the fence, all measured on this box with ripgrep
 * 15.1: `\b{start}` (ripgrep answers, JS reads \b plus the text "{start}"), `\k<name>`, `\N{DASH}` and
 * `\Q…\E` (ripgrep refuses, JS reads the letters), and `[a-b--c]`, where BOTH engines accept and
 * disagree - JS answers a b c 5 0 - and ripgrep answers only a b. Lookaround and backreferences are NOT
 * rejected: they work here, and it is ripgrep that refuses them.
 * Round 28 added the brace escapes: `\u{41}` now switches Unicode mode on (like `\p{...}`) so it answers
 * the letter A the way ripgrep does, and `\x{41}` is refused - JavaScript has no brace-hex spelling, and
 * without the flag both read as a letter plus a REPEAT COUNT (measured: 0 rows here, line 1 in ripgrep).
 * `\p{L}` itself is not rejected: Unicode mode turns on for it (patternNeedsUnicode).
 * Never consulted in literal mode, where the pattern is text, not a pattern.
 */
export function patternDialectReject(pattern: string): string | null {
  const JS =
    "everything_grep: patterns are JavaScript RegExp, not ripgrep (pi's builtin grep) - ";
  // Index of the `]` that closes the most recent `[` the scan met, or -1. A class body is a set of literal
  // members in JavaScript AND in ripgrep, so the flag / named-group arms below must not fire inside one
  // (round 175 F-175-02); everything above keeps firing there.
  let classEnd = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) break;
      if ((next === "p" || next === "P") && pattern[i + 2] !== "{") {
        // The construct is \p PLUS its argument: JavaScript reads "\pL" as the text "pL".
        const arg = pattern[i + 2] ?? "";
        // Echo the caller's OWN letter: `\PL` is the negated class, and answering it as `\pL` names a
        // construct nobody typed and points it at the wrong brace form and the wrong plain class (round 175
        // - the self-naming contract case 159 enforces for every other interpolating branch).
        return `${JS}\\${next}${arg} matches the literal text "${next}${arg}", not a Unicode class. ` +
          `Write \\${next}{...} (Unicode mode turns on by itself) or a plain class like ` +
          `${next === "P" ? "[^A-Za-z]" : "[A-Za-z]"}.`;
      }
      if (next === "x" && pattern[i + 2] === "{")
        return `${JS}JavaScript has no \\x{...} brace-hex spelling: \\x before "{" reads as the letter ` +
          `x plus a repeat count, which asks for repeats nobody asked for. Write \\x41, or \\u{41} - ` +
          `that brace form works and turns Unicode mode on by itself.`;
      if (next === "A")
        return `${JS}\\A matches the letter "A" here. Patterns apply to ONE LINE at a time, so ^ is already the start-of-line anchor.`;
      if (next === "z" || next === "Z")
        return `${JS}\\${next} matches the letter "${next}" here. $ is already the end-of-line anchor, because patterns apply to one line.`;
      if (next === "G")
        // Measured 2026-11-05 through the deployed tool: `\Gbeta` answered "0 matches in 0 files" on a
        // corpus holding the text beta, because JavaScript reads `\G` as the letter G. ripgrep's \G is
        // the end-of-previous-match anchor and has no JavaScript spelling at all, so there is nothing to
        // rewrite it to - the only honest answer is a refusal.
        return `${JS}\\G matches the letter "G" here. JavaScript has no previous-match anchor: patterns ` +
          `apply to ONE LINE at a time, so ^ and $ are the only anchors.`;
      if ((next === "b" || next === "B") && pattern[i + 2] === "{") {
        // Round 112 F-112-1: this branch served ONE sentence for both letters, so `\B{end}` was told it had
        // typed `\b{start}` and that JavaScript would read "a word boundary". Both halves were false for `\B`:
        // JavaScript's `\B` is the NON-word boundary, and `\B{...}` is not a ripgrep assertion either - measured
        // 2026-11-05 through pi's own builtin grep, which dies on `\B{end}the` with "error: repetition quantifier
        // expects a valid decimal" while it answers `\b{start}the` (2 rows in docs/extensions.md).
        const asserted = /^\\[bB]\{[^}]*\}/.exec(pattern.slice(i))?.[0] ?? `\\${next}{...}`;
        if (next === "b")
          return `${JS}${asserted} is a ripgrep boundary assertion; JavaScript reads it as a word ` +
            `boundary followed by the literal text "${pattern.slice(i + 2)}". Use \\b, or the builtin ` +
            `grep tool for \\b{...}.`;
        return `${JS}${asserted} is a boundary assertion in NEITHER engine: the builtin grep tool refuses ` +
          `it ("repetition quantifier expects a valid decimal") and JavaScript reads \\B as the NON-word ` +
          `boundary followed by the literal text "${pattern.slice(i + 2)}". Use \\B, or \\b{start} / ` +
          `\\b{end} in the builtin grep tool.`;
      }
      if (next === "N" && pattern[i + 2] === "{")
        return `${JS}there is no \\N{NAME} escape: this reads as the literal text ` +
          `"N${pattern.slice(i + 2)}". Write the character itself, or \\p{...} for a class.`;
      if (next === "Q")
        return `${JS}\\Q...\\E (quote-literally) is not JavaScript syntax: it reads as the letters ` +
          `Q and E. Pass literal:true to search text exactly.`;
      if (next === "k" && pattern[i + 2] === "<") {
        const ref = /^\\k<([^>]*)>/.exec(pattern.slice(i));
        const name = ref ? ref[1] : "";
        // The caller's own capture goes INSIDE this source, so it can be an invalid regex: `\k<(>` made
        // `new RegExp` throw "Unterminated group" and, because the guard runs outside the compile `try`,
        // that raw engine message - quoting a pattern nobody typed, no house prefix, none of the guidance
        // the compile-error path appends - was the answer (round 175 F-175-03). A group name this engine
        // cannot read is simply a group that is not defined.
        let groupDefined = false;
        try {
          groupDefined = new RegExp(`\\(\\?<${name}[>=]`).test(pattern);
        } catch {
          groupDefined = false;
        }
        if (!groupDefined)
          return `${JS}\\k<${name}> backreferences a named group this pattern never defines, so ` +
            `JavaScript reads it as the literal text "k<${name}>". Define (?<${name}>...) first, or ` +
            `pass literal:true.`;
      }
      i++; // an escaped character is never a construct
      continue;
    }
    if (ch === "[" && pattern.startsWith("[[:", i)) {
      // Round 112 F-112-2: this body said "[[:alpha:]] ... one of [ : a l p h then ]" for EVERY POSIX
      // spelling, so a caller who typed `[[:digit:]]` was told about the wrong letters - a refusal that
      // describes a construct nobody passed. The name and the letter set are now taken from the caller's
      // own class, which for `alpha` renders the letters the old sentence hand-typed.
      // The name sits BETWEEN the two colons, so the closing is `:]]`: a first draft that captured up to `]]`
      // rendered `[[:digit::]]` with a colon among the letters, and a capture that excluded the colon failed to
      // match at all and fell back to quoting raw text. An unparseable `[[:` fragment is quoted verbatim instead
      // of being re-spelled - the whole point of the branch is to never name a construct nobody typed.
      const clsMatch = /^\[\[:([A-Za-z]+):\]\]/.exec(pattern.slice(i));
      const raw = pattern.slice(i, i + 12);
      const cls = clsMatch ? clsMatch[1] : raw;
      const shown = clsMatch ? `[[:${cls}:]]` : cls;
      const members = [...new Set(cls.split(""))].join(" ");
      // Round 175 F-175-05: for an unparseable `[[:` fragment this sentence called `[`, `]`, `:` and every
      // other punctuation mark LETTERS (driven: `the letters "[ : a l p h ] x"`) and cut the fragment at 12
      // characters without saying so. A parseable class name really is a set of letters; a raw fragment is a
      // set of characters, and the cut is named when the fragment runs past the window.
      const noun = clsMatch ? "letters" : "characters";
      const cut = clsMatch || pattern.length <= i + 12 ? "" : " (the first 12 characters of it)";
      return `${JS}${shown} is not a POSIX class - JavaScript reads its brackets, its colon and the ` +
        `${noun} "${members}" as ORDINARY class members, so it answers where nothing was asked${cut}. ` +
        `Write the class out ([A-Za-z] for letters, [0-9] for digits), or the builtin grep tool for ` +
        `ripgrep syntax.`;
    }
    if (ch === "[" && !pattern.startsWith("[[:", i)) {
      // The NESTED POSIX spelling. `[a[:alpha:]]` is `a` plus every letter to ripgrep and PCRE; to
      // JavaScript the class ENDS at the first `]`, so it is the members a [ : l p h followed by a literal
      // `]` - driven round 175 F-175-04, it answered one fixture line and nothing else, the silent
      // different-set answer this guard exists to refuse. Only a class that does NOT start `[[:` reaches
      // here, so the one-character difference between the two spellings stays the only thing telling them
      // apart, and a bare `[:alpha:]` (literal members in BOTH engines, driven: it answers) is left alone.
      const nested = /^\[[^\]]*\[:([A-Za-z]+):\]/.exec(pattern.slice(i));
      if (nested) {
        // The match stops at the class's own closing bracket, because that is where JAVASCRIPT's class
        // stops; the caller's spelling keeps one more `]`. The refusal must name what was TYPED (the
        // principle of the branch above), so the echo carries the trailing bracket too.
        const typed = nested[0] + (pattern[i + nested[0].length] === "]" ? "]" : "");
        const nset = [...new Set(nested[1].split(""))].join(" ");
        return `${JS}${typed} nests a POSIX class inside a larger one: ripgrep and PCRE read that as ` +
          `"${nset}" mixed with the rest of the set, but JavaScript ends the class at the first "]" and ` +
          `reads its brackets, its colon and the letters "${nset}" as ORDINARY members, then matches a ` +
          `literal "]" after it. Put the class on its own as [[:${nested[1]}:]] - and if you meant those ` +
          `characters themselves, escape the brackets or pass literal:true.`;
      }
    }
    if (ch === "[") {
      const close = classEndIndex(pattern, i);
      const body = close > i ? pattern.slice(i + 1, close) : "";
      if (body.includes("--"))
        return `${JS}inside a class -- is a RANGE from "-" to the next character, not set ` +
          `difference: ${pattern.slice(i, close + 1)} also matches every character from - up to ` +
          `its end (digits and punctuation included), where ripgrep 15 answers only the ranges ` +
          `before it. Write the set out, spell the dash as \\x2d if you really want that range, ` +
          `or exclude with [^...].`;
      // Remember where this class body ends so the arms below can see that a `(` they meet inside it is a
      // member and not a flag group (round 175 F-175-02). JavaScript classes do not nest, so one extent is
      // enough; an unterminated `[` keeps -1 and everything after it stays guard-visible.
      classEnd = close > i ? close : -1;
    }
    // Inside a class body, `(` and `?` are ORDINARY members in every engine this tool faces: `[(?i)]` is
    // the four characters ( ? i ) in JavaScript AND in ripgrep/PCRE, so there is no flag group and no
    // named-group marker in there to refuse. Round 175 F-175-02 drove `[(?i)]` being refused with "for
    // case-insensitive search pass ignoreCase:true" - advice about a flag the caller's pattern never
    // contained, and no rows for a pattern that asks for four ordinary characters. The `\pL` and anchor
    // arms are ABOVE this line and still fire inside a body, because JavaScript's identity escape there
    // silently answers a letter (driven: `[\pL]`), which is exactly the over-match the guard exists to stop.
    if (i < classEnd) continue;
    if (ch === "(" && pattern.startsWith("(?P<", i))
      return `${JS}a named group is (?<name>...), not (?P<name>...).`;
    if (ch === "(") {
      const flag = /^\(\?([-imsux]+)([:)])/.exec(pattern.slice(i, i + 8));
      if (flag) {
        const instead: string[] = [];
        if (flag[1].includes("i"))
          instead.push("for case-insensitive search pass ignoreCase:true");
        if (flag[1].includes("s"))
          // The scan hands the pattern ONE LINE at a time, so a line terminator is never in the
          // string being tested: `.` already covers a whole line and `[\s\S]` buys nothing over it
          // (measured 2026-11-06: `behave.as` and `behave[\s\S]as` both answered 0 matches across the
          // break between two lines, while `behave` alone answered 2).
          instead.push('nothing crosses a newline here - the scan is one line at a time, so "." and '
            + "[\\s\\S] match exactly the same text");
        if (flag[1].includes("m"))
          instead.push("^ and $ are already line bounds (one line at a time)");
        if (flag[1].includes("x")) instead.push("there is no free-spacing mode");
        if (flag[1].includes("u"))
          instead.push("Unicode mode turns on by itself for \\p{...}");
        return `${JS}${flag[0]} is not JavaScript syntax. ${instead.join("; ")}.`;
      }
    }
  }
  return null;
}

/** True when the pattern uses a Unicode property class, which JavaScript only
 *  understands in `u` mode. `\\p{` (an escaped backslash) stays text. */
export function patternNeedsUnicode(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;
    const next = pattern[i + 1];
    // \p{...} and \u{...} are brace forms only Unicode mode understands. Without the flag
    // JavaScript reads \u{41} as the letter u and a repeat count of 41, so it answers nothing (or
    // "uu" for \u{2}) where ripgrep answers the character A.
    if (pattern[i + 2] === "{" && (next === "p" || next === "P" || next === "u")) return true;
    i++;
  }
  return false;
}

/** True when the pattern compiles WITHOUT the u flag it was given: that flag comes from
 *  patternNeedsUnicode, never from the caller, so an "Invalid escape" from Unicode mode is ours to
 *  explain (measured: \p{L}\- is a SyntaxError with u and answers fine without it and in ripgrep).
 *  The no-u compile is only ever consulted on an error path, never to pick the mode. */
function unicodeFlagIsOurs(pattern: string, flags: string): boolean {
  if (!flags.includes("u")) return false;
  try {
    new RegExp(pattern, flags.replace("u", ""));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ES list fetch — shared by everything_search and everything_grep
// ---------------------------------------------------------------------------

interface EsQueryPrep {
  esQuery: string;
  escapeWarning: string;
}

function prepareEsQuery(query: string): EsQueryPrep {
  const esQuery = query;

  // LLM JSON-escape guard: `\ext:ts` in Everything parses as the literal
  // text "ext:ts" (backslash = escape char) and silently matches nothing.
  // Warn instead of failing silently (verified 2026-09-10: ext:ts -> 228,755;
  // \ext:ts -> 0).
  const escMatch = ESCAPED_OPERATOR_RE.exec(query);
  let warning = escMatch
    ? `Warning: query contains '\\${escMatch[1]}:' — in Everything a backslash escapes the next character, so '${escMatch[1]}:…' was searched as plain text. Remove the backslash to use the operator.\n`
    : "";

  // Quoting is the only way to put a space inside a search-function value, and
  // es.exe's own command-line parser mishandles such a value (issue voidtools/ES
  // #7; see esSupportsArgv). When `-argv` is unavailable that is a FALSE zero,
  // so state it instead of reporting "0 file(s) match" for a folder that is full.
  // The CHEAP test runs first, deliberately: `esSupportsArgv()` spawns a `-version` probe when this process has
  // no memo yet, and four refusal sites decide AFTER prepareEsQuery returns - all four of fetchEsList's `No file
  // list asked for` throws, the 1,500,000-match sort throw among them (round 197 F-197-02 counted them), then
  // execute's column and count refusals. A refusal
  // that says no search of the caller's query was started must not be refutable by the gate's own probe
  // (round 192 F-192-02). A query with no spaced function value now costs one regex test and no spawn.
  if (SPACED_FUNCTION_VALUE_RE.test(query) && !esSupportsArgv()) {
    warning +=
      `Warning: this es.exe did not confirm -argv support (its -version reply here was unusable or older ` +
      `than ${ES_ARGV_MIN_VERSION.join(".")}), so it cannot pass a quoted ` +
      "search-function value: a path containing a space inside `ancestor:`/`parent:`/`path:` returns " +
      "0 even when the files exist, and inside a NAME-valued function (`file:`, `folder:`, `stem:`, " +
      "...) it answers a plausible WRONG non-zero. Upgrade es.exe " +
      "(https://www.voidtools.com/downloads/#cli), or drop the operator and pass the path as one " +
      'quoted term, e.g. "C:\\Program Files\\Git" ext:exe.\n';
  }

  return { esQuery, escapeWarning: warning };
}

// es.exe treats each command-line argument as ONE search; separate
// arguments are ANDed server-side. A single argument containing spaces is
// evaluated as a phrase (literal substring) — verified 2026-09-12
// (repo README — project doc, "es.exe invocation contract"). Queries are therefore split
// into terms before spawning.
//
// Double quotes are KEPT in the emitted term. They are the only way a search
// function can carry a value containing a space (`ancestor:"C:\Program Files"`),
// and with `-argv` (see esSupportsArgv) es.exe passes them through to Everything
// intact. Deleting them — the old behaviour — made every spaced function value
// unspeakable: the term reached the server as `ancestor:C:\Program Files`, where
// Everything ends the function argument at the space and the search returns 0.
function splitQueryTerms(q: string): string[] {
  const terms: string[] = [];
  let cur = "";
  let inQuotes = false;
  let has = false;
  const push = () => {
    if (has && cur !== "") terms.push(cur);
    cur = "";
    has = false;
  };
  for (const ch of q) {
    if (ch === '"') {
      // `path:` is a SUBSTRING test on the full path, so a quoted value that reaches
      // Everything WITH a trailing backslash can only match at a directory separator -
      // which is exactly the ancestor: set: path:"C:\Program Files" = 3,181 vs the same
      // value with the trailing backslash = 1,961 = ancestor:"C:\Program Files" (the
      // 1,220 excess is the C:\Program Files (x86) subtree). Only ONE backslash is
      // dropped, so "…\" and "…\\" are different queries - write quoted paths with no
      // trailing backslash. The drop lives HERE, in splitQueryTerms; no upstream layer
      // removes a separator (an ext:exe drive-root query is identical for "C:", "C:\"
      // and "C:\\" - see README).
      if (inQuotes && cur.endsWith("\\")) cur = cur.slice(0, -1);
      inQuotes = !inQuotes;
      cur += ch;
      has = true;
      continue;
    }
    if (ch.trim() === "" && !inQuotes) {
      push();
      continue;
    }
    cur += ch;
    has = true;
  }
  push();
  return terms;
}

/**
 * es.exe parses every argv element that begins with `-` as a SWITCH, so a search term that starts
 * with a hyphen never reaches the index. Measured 2026-11-04 through this tool: query
 * `-nosuchflag ext:txt` answered `Error 6: Unknown switch` (exit 6, and a 291-line usage dump lands
 * on STDOUT, not stderr), and query `-version ext:txt` answered "No results found" because es.exe
 * exited 0 having printed its version banner - the query never ran. `--` ends option parsing and
 * changes nothing about Everything's own syntax (a scoped function query counts 2 with and 2
 * without it), so it goes between the flags and the terms. Behind `-regex` it cannot: that switch
 * takes the element after it as its argument (`-regex -- foo` exits 6), so the terminator moves to
 * AFTER the first term. Flags must stay in front of it - `-- -case …` turns `-case` into a search
 * term and a 1-hit query became 0.
 */
function termArgs(matchFlags: string[], terms: string[]): string[] {
  if (matchFlags.includes("-regex") && terms.length > 0) {
    return [...matchFlags, terms[0], "--", ...terms.slice(1)];
  }
  return [...matchFlags, "--", ...terms];
}

/** The largest number `intParam` passes through unchanged: a parameter with no declared maximum
 *  (`offset`, `context`) still has to be a FINITE whole number, and nothing above this is reachable
 *  anyway - the list fetch is 2,000 rows and an `offset` past it gets its own explanation. */
const WHOLE_NUMBER_MAX = Number.MAX_SAFE_INTEGER;

/** Read a BOOLEAN tool parameter. pi passes parameters through WITHOUT validating them against the
 *  schema (round 82 proved it: `sort:"bitrate"` reached es.exe), so a caller's `"false"` is a NON-EMPTY
 *  STRING and plain truthiness turns the flag ON - the opposite of what it says. A real boolean passes;
 *  the words true/false are read as they mean; anything else is refused with the value quoted, because a
 *  guessed flag is not recoverable from the answer. */
function flagParam(name: string, raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  throw new Error(
    `${name} must be true or false; it got ${showParamValue(raw)}. ` +
      `pi does not check tool parameters against their schema, so this tool does.`,
  );
}

/** Read a WHOLE-NUMBER tool parameter: a number, or a digit string like "7" (what a JSON caller means).
 *  Out-of-range NUMBERS clamp, exactly as the previous code did - the schema's "max N" is a ceiling on
 *  the answer, not a question. A value that is not a number at all is refused: Math.floor("abc") is NaN,
 *  and NaN is not a count. It reached es.exe as `-n NaN`, it printed "none in this window (offset NaN,
 *  limit 100)" at a caller, and inside everything_grep it switched the match ceiling off (n >= NaN is
 *  false for every n) and dropped every match line the renderer was about to print (all four measured
 *  2026-11-05 through the deployed tool). */
function intParam(
  name: string,
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === null) return fallback;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  if (!Number.isFinite(n)) {
    const range =
      max === WHOLE_NUMBER_MAX
        ? `a whole number of ${min} or more`
        : `a whole number from ${min} to ${max}`;
    throw new Error(
      `${name} must be ${range}; it got ${showParamValue(raw)}. ` +
        `pi does not check tool parameters against their schema, so this tool does.`,
    );
  }
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** Read a STRING tool parameter. pi does not validate parameters (round 82), and a non-string reaching a
 *  string method is a crash the caller cannot read: measured 2026-11-05 through the deployed tool,
 *  `query:5` died as "params.query.trim is not a function", `path:{}` and `path:true` as
 *  "params.path.replace is not a function", `query:5` on the grep side as "params.query?.trim is not a
 *  function". A slot that never type-checks is worse than a crash: everything_grep turned `pattern:{}` into
 *  the character class `[object Object]` and answered "[9 matches in 5 files]" on a fixture holding no such
 *  text, while `pattern:["a","b"]` searched for the literal `a,b` and `pattern:5` for `5` - three wrong
 *  answers that all look like ordinary zeros (same probe). */
function stringParam(name: string, raw: unknown, shape: ParamShape = "sent"): string {
  if (typeof raw !== "string") {
    throw new Error(
      `${name} must be a string; it got ${showParamValue(raw)}. ` +
        `pi does not check tool parameters against their schema, so this tool does.`,
    );
  }
  if (byteLen(raw) > MAX_PARAM_BYTES) throw new Error(paramTooLongBody(name, byteLen(raw), shape));
  return raw;
}

/** Read an ARRAY OF STRINGS tool parameter (`columns`). Two failures sit one line apart here: a STRING is
 *  iterable, so `[...new Set("width")]` silently becomes w, i, d, t and the refusal blames four one-letter
 *  column names; a number or object dies in the spread ("number 5 is not iterable", "object is not
 *  iterable"). A non-string ELEMENT used to fall through to the unknown-name refusal and print
 *  "Unknown column(s): ." for `null` - an empty name. All four measured 2026-11-05. */
function stringListParam(name: string, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${name} must be an array of column-name strings; it got ${showParamValue(raw)}. ` +
        `A single name still goes in the array: ["width"].`,
    );
  }
  return raw.map((v, i) => {
    if (typeof v !== "string") {
      throw new Error(
        `${name}[${i}] must be a column-name string; it got ${showParamValue(v)}. ` +
          `The names this tool accepts are listed in the parameter description.`,
      );
    }
    // Round 120: an element is a value too. Without this line the unknown-column refusal echoed a 40,000-byte
    // "column name" whole, because every OTHER string parameter is length-checked by stringParam - so the
    // ceiling only really covered the parameters it named.
    if (byteLen(v) > MAX_PARAM_BYTES) throw new Error(paramTooLongBody(`${name}[${i}]`, byteLen(v)));
    return v;
  });
}

/** A parameter value as it should appear inside a refusal: quoted when it is text, exact when it is a
 *  number (so NaN and Infinity say which they are). */
function showParamValue(raw: unknown): string {
  if (typeof raw === "string") {
    // A huge value is quoted only as far as MAX_ECHO_BYTES and the total is stated: this helper feeds the
    // refusal bodies for sort, order, columns and "must be a string", and an unbounded one printed a
    // 40,000-byte sort value straight back at the caller (round 120, measured through execute()).
    if (byteLen(raw) <= MAX_ECHO_BYTES) return JSON.stringify(raw);
    const head = boundedEchoHead(raw);
    return `${JSON.stringify(head)} (+${(byteLen(raw) - byteLen(head)).toLocaleString("en-US")} more bytes, ${byteLen(raw).toLocaleString("en-US")} total)`;
  }
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (raw === null) return "null";
  if (Array.isArray(raw)) return `[${raw.map(showParamValue).join(", ")}]`;
  if (typeof raw === "object") return JSON.stringify(raw) ?? "an object";
  return typeof raw;
}

function matchFlagArgs(o: {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  matchPath?: boolean;
  diacritics?: boolean;
}): string[] {
  const flags: string[] = [];
  if (o.caseSensitive) flags.push("-case");
  if (o.wholeWord) flags.push("-whole-word");
  if (o.matchPath) flags.push("-match-path");
  if (o.diacritics) flags.push("-a");
  // -regex goes LAST, and it must: es.exe documents it as "-r <search>, -regex <search>", so it
  // consumes the argument that FOLLOWS it. Measured 2026-11-04 on a 5-file fixture:
  // "-case -regex a" = 5 rows while "-regex -case a" = 0 (the pattern became the text "-case");
  // -w gave 1 vs 0 and -a gave 5 vs 0. Emission order here is what keeps the flags combinable.
  if (o.regex) flags.push("-regex");
  return flags;
}

/** The nine sort names this tool prices and the two order suffixes es.exe takes, checked ONCE for every
 *  branch. Round 82 F-82-2 added the check after measuring `sort:"bitrate"` and `sort:"run-count"` reach
 *  es.exe straight through execute() - pi does not validate parameters at runtime, so the schema's enum is
 *  decoration. Round 84 F-84-5 found the check was only as wide as the one call site it lived in: with
 *  `count_only:true` the parameter never reaches the list runner, so `sort:"bitrate"` answered "5 file(s)
 *  match: ... [count_only returns the count only: sort=bitrate is not applied to this answer]" and `sort:{}`
 *  echoed "sort=[object Object]" - one bad name, two verdicts, decided by an UNRELATED parameter.
 *  Why the accepted set is closed: a property sort is the worst cost class this tool knows - it reads a
 *  property for EVERY match before it can hand back a page, so -n buys nothing. Warm, twice each, at 324,987
 *  and at 3,778,361 entries (C:/tmp/esq82/p6.mjs): author 30,009-30,017 ms and never answered, width
 *  30,012-30,111 ms never, bitrate 30,009-30,012 ms never - the whole list budget gone on a call that could
 *  not answer. The three cheap extras did answer (run-count and date-run 48-52 ms at either scale,
 *  filelist-filename 74-75 ms then 374-379 ms) but nothing here prices them, so they stay outside the
 *  accepted set until a round admits them on purpose. */
function validateSortOrder(sort: unknown, order: unknown): void {
  if (sort !== undefined && !(SORT_COLUMNS as readonly string[]).includes(sort as string)) {
    throw new Error(
      `sort=${showParamValue(sort)} is not a sort this tool prices: this build sends ` +
      `${SORT_COLUMNS.join(", ")}.
` +
      `es.exe knows more names - run-count, date-run, filelist-filename and any shell property (author, width, ` +
      `bitrate) - and pi does not check the schema at runtime, so the name would reach es.exe. A property sort ` +
      `reads a property for EVERY match before it can return a page, so -n cannot save it: at 324,987 and at ` +
      `3,778,361 entries "-sort author-descending", "-sort width-descending" and "-sort bitrate-descending" each ` +
      `burned the full 30 s and answered nothing (30,009-30,111 ms, twice each at both scales). Sort by name, ` +
      `path, size, extension, date-modified or date-recently-changed instead - those cost tens of ` +
      `milliseconds whatever the ` +
      `query matches - or drop the sort and page through index order.`);
  }
  if (order !== undefined && order !== "ascending" && order !== "descending") {
    throw new Error(
      `order=${showParamValue(order)} is not "ascending" or "descending". es.exe takes only those two ` +
      `suffixes (measured 2026-11-05: "-sort name-bogus" -> "Error 4: Unknown sort: name-bogus", exit 4, while ` +
      `the bare name and a trailing "-" answer as ascending), so nothing else is worth sending.`);
  }
}

interface EsListOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  matchPath?: boolean;
  diacritics?: boolean;
  sort?: string;
  order?: string;
  fetchCount: number; // rows to fetch (-n)
  offset?: number; // row the caller's window starts at; at/above MAX_FETCH skips the fetch
  detailsMode: boolean; // false → plain path lines; true → TSV/CSV rows
  extraCols: string[];
  totalSize?: boolean; // also fetch -get-total-size in parallel
  signal?: AbortSignal;
}

interface EsListResult {
  esQuery: string;
  escapeWarning: string;
  total: number | null;
  totalSizeBytes: number | null;
  /** Why there is no byte total (timeout / error / unreadable reply / sentinel clash), or null
   *  when totalSizeBytes is the answer. Rendered by sizeSentence(). */
  totalSizeNote: string | null;
  /** Names the scan-only term that made the count and total-size calls pointless (they were not made at
   *  all - see soleScanOnlyTerm), or null when a count was actually asked. */
  countSkippedTerm: ScanSkip | null;
  lines: string[]; // all fetched rows, normalized (slice locally)
  csvFallback: boolean;
}

/**
 * Shared es.exe result pipeline: query terms passed as separate argv entries
 * (es.exe ANDs separate terms server-side; one argument with spaces = phrase),
 * escape-operator warning, temp-file export (-export-txt, or -export-tsv with
 * CSV fallback), parallel result-count + optional total-size, normalized
 * line output.
 */
async function fetchEsList(o: EsListOptions): Promise<EsListResult> {
  const query = o.query.trim();
  if (!query) throw new Error("query must be a non-empty string");
  const { esQuery, escapeWarning } = prepareEsQuery(query);
  const matchFlags = matchFlagArgs(o);
  // Round 82 F-82-2: the schema lists nine sort names, and the comment on esFailureMessage used to claim pi's
  // enum stopped anything else reaching es.exe. What it does not protect is THIS function: pi's own call
  // boundary does reject a value outside the enum for a tool call (measured 2026-11-06, `sort:"author"` ->
  // `Validation failed for tool "everything_search": - sort: must be equal to one of the allowed values`, and
  // that message lists no allowed values), but that layer is not between execute() and es.exe, and a name
  // outside the list answers straight through a direct call (measured 2026-11-05: sort "run-count" and sort
  // "bitrate" through execute()). es.exe knows run-count, date-run, filelist-filename and ANY shell property name, and a
  // property sort is the worst cost class this tool knows: it reads a property for EVERY match before it can hand
  // back a page, so -n buys nothing. Warm, twice each, at 324,987 and at 3,778,361 entries (index counts as of
  // 2026-11-05; C:/tmp/esq82/p6.mjs):
  // author 30,009-30,017 ms and never answered, width 30,012-30,111 ms never, bitrate 30,009-30,012 ms never -
  // the whole list budget gone on a call that could not answer. The three cheap extras did answer (run-count and
  // date-run 48-52 ms at either scale, filelist-filename 74-75 ms then 374-379 ms) but nothing here prices them,
  // so they stay outside the accepted set until a round admits them on purpose.
  // One check for both spellings, shared with everything_search's parameter block (round 84) so a bad sort
  // or order name gets the SAME verdict whether or not this particular answer would have used it.
  validateSortOrder(o.sort, o.order);
  const sortArgs = o.sort ? ["-sort", `${o.sort}-${o.order ?? "ascending"}`] : [];

  const tmpFile = join(
    tmpdir(),
    `pi-es-${process.pid}-${randomBytes(4).toString("hex")}.${o.detailsMode ? "tsv" : "txt"}`,
  );
  // Round 86 F-86-1: es.exe creates the export file BEFORE this function knows whether the call succeeded,
  // and every early exit below - an aborted call, a timeout, an es error, the CSV fallback's own failure -
  // used to leave it in the user's Temp folder: 164 zero-byte `pi-es-*` files sat there after three days of
  // probes, one per failed call (plus one .tsv/.csv PAIR from the fallback). ONE cleanup for every exit
  // path; the finally at the end of this function calls it too. THE RETRIES ARE THE FIX, not decoration: on
  // an aborted call the child has been killed but Windows still holds its file handle for a few milliseconds,
  // and a plain rmSync then fails EPERM (measured 2026-11-05 - attempt 0 EPERM, attempt 1 at +25 ms OK, on
  // both the .txt and the .tsv shape). `rmSync`'s OWN maxRetries option does not help here (measured: with
  // maxRetries:8 / retryDelay:25 the file still survived every aborted call), so the loop is hand-rolled.
  const csvExportFile = tmpFile.replace(/\.tsv$/, ".csv");
  const dropExportFiles = async () => {
    // Bounded: 5 tries x 25 ms, and only EPERM/EBUSY keep it looping. A temp file that still outlives the
    // call is a lost round, not a failed answer.
    for (let attempt = 0; attempt < 5; attempt++) {
      let busy = false;
      for (const f of [tmpFile, csvExportFile]) {
        try {
          rmSync(f, { force: true });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException | null)?.code;
          if (code === "EPERM" || code === "EBUSY") busy = true;
        }
      }
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const exportArgs = o.detailsMode
    ? [
        "-full-path-and-name", "-size", "-date-modified",
        "-date-format", "1", "-no-header",
        ...(o.extraCols.length > 0 ? ["-add-columns", o.extraCols.join(";")] : []),
        "-export-tsv", tmpFile,
      ]
    : ["-export-txt", tmpFile];
  const resultArgs = [
    ...exportArgs,
    // es.exe's `-n` is no place for un-checked arithmetic: measured 2026-11-04 over a 1,892-file
    // corpus, `-n 0` answered 0 rows and `-n -1` / `-n -5` answered all 1,892 - a negative count
    // means "no limit", so one bad value turns a listing into the whole index (3,777,457 items on
    // this box). pi's schema keeps `limit >= 1` and `offset >= 0`, so a validated call cannot get
    // here with either; `fetchCount` is still `Math.min(offset + limit, MAX_FETCH)`, so clamp it
    // rather than trust the caller. `|| 1` also catches a NaN from a direct execute() call.
    "-n", String(Math.max(1, Math.trunc(o.fetchCount) || 1)),
    ...sortArgs,
    ...termArgs(matchFlags, splitQueryTerms(esQuery)),
  ];
  // A query built ONLY of scan-only terms has no count to fetch (see soleScanOnlyTerm): asking costs the
  // whole count budget and answers nothing at all. Both metadata calls are then skipped and the header
  // says why, instead of spending 15 s to report a timeout. A scan-only term alone on one side of a union is
  // the same dead end seen from the other side (see unionScanOnlyTerm), and is treated the same way.
  const skipCountTerm = uncountableScanTerm(
    esQuery,
    splitQueryTerms(esQuery),
    regexRequested(o, esQuery) ? 0 : -1,
  );

  // Round 69 F-69-4/F-69-5, widened in round 70: these families have no LISTING to wait for here either, not just
  // no count, so this is refused before spawning es. Measured: an unscoped `latitude:47` answered neither a count
  // nor a bounded `-n 5` listing in 30 s, and `da:today` WITH a folder ANDed answered neither in 15 shapes - while
  // unscoped it returned 5 rows in 5.1 s on 2026-11-05 (4.9 s on 2026-11-07). Round 70 measured 20 more per-entry
  // unscoped silence, and found that a NARROW partner rescues them (`latitude:47 ext:mp3` = 0 rows / 131 ms), so
  // the property rule is "nothing narrows it", not "no place term". This runner serves everything_search's list
  // path AND everything_grep's candidate selection, so this one guard covers both tools.
  const unlistable = unaskableTerm(splitQueryTerms(esQuery), "list") ?? perEntryPropertyAsk(esQuery);
  if (unlistable)
    throw new Error(`No file list asked for: ${esQuery}\n${listNotAskedBody(unlistable)}`);
  // Round 71 F-71-2: the same priced-walk rule on the LIST path, against the LIST leash. This runner also serves
  // everything_grep's candidate selection, so this one guard covers both tools' listings.
  // Round 196 F-196-01: the scan-only scope at candidate-fetch size. `fetchCount` is the gate, and it is what
  // separates this call from a search page: `everything_search` clamps its fetch to MAX_FETCH = 2,000 (below
  // MAX_CANDIDATE_FILES + 1) and keeps its bounded answers, while everything_grep's candidate selection and its
  // files-only rescue both ask MAX_CANDIDATE_FILES + 1 = 2,001 rows, which cannot stop early. The measured pair is
  // quoted in the refusal body. This runs BEFORE the list guard because a scan-only scope has no price to consult,
  // and it answers as a refusal rather than a timeout: milliseconds instead of the 30 s that fetch would burn.
  if (skipCountTerm && !skipCountTerm.why && o.fetchCount > MAX_CANDIDATE_FILES)
    throw new Error(`No file list asked for: ${esQuery}\n`
      + listNotAskedBody({ ...skipCountTerm, candidateFetch: o.fetchCount }));
  const tooWide = await widePropertyWalk(esQuery, matchFlags, o.signal, "list");
  if (tooWide)
    throw new Error(`No file list asked for: ${esQuery}\n${listNotAskedBody(tooWide)}`);
  // This runner also asks its own -get-result-count (15 s). Round 196 F-196-04 retires the guarantee this block
  // used to state - "a walk the LIST guard lets through cannot blow that budget: the listing lease buys 30,000
  // entries at the default 1,000 us (or 16,666 at `dimensions:`'s THEN-1,800, now 5,000 for a 6,000-entry lease),
  // and those entries at the SAME column's
  // count rate cost 5.1 s and 4.2 s of the 15 s that call has" - which holds only where a column's LIST rate is at
  // least its COUNT rate. `orientation:` is priced the other way for its `>` comparisons (50 us a listing against
  // 600 us a count, so that lease buys 600,000 entries and 600,000 at its own COUNT rate is 360 s; round 202 moved
  // every other value of the column to a 5,000 us listing - still above the count rate, so that half needs
  // no exception of its own in the rule this comment records). The
  // shape that drove the rule: `orientation:>1
  // ext:mjs` (a 118,442-entry partner) listed its rows and burned the whole 15 s count leash to report no total,
  // while `count_only` on the identical query is refused at 55 ms (C:/tmp/esq196/out196.txt B9 against A11). So the
  // same priced-walk rule now also runs against the COUNT lease, and a count that cannot fit its own leash is
  // skipped BEFORE either metadata call spawns - which is what lets the skip body say truthfully that no count of
  // this query was asked. Cost: one extra indexed count of the ANDed partners (40-60 ms), and only on a
  // per-entry-value query; every other query returns from the list guard or a scan skip before it spawns.
  const countWalkTooWide = skipCountTerm === null
    ? await widePropertyWalk(esQuery, matchFlags, o.signal, "count")
    : null;
  const countSkip = skipCountTerm ?? countWalkTooWide;
  const noCountAsked: EsOutcome = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };

  // A size call is NOT a walk of the files and needs no lease of its own - see the same call in the count_only
  // branch below, where the measurement is written out.
  const totalSizeP = o.totalSize && !countSkip
    ? runEs(["-get-total-size", ...termArgs(matchFlags, splitQueryTerms(esQuery))], o.signal, COUNT_TIMEOUT_MS)
    : null;
  // An offset at or past the fetch ceiling can never hold a row, and asking for one still pays the
  // list cost: measured 2026-11-04, `dc:today` at offset 3900 spent the whole 30 s list budget and
  // timed out, while the same page on an indexed query answered the ceiling note in 84 ms. Skip the
  // fetch; the count and size calls above still run so the header keeps what it can report.
  const skipList = (o.offset ?? 0) >= MAX_FETCH;
  // Three of the nine accepted sorts order EVERY match before they can hand back a page, so their cost tracks the
  // match set (12.5-25 us an entry at the -n 500 rungs from 324,987 entries up, and the rate is a function of the
  // QUERY, not of the row count: WARM 2026-11-05 at 324,987 entries attributes 4,264-4,339 ms, date-created
  // 4,182-4,219 ms, date-accessed 4,129-4,184 ms; driven again 2026-11-07 (`C:/tmp/esq205/out205c.txt`,
  // `out205d.txt`; drivers `drive205c.mjs`, `drive205d.mjs`; a 45-52 ms count control on either side of the re-run)
  // attributes took 18.3-18.7 s over 1,461,299 entries (12.5-12.8 us an entry, attributes driven alone there) and
  // 14.1-24.2 s over 1,059,906 (13.3-22.8 us, that day's two drives together) - a SMALLER set at a HIGHER rate -
  // while over 1,816,088 attributes took 40.3-43.1 s and date-created 45.5 s, past the leash; `date-accessed` was
  // not re-driven. None of the three was ever inside 30 s at 3,777,046, and these figures are a bound, not a
  // forecast: ANDing one more clause that removes almost nothing (`hard-link-count:>0` leaves 1,056,544 of those
  // 1,059,906, so 3,362 removed) made the SAME sort answer in 2,314 ms against 23,577 ms, which no rate-times-rows
  // model predicts and none is asked to explain)
  // while the other six cost 35-49 ms as es.exe at any scale (the `sort` schema is the carrier of that band and
  // of the 54-77 ms through-the-tool figure) - C:/tmp/esq78/p1.mjs, p2.mjs, C:/tmp/esq79/p9.mjs, esq80/p1.mjs.
  // A match-set sort of a broad query would burn
  // the whole list budget and answer nothing, so those sorts alone pay their (45 ms) count call FIRST and are
  // refused here past PER_ENTRY_SORT_MAX_ROWS; every other sort keeps its count and its fetch running in parallel
  // exactly as before, so no ordinary call gets slower.
  const countArgs = ["-get-result-count", ...termArgs(matchFlags, splitQueryTerms(esQuery))];
  let preCount: EsOutcome | null = null;
  if (o.sort !== undefined && PER_ENTRY_SORT_COLUMNS.includes(o.sort) && !skipList && !countSkip) {
    preCount = await runEs(countArgs, o.signal, COUNT_TIMEOUT_MS);
    const sortRows = preCount.code === 0
      ? parseCountAnswer(preCount.stdout.toString("utf-8").trim())
      : null;
    // Band ownership (round 153 F-14, narrowed by round 161 F-161-6): this refusal body carries ONLY
    // the per-entry band (12.5-25 us/entry at the rungs from 324,987 entries up). The six free names are called
    // "tens of milliseconds"
    // here and in the unpriced-name sibling, because the numbered round-85 band (es.exe 35-49 / tool
    // 54-77 ms) lives in the `sort` schema, which is the surface a caller is quoted: one copy per
    // number, so a later re-measure cannot leave three bands disagreeing.
    if (sortRows !== null && sortRows > PER_ENTRY_SORT_MAX_ROWS) {
      const sortName = o.sort;
      throw new Error(`No file list asked for: ${esQuery}\n`
        + `sort=${sortName} orders every match before it can return a page, and this query holds ` +
        `${sortRows.toLocaleString("en-US")} of them. That sort costs about 12.5-25 microseconds an entry at the ` +
        `sizes measured here, and that rate is a function of the QUERY, not of the row count alone: 324,987 ` +
        `entries took ${PER_ENTRY_SORT_MEASURED[sortName] ?? "4,129-4,339 ms"} (either direction), and on the ` +
        `2026-11-07 drives 1,461,299 took 18.3-18.7 s, 1,059,906 took 14.1-24.2 s and 1,816,088 took 40.3-45.5 s ` +
        `- past the 30 s a list gets - while the whole index never finished in 30 s, so ` +
        `${PER_ENTRY_SORT_MAX_ROWS.toLocaleString("en-US")} ` +
        `entries is the most this tool will order - a policy line, not a measured capacity. Sort by name, path, ` +
        `size, extension, date-modified or ` +
        `date-recently-changed instead - those cost tens of milliseconds whatever the query matches - or drop ` +
        `the sort and page through index order.`);
    }
  }
  const [countRes, resFirst, tsRes] = await Promise.all([
    // A `preCount` is the sort pre-count, already paid for: never discard one that answered.
    preCount === null && countSkip
      ? Promise.resolve<EsOutcome>(noCountAsked)
      : preCount !== null
        ? Promise.resolve<EsOutcome>(preCount)
        : runEs(countArgs, o.signal, COUNT_TIMEOUT_MS),
    skipList
      ? Promise.resolve<EsOutcome>({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        })
      : runEs(resultArgs, o.signal),
    totalSizeP ?? Promise.resolve(null),
  ]);

  // -export-tsv is unknown to es.exe from the Everything 1.4 era (exit 6).
  // Fall back to CSV (UTF-8) and convert lines to tab shape.
  let res = resFirst;
  let outFile = tmpFile;
  let csvMode = false;
  if (res.spawnError || res.code !== 0) {
    if (!(o.detailsMode && res.code === 6 && !res.spawnError)) {
      // es writes the export file as it goes, so a call that was aborted, timed out or errored has
      // already left a file (usually empty, sometimes partial) behind by the time it fails here.
      await dropExportFiles();
      throw new Error(esFailureMessage(res, esQuery, regexRequested(o, esQuery) ? 0 : -1));
    }
    csvMode = true;
    outFile = tmpFile.replace(/\.tsv$/, ".csv");
    // Replace the ("-export-tsv", tmpFile) PAIR, not just the switch: swapping
    // only the switch left the original .tsv path sitting in the array, where
    // es.exe read it as an extra search term and the fallback matched nothing
    // (verified 2026-11-04: 0 rows with the stray path, 20 without it).
    const csvArgs: string[] = [];
    for (let i = 0; i < resultArgs.length; i++) {
      if (resultArgs[i] === "-export-tsv") {
        csvArgs.push("-export-csv", outFile);
        if (resultArgs[i + 1] === tmpFile) i++;
        continue;
      }
      csvArgs.push(resultArgs[i]);
    }
    res = await runEs(csvArgs, o.signal);
    if (res.spawnError || res.code !== 0) {
      await dropExportFiles();
      throw new Error(esFailureMessage(res, esQuery, regexRequested(o, esQuery) ? 0 : -1));
    }
  }

  // Hoisted above the export read because a skipped list fetch still has to report a total.
  const total = (() => {
    if (countRes.spawnError || countRes.code !== 0) return null;
    return parseCountAnswer(countRes.stdout.toString("utf-8"));
  })();
  // Kept as (bytes, why-not) rather than bytes-or-null so both callers can admit WHICH size
  // failure they are reporting instead of printing nothing (round 21).
  // Skipped metadata is admitted as "not asked", which is a different fact from "did not answer".
  const sizeAns = countSkip
    ? { bytes: null, note: metadataNotAskedBody(countSkip) }
    : sizeAnswerOf(tsRes, total);

  try {
    if (skipList) {
      // No fetch happened, so there is nothing to read. The caller's empty-window branch explains
      // the ceiling; the count and size answers above still ride along.
      return {
        esQuery,
        escapeWarning,
        countSkippedTerm: countSkip,
        total,
        totalSizeBytes: sizeAns.bytes,
        totalSizeNote: sizeAns.note,
        lines: [],
        csvFallback: false,
      };
    }
    if (!existsSync(outFile)) {
      throw new Error(
        "es.exe exited without writing its export file, so nothing was captured. A wedged " +
          "Everything app can look like this: everything_status reports whether the app answers " +
          "es.exe, and nothing about the missing export itself. Retry the call.",
      );
    }
    const raw = readFileSync(outFile, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => (csvMode ? csvLineToTabs(l) : l))
      // Round 17 F-17-A. In details (TSV) mode a tab IS a field separator, so a whitespace trim
      // deleted trailing EMPTY property columns: `columns:["author"]` printed a 4-field header over
      // 3-field rows (measured - and `columns:["date-acquired","extension"]` kept its empty field only
      // because a value followed it), which lets a reader mapping by position take date-modified for
      // the column it asked for. Plain (path-only) lines keep the old trim.
      .map((l) => (o.detailsMode ? l.replace(/[^\S\t]+$/, "") : l.replace(/\s+$/, "")))
      .filter((l) => l.length > 0);
    return {
      esQuery,      escapeWarning,
      countSkippedTerm: countSkip,
      total,
      totalSizeBytes: sizeAns.bytes,
      totalSizeNote: sizeAns.note,
      lines,
      csvFallback: csvMode,
    };
  } finally {
    await dropExportFiles();
  }
}

// ---------------------------------------------------------------------------
// everything_grep — render helpers (byte-compatible with the grep tool)
// ---------------------------------------------------------------------------

/**
 * Display path relative to the session cwd (slash/case-insensitive on
 * Windows); the absolute path when the file is outside cwd.
 */
function displayPathFor(abs: string, cwd: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(abs);
  const c = norm(cwd);
  if (c.length > 0 && a.toLowerCase().startsWith(c.toLowerCase() + "/")) {
    return a.slice(c.length + 1);
  }
  return abs;
}

interface GrepRenderGroup {
  displayPath: string;
  absolutePath: string;
  matchCount: number; // pre per-file-cap
  lines: string[] | null; // file lines (line n = lines[n-1])
  transcoded: boolean; // render rows anchor-less (UTF-16 transcode; see the render site)
  matches: number[]; // 1-based line numbers
}

/**
 * One file's rendered entries. Two passes, mirroring the grep tool's pipeline:
 * pass 1 = context union + sorted + `--` gap separators (dedup semantics: a
 * line that is both match and context renders as a match); pass 2 = optional
 * per-file cap: at most 10 matches per file, dropped matches marked by
 * `... +K more matches`. The cap applies when the match total INCLUDING this
 * file's own matches exceeds 50 (decided per-file at render time — see the
 * scan loop). Displayed lines are capped at 500 chars (pi's builtin grep
 * parity, truncateLine); the anchor hash is always of the FULL line.
 */
function renderGrepGroupEntries(
  group: GrepRenderGroup,
  context: number,
  applyPerFileCap: boolean,
): { lines: string[]; truncated: boolean[] } {
  const lines = group.lines ?? [];
  const matchSet = new Set(group.matches);

  // Union of [m-context, m+context] over all matches (overlapping ranges
  // merge), sorted by line number.
  const lineNums: number[] = [];
  const seen = new Set<number>();
  for (const m of group.matches) {
    const lo = Math.max(1, m - context);
    const hi = Math.min(lines.length, m + context);
    for (let l = lo; l <= hi; l++) {
      if (!seen.has(l)) {
        seen.add(l);
        lineNums.push(l);
      }
    }
  }
  lineNums.sort((a, b) => a - b);

  type Entry =
    | { kind: "separator" }
    | { kind: "match" | "context"; ln: number };
  const entries: Entry[] = [];
  for (let i = 0; i < lineNums.length; i++) {
    if (i > 0 && lineNums[i] > lineNums[i - 1] + 1) entries.push({ kind: "separator" });
    entries.push({ kind: matchSet.has(lineNums[i]) ? "match" : "context", ln: lineNums[i] });
  }

  let matchesSeen = 0;
  let dropped = 0;
  const out: string[] = [];
  const truncated: boolean[] = []; // parallel to out (false on separators)
  for (const e of entries) {
    if (e.kind === "match") {
      matchesSeen++;
      if (applyPerFileCap && matchesSeen > GREP_MAX_MATCHES_PER_FILE) {
        dropped++;
        continue; // drop this match and everything after it
      }
    } else if (applyPerFileCap && matchesSeen > GREP_MAX_MATCHES_PER_FILE) {
      continue;
    }
    if (e.kind === "separator") {
      out.push("--");
      truncated.push(false);
      continue;
    }
    const content = lines[e.ln - 1] ?? "";
    const marker = e.kind === "match" ? ">>" : "  ";
    // Display cap (parity with pi's builtin grep): first 500 chars +
    // "... [truncated]". The anchor hash stays on the FULL line so
    // hashline-anchored edits keep operating on complete content.
    const { text: display, wasTruncated } = truncateLine(content);
    truncated.push(wasTruncated);
    // A LINE:HASH anchor is only honest when pi's read tool would hash the SAME string we
    // searched. That holds for UTF-8 (BOM or not) and for invalid UTF-8, where pi's read
    // decodes to the same replacement-char text we do (suite fixtures: latin1.txt line 2 = f14,
    // ansi-greek.txt line 2 = 1e6). It does NOT hold for UTF-16: pi's read does not transcode, so it
    // hashes the NUL-interleaved text instead (suite fixture utf16le.txt line 2 = 795, where the
    // decoded line we search hashes 3fb). In that form pi's grep separates a hit from its context
    // with the SEPARATOR,
    // not a marker - `path:3: text` for the hit, `path-3- text` for context - and that is the only
    // thing that keeps a context row identifiable once context > 0. Giving both row kinds the same
    // `:n:` shape (measured 2026-11-04) printed five identical-looking rows around one hit and left
    // the reader to guess which line actually matched; the `  ` hashline marker stays out of this
    // group because it would advertise an anchored row that is not one.
    // The anchored arm escapes control characters inside formatAnchoredLine; this arm renders
    // `display` straight, so it escapes here. A BOM'd UTF-16 file can carry a real control character
    // into a row: decodeForScan checks the BOM BEFORE the NUL rule, so such a file is transcoded and
    // searched rather than skipped, and its control chars arrive in the decoded text intact.
    const rendered = escapeControlCharsForDisplay(display);
    out.push(
      group.transcoded
        ? e.kind === "match"
          ? `${group.displayPath}:${e.ln}: ${rendered}`
          : `${group.displayPath}-${e.ln}- ${rendered}`
        : `${group.displayPath}:${marker}${formatAnchoredLine(e.ln, content, display)}`,
    );
  }
  if (dropped > 0) out.push(`... +${dropped} more matches`);
  return { lines: out, truncated };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

interface Health {
  ok: boolean;
  esVersion?: string;
  /** why there is no version string when es.exe itself did start (timeout / non-zero exit) */
  esProbeNote?: string;
  esPath?: string;
  indexCount?: number;
  /** why there is no item count (es.exe answered something that is not a number) */
  indexCountNote?: string;
  lastChange?: string;
  /** null = the freshness probe never answered. Never report an unmeasured index as "not stale". */
  stale: boolean | null;
  freshnessNote?: string;
  detail?: string;
  checkedAt: number;
  /** Which probe produced this object: 1 for the first, incremented on every NEW probe. `checkedAt`
   *  is stamped when a probe STARTS, so a cached (shared in-flight) answer carries the SAME stamp and
   *  a forced re-probe stamps a new one - but two answers stamped within clock resolution of each
   *  other are ambiguous about ordering, and probeSeq names the probe count directly. Added so the
   *  in-flight sharing and the force path can be asserted at all. */
  probeSeq?: number;
}

let health: Health | null = null;
let healthInFlight: Promise<Health> | null = null;
/** Counts NEW probes only, so a shared probe and a re-probe are distinguishable from outside. */
let probeSeq = 0;

async function checkHealth(): Promise<Health> {
  if (health) return health;
  if (healthInFlight) return healthInFlight;
  healthInFlight = (async () => {
    const h: Health = { ok: false, stale: null, checkedAt: Date.now(), probeSeq: ++probeSeq };
    const v = await runEs(["-version"], undefined, STATUS_VERSION_TIMEOUT_MS);
    if (v.spawnError) {
      h.detail =
        `es.exe not found in PATH (or not startable): ${v.spawnError.message}. ` +
        "Install the Everything CLI from https://www.voidtools.com/downloads/#cli " +
        "and add its folder to PATH. " +
        // The other two failure branches both close with the force:true remedy; this one did not, so
        // the one failure shape that can be a PURE cache artefact was the shape that gave the caller no
        // way out of it (measured 2026-11-06: PATH restored between two calls, the second answer came
        // back byte-identical in 0 ms and still read "es.exe: not found"). Same remedy as the index
        // branch below, because this cache is just as sticky.
        "Then re-run everything_status with force:true, because this report is cached for the whole " +
        "session and repeats without re-probing.";
      return h;
    }
    const versionLine = v.stdout.toString("utf-8").trim().split(/\r?\n/)[0];
    if (versionLine) h.esVersion = versionLine;
    else {
      h.esProbeNote = v.timedOut
        ? `\`es.exe -version\` did not answer within ${secs(
            v.timeoutMs ?? STATUS_VERSION_TIMEOUT_MS,
          )}`
        : `\`es.exe -version\` answered no version line (${
            v.stderr.toString("utf-8").trim() || `exit code ${v.code}`
          })`;
    }
    try {
      const where = spawnSync("where", ["es.exe"], {
        encoding: "utf-8",
        timeout: WHERE_TIMEOUT_MS,
      });
      if (where.status === 0) {
        h.esPath = where.stdout.trim().split(/\r?\n/)[0];
      }
    } catch {
      // non-fatal
    }
    const c = await runEs(
      ["-get-result-count", "*"],
      undefined,
      STATUS_COUNT_TIMEOUT_MS,
    );
    if (c.spawnError || c.code !== 0) {
      // A timed-out call has no exit code at all: the old text printed "exit code null", the same
      // class of dead end round 13 removed elsewhere. Name the wait instead.
      const stderr = c.stderr.toString("utf-8").trim();
      const why = c.timedOut
        ? `did not answer -get-result-count * within ${secs(
            c.timeoutMs ?? STATUS_COUNT_TIMEOUT_MS,
          )}`
        : stderr
          ? `answered: ${stderr.replace(/\.$/, "")}`
          : `exited ${c.code}`;
      h.detail =
        `es.exe exists${h.esVersion ? ` (v${h.esVersion})` : ""} but the Everything index ${why}. ` +
        // An `Error N:` reply is es.exe refusing its OWN command line; blaming the app for
        // that sends the reader to start a program that is already answering (round 157 F-3).
        (/Error\s*\d/i.test(stderr)
          ? "es.exe itself refused the request - an `Error N:` line is a command-line-level reply, " +
            "not proof the app is down; the switches this tool sends are the ones `es.exe -help` " +
            "documents, so an `Unknown` complaint names a change on this box, not a stopped app."
          : "The Everything app (Everything.exe) serves the index to es.exe itself - no Windows " +
            "service is required - so start it, or wait for an app that is still building its " +
            "index, then re-run everything_status with force:true.");
      return h;
    }
    const rawCount = c.stdout.toString("utf-8").trim();
    const parsedCount = parseInt(rawCount, 10);
    if (Number.isFinite(parsedCount) && String(parsedCount) === rawCount) {
      h.indexCount = parsedCount;
    } else {
      h.indexCountNote = `es.exe answered ${
        rawCount ? `"${rawCount.slice(0, 40)}"` : "nothing"
      } to -get-result-count *`;
    }
    const m = await runEs(
      [
        "-n", "1",
        "-date-modified", "-date-format", "1",
        "-sort", "date-modified-descending",
        "*",
      ],
      undefined,
      STATUS_FRESH_TIMEOUT_MS,
    );
    if (m.spawnError || m.code !== 0) {
      h.freshnessNote = m.timedOut
        ? `the probe did not answer within ${secs(
            m.timeoutMs ?? STATUS_FRESH_TIMEOUT_MS,
          )}`
        : `it failed (${m.stderr.toString("utf-8").trim() || `exit code ${m.code}`})`;
    } else {
      const firstLine = m.stdout
        .toString("utf-8")
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0);
      if (!firstLine) {
        h.freshnessNote = 'it answered no rows for "*", so the index reports no files at all';
      } else {
        const t = Date.parse(firstLine.split(/\s+/)[0]);
        if (Number.isNaN(t)) {
          h.freshnessNote = `it answered "${firstLine
            .slice(0, 40)
            .replace(/\s+/g, " ")}", which carries no readable date`;
        } else {
          h.lastChange = firstLine.split(/\s+/)[0];
          h.stale = Date.now() - t > STALE_AFTER_MS;
        }
      }
    }
    h.ok = true;
    return h;
  })();
  // `mine` is the identity test that makes the health-slot PUBLISH exclusive: only the probe
  // registered as the in-flight one at completion may write the slot. A forced call above can start
  // a second probe while this one runs; with the uniform probe durations a stub can produce, the
  // superseded call finishes FIRST (started earlier, same budget), so its formerly unconditional
  // write was harmless and the forced answer won the slot by order alone — the overwrite this guard
  // prevents (an older answer republished AFTER the forced one) needs a skewed finish order, the
  // wedged-app shape a forced call exists to escape, which no deterministic rig reproduces. The
  // abandoned probe still runs to its own timeout; round 153 F-5 made the write exclusivity-of-
  // in-flight rather than order-dependent; case 185 pins the source shape and the force invariant.
  const mine = healthInFlight;
  const h = await mine;
  if (healthInFlight === mine) {
    healthInFlight = null;
    health = h; // round 153 F-5: the PUBLISH rides the same guard - an unconditional write let a
    // superseded probe repopulate the slot with the older answer, breaking the force invariant
  }
  return h;
}

// Exported ONLY so test/e2e-spaced-path.mjs can pin the failure wording of every shape a Health
// object can hold; a hung or half-answering Everything app cannot be reproduced on demand.
/** The report's own age account. `checkedAt` is when the PROBE ran, and the process keeps that one
 *  record until `force: true`, so a report that re-prints a cached probe says when it was taken —
 *  without it a one-second-old and a day-old answer are byte-identical (round 182 F-2). Spelled like
 *  `lastChange` (local, T-joined) so the two stamps on one report read the same way. */
function probeEcho(h: Health): string {
  const d = new Date(h.checkedAt);
  const p = (x: number) => String(x).padStart(2, "0");
  const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return ` — probe taken ${at}; this process caches it, force:true re-probes`;
}

export function statusReport(h: Health): string {
  const lines: string[] = [];
  if (h.esVersion) {
    // Round 184: a gate memo reading NO was invisible on a healthy report. The version call that
    // fills this line is a SEPARATE spawn from the gate's own probe and can answer long after the
    // memo was taken, and nothing inside a running process clears the memo - so the one line a
    // healthy report prints has to carry it.
    const gateNo = argvGateState() === false
      ? " — the -argv gate in this process reads NO, so every call here sends the pre-1.1.0.37 " +
        "argument shape and every affected answer says -argv support was not confirmed; that memo " +
        "pre-dates this version reply, and only a new process or /reload re-asks it."
      : "";
    lines.push(`es.exe: ${h.esVersion}${h.esPath ? ` at ${h.esPath}` : ""}${gateNo}`);
  } else if (h.esProbeNote) {
    // es.exe started and only the VERSION call failed. "not found" was a lie that sent agents to
    // reinstall a working CLI (measured 2026-11-04 with a stub es.exe, where the report even printed
    // the path of the binary it had just run). What actually matters is the consequence: esSupportsArgv
    // reads the same reply and falls back to "no -argv", which is the false-zero shape this whole
    // extension exists to prevent.
    lines.push(
      `es.exe: present${h.esPath ? ` at ${h.esPath}` : ""}, but ${h.esProbeNote}. ` +
        (argvGateState() === true
          // Round 184: this lead clause used to call the version unknown whatever THIS PROCESS had
          // already established, so when the gate memo had answered YES the line refuted itself two
          // clauses later. With a settled YES it now describes only this reply.
          ? "This reply does not settle whether it understands -argv. The -argv gate "
          : "Whether it understands -argv is unknown, so a quoted spaced function value " +
            '(ancestor:"C:\\Program Files") can still answer a false zero here. The -argv gate ')
        +
        (argvGateState() === true
          ? "has since answered YES, so calls in this process DO send `-argv`."
          : argvGateState() === false
            ? "reads NO in this process, so this tool sends the pre-1.1.0.37 argument shape and every " +
              "affected answer says -argv support was not confirmed by this process."
            : "has not been probed in this process yet; when it is, an unknown version is treated " +
              "as NO, never tried."),
    );
  } else {
    lines.push("es.exe: not found");
  }
  if (h.ok) {
    lines.push(`Everything index (es.exe round-trip): OK${probeEcho(h)}`);
    if (h.indexCount != null) {
      lines.push(`Indexed items: ${h.indexCount.toLocaleString("en-US")}`);
    } else if (h.indexCountNote) {
      // A missing number used to mean the line simply was not printed, which reads as "nothing to
      // report" rather than "this part failed".
      lines.push(`Indexed items: unknown - ${h.indexCountNote}`);
    }
    if (h.lastChange) {
      // The age is a claim about time, so it is not quantised at 12 h the way Math.round(ms/day)
      // was (measured 2026-11-04 through a stub: a newest row 13 h old printed "(1 day(s) ago)"
      // directly above a rule that fires at 24 h, and 36 h printed "2 day(s) ago"). agoText
      // escalates s / min / h / days, rounded in s and min and floored from hours up. A row dated ahead of this clock is
      // said outright instead of rounding into "0 day(s) ago".
      const elapsed = Date.now() - Date.parse(h.lastChange);
      const age =
        elapsed < 0
          ? `dated ${agoText(-elapsed)} in the future - clock or index skew`
          : `${agoText(elapsed)} ago`;
      lines.push(`Index most recent change (newest indexed row): ${h.lastChange} (${age})`);
      // The age the reader sees is computed at PRINT time (the `elapsed` just above) while `h.stale`
      // was decided at PROBE time, and the process keeps one record until `force: true` — so a cached
      // record can print "(30 h ago)" beside a flag that was false when the probe ran. The warning
      // follows the age printed above it; `details.stale` stays the probe's own verdict (round 182 F-1).
      if (h.stale || elapsed > STALE_AFTER_MS) {
        // The window comes from STALE_AFTER_MS; the settings path comes from
        // everything-search/settings-screenshots/03-ntfs-volumes.png (Options ▸ Indexes ▸ NTFS,
        // per-volume "Monitor changes"). The old text named "Options → Indexing → drive → 'Watch USN
        // journal'", which is neither a page nor an option of this install.
        lines.push(
          `WARNING: index may be stale — no file changes visible in the index in the last ` +
            `${Math.round(STALE_AFTER_MS / 3_600_000)} h (either the machine has been idle, or ` +
            "USN-journal monitoring is off: Everything ▸ Options ▸ Indexes ▸ NTFS ▸ select the " +
            "volume ▸ 'Monitor changes'). Files created or renamed after the date above may NOT " +
            "be found — verify by searching a file you know is recent, or reindex Everything.",
        );
      }
    } else if (h.freshnessNote) {
      lines.push(`Index freshness: NOT MEASURED - ${h.freshnessNote}`);
      lines.push(
        "The absence of a stale warning above means freshness was never checked, not that the " +
          "index is current: recently created or renamed files may be missing from results.",
      );
    }
    if (h.indexCount === 0) {
      // `ok` means only that the round-trip answered, and an empty index answers 0 rows for
      // `*`; recommending the tools over an index that returns nothing is a false steering
      // line (round 157 F-2).
      lines.push(
        "Everything answers 0 rows for `*`, so nothing above recommends the tools yet: start the " +
          "Everything app or wait for its index to build, then re-run everything_status.",
      );
    } else {
      lines.push(
        "Everything search is operational: prefer everything_search over " +
          "find/glob/ls for local file discovery.",
      );
    }
  } else {
    lines.push(`Everything index (es.exe round-trip): NOT REACHABLE${probeEcho(h)}`);
    lines.push(h.detail ?? "Unknown failure — re-run everything_status with force:true.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Search result formatting
// ---------------------------------------------------------------------------

function buildResultText(
  query: string,
  total: number | null,
  offset: number,
  shown: number,
  bodyLines: string[],
  countSkippedTerm: ScanSkip | null,
): string {
  const off = offset > 0 ? ` after offset ${offset}` : "";
  const head =
    total != null
      ? `${total.toLocaleString("en-US")} matching (showing ${shown}${off})`
      : // A count that was never asked (see soleScanOnlyTerm) is a different fact from a count that
        // did not answer, and says more than a timeout would: no call was made and nothing was waited on.
        countSkippedTerm
          ? `showing ${shown}${off} (total unknown: ${metadataNotAskedBody(countSkippedTerm)})`
          : // Round 16 F-16-3: the count call did not answer, so the total is unknown. Say so - a bare
            // "showing 3" reads as a complete answer.
            `showing ${shown}${off} (total unknown: Everything did not answer the count for this query)` +
            unindexedTermClause(query)
  return `${head}\nquery: ${boundedEcho(query)}\n${bodyLines.join("\n")}`;
}
// Keep the header honest after a truncation cut: rewrite its "(showing N)" to the
// number of rows that actually survived. Only the head line carries this token, so a
// plain replace is safe; no match = no change.
function relabelShown(text: string, rowsKept: number): string {
  return text
    .replace(/matching \(showing \d+/, `matching (showing ${rowsKept}`)
    .replace(/^showing \d+/m, `showing ${rowsKept}`);
}

/**
 * es.exe answers a regular expression it cannot parse with 0 rows, exit code 0 and no error text
 * (measured 2026-11-04: `-regex "("` printed 0 and exited 0), so a zero from a regex query is not
 * evidence the pattern was valid. Said only on the zero answers, where it is the one thing the
 * reader cannot check for themselves.
 */
function regexZeroNote(regexUsed: boolean, laterTerms = 0, patternIdx = 0): string {
  if (!regexUsed) return "";
  // Round 167 F-167-02: the parse hint alone sent a caller to "run the same words as a plain query", which
  // does not move a zero whose cause is POSITION. With `-regex` es.exe reads the element after it as the
  // pattern (the terminator moves after that one term), so every term written after the first is an
  // ordinary search and an expression placed second is never a pattern at all.
  // Round 191 F-191-1: that sentence is true ONLY of the `-regex` spelling. The in-query `regex:` spelling
  // carries the pattern inside its own term and sends no `-regex` (matchFlagArgs reads the flag), so
  // `ancestor:"…" zzqqnope regex:(zzqqnope)` had its pattern in the THIRD term while the note said the
  // first and called the scope term an ordinary search. `patternIdx` says which term it is; -1 means the
  // note cannot locate a pattern term and then NO position claim prints. F-191-8: one term now reads
  // "the 1 term after it IS an ordinary search" instead of "are".
  // The clause needs someone to talk about: for a pattern in the FIRST term that is the terms after it, and
  // for a pattern carried by a later term it is every OTHER term (the ones before it are ordinary searches
  // too, which is the half a laterTerms-only gate would have hidden for `… zzqqnope regex:(zzqqnope)`).
  const others = patternIdx + laterTerms;
  const position = patternIdx < 0 || (patternIdx === 0 ? laterTerms <= 0 : others <= 0)
    ? ""
    : patternIdx === 0
      ? `; and only the FIRST term is the pattern here - the ${laterTerms} term${laterTerms === 1 ? "" : "s"} `
        + `after it ${laterTerms === 1 ? "is an ordinary search" : "are ordinary searches"}, so an expression `
        + "written after another term is not a pattern"
      : `; and the pattern here is the term that carries \`regex:\` (term ${patternIdx + 1} of `
        + `${patternIdx + laterTerms + 1}), not the first - the other ${patternIdx + laterTerms} `
        + `term${patternIdx + laterTerms === 1 ? "" : "s"} ${patternIdx + laterTerms === 1 ? "is" : "are"} `
        + "ordinary searches, so an expression written where no pattern was asked for is not a pattern";
  return "\n[everything_search: es.exe answers 0 with exit code 0 for a regular expression it cannot " +
    "parse, so this zero does not prove the pattern was valid - simplify it or run the same " +
    "words as a plain query" + position + "]";
}

/**
 * Says so when a property column was requested more than once. es.exe answers each column once and
 * keeps the LAST position it was asked for (measured 2026-11-04: `-add-columns "width;height;width"`
 * exported the height value first), so `execute` de-duplicates the request and this names what was
 * dropped - otherwise the answer carries fewer column fields than the caller sent and says nothing.
 */
function duplicateColumnNote(dropped: string[]): string {
  if (dropped.length === 0) return "";
  const uniq = [...new Set(dropped)];
  const names = uniq.map((c) => `"${c}"`).join(", ");
  // The verb agrees with the number of DISTINCT column names listed - uniq.length, not names.length (a STRING
  // length) and not dropped.length (duplicate submissions): measured 2026-11-04 with columns
  // ["author","author","author"], which drops two entries and must still read "author was asked"
  return `\n[columns: ${names} ${uniq.length > 1 ? "were" : "was"} asked for more than once; ` +
    "es.exe answers each column once, so this answer carries one field per distinct column]";
}
/**
 * A property column that came back blank on every fetched row. TWO different things cause that and the note
 * tells them apart: FIVE properties (date-run, date-recently-changed, date-acquired, lens-model, people)
 * answer blank on every row of every file kind measured here, and FOUR more (word-count, line-count,
 * last-author, slide-count) fill ONLY legacy OLE documents: `word-count` and `line-count` on 6 of 12
 * `ext:doc`, `last-author` on 6 of 12 `ext:doc` and 8 of 14 `ext:xls`, `slide-count` on 5 of 9 `ext:ppt`
 * (driven 2026-11-06 - no corpus in the earlier sweeps was an OLE document, which is why all nine were filed
 * as dead). A SPARSE property is blank on the kinds that do not carry it - `author`
 * fills on 13 of 40 `ext:pdf` and 6 of 12 `ext:doc` but 0 of 25 `ext:docx`, `page-count` on 28 of 40
 * `ext:pdf`, `latitude` on 1 of 40 `ext:png` (round 104's sweep). Round 105 rewrote this note and the string
 * below, which used to file `author` and `latitude` among the never-populated ones. Either way a blank field
 * is not evidence the file lacks the value, and a caller mapping fields by position cannot see the
 * difference; the `columns` parameter description names what populates, and `date-created` is the populated
 * substitute for `date-acquired`.
 */
function blankColumnNote(names: string[], rowCount: number): string {
  if (names.length === 0) return "";
  const listed = names.map((c) => `"${c}"`).join(", ");
  return `\n[columns: ${listed} ${names.length > 1 ? "were" : "was"} blank on all ${rowCount} fetched ` +
    "row(s). That is the install or the file kind, not the files' worth: five properties (date-run, " +
    "date-recently-changed, date-acquired, lens-model, people) answer blank on every row of every kind " +
    "measured here, four more (word-count, line-count, last-author, slide-count) fill only legacy OLE " +
    "documents (.doc/.xls/.ppt) and nothing else, and others are SPARSE - author and " +
    "page-count fill on PDFs, author on .doc, latitude only on geotagged images - so a blank field is not " +
    "evidence a file has no value. The `columns` parameter description names the ones that populate; " +
    "`date-created` is the populated substitute for `date-acquired`]";
}

/**
 * `|` binds TIGHTER than the implicit AND: it joins the term immediately to its left with the term
 * immediately to its right, and every other term applies to the whole result. Measured 2026-11-04 over a
 * 405-file folder (404 `.js`, 1 `.bin`): `ancestor:"…" *.bin | *.js` answered 405 and
 * `*.js | *.bin ancestor:"…"` answered 405 - the scope sits OUTSIDE the join and limits both sides - while
 * `ancestor:"…" | *.js` answered 310,463 and `*.txt | ancestor:"…" !b.js` answered 34,849, because one side
 * of the join carried no scope. A `<...>` group counts as one term on its side (`ancestor:"…" <*.bin> |
 * *.js` = 405). So an answer is wider than the typed scope exactly when one side of a top-level `|` is a
 * scope term and the other side is not, which is what orScopeNote and notOperatorNote both need. One typing
 * variant matters here: parentheses do NOT group in this grammar - they are literal name characters
 * (see parenAtom()) - so `(ancestor:"…")` answers 0 (405 unparenthesised) and `(ancestor:"…") | *.bin`
 * answered 3,846, the entire index-wide `.bin` set, because the join's other side then ran alone.
 */
// Which side of a `|` names a place is decided by joinSideScoped() below it; see that function for why
// `child:`, `childname:` and `folder:` LEFT the list in round 63.
/**
 * An atom that carries parentheses: `(x)`, `!(x)`, `((x))`, or a stray `x)`. Nothing groups here - `(` and
 * `)` are ordinary LITERAL name characters (round 49) - so such a term asks for names containing those
 * characters, and in a corpus without them it answers nothing. Measured 2026-11-04 on a folder built to
 * hold them: `plain` = 2 files, `(plain)` = the one named `(plain).txt`, `((plain))` = 0,
 * `<(plain)|open>` = 2. Measured on corpora that lack them: `(ancestor:"A")` = 0 against 405,
 * `ancestor:"A" (aaa-oversized)` = 0 against 4, `(aaa-oversized | *.bin)` = 0 against 3,854. That is why
 * the notes name parentheses as the suspect instead of claiming this answer's size: the same shape is
 * perfectly legitimate for a file named `Q3 (draft)`.
 */
function parenAtom(atom: string): boolean {
  return /^!*\(/.test(atom) || atom.endsWith(")");
}

/** True when the QUERY asks for regex grammar through the in-query `regex:` function - which has to be GLUED
 * to its pattern to be that function at all. Measured 2026-11-05: `regex:(a)nswertrim` answers 1 row where
 * the same text written plainly answers 0 (round 51), while `regex: (a)nswertrim` with a SPACE answers 0 -
 * Everything reads the spaced `regex:` as a function with an EMPTY argument, which matches the WHOLE INDEX
 * (3,779,193 rows), and the next term as a plain name. Calling that spelling a regex query cost a full 15 s
 * leash on `regex: <…answertrim | dc:today>`, a scan-only union the refusal catches the moment patternIndex
 * stops claiming a pattern (round 68 F-68-1). This is also the only regex spelling `everything_grep` can
 * reach - that tool has no `regex` parameter - so a note that tests the flag alone misses it entirely. */
function queryAsksRegex(query: string): boolean {
  return /(^|\s)regex:\S/i.test(query);
}

/** True when the caller asked for a regex query, by flag or by the in-query `regex:` spelling. Every
 * literal-name note has to agree on this one test; a site that re-derives it, or forgets it, ships a
 * false grammar claim into a regex call (round 50 F-50-1; round 52 F-52-3 for the function spelling). */
function regexRequested(params: { regex?: boolean }, query: string): boolean {
  return !!params.regex || queryAsksRegex(query);
}

/** Which term of the query the regular-expression pattern IS. `regex: true` makes the pipeline send
 * `-regex`, whose pattern is the element after it - the first term. The in-query `regex:` spelling carries
 * the pattern inside its OWN term and sends no `-regex` at all (`matchFlagArgs` reads the flag), so every
 * other term there is an ordinary search. -1 when no term can be located as the pattern, which keeps
 * `regexZeroNote` from claiming a position it has not checked (round 191 F-191-1). Tests the term START,
 * so a `regex:` that only appears inside a quoted scope value is not mistaken for a pattern. */
function regexPatternTermIndex(params: { regex?: boolean }, query: string): number {
  if (params.regex) return 0;
  const terms = splitQueryTerms(query);
  for (let i = 0; i < terms.length; i++) if (/^regex:\S/i.test(terms[i])) return i;
  return -1;
}

/**
 * Split a query into terms and report which term a TOP-LEVEL `|` follows (the term on its left; the term
 * on its right is that index + 1). Each `<...>` group stays ONE term, double quotes and backslash escapes
 * are honoured, and a `|` inside a group or a quote is not top-level.
 */
/**
 * Is the `>` at index `i` the comparator of a function glued in front of it, so the group stays OPEN past
 * it? Only SOME functions read `>` that way, and one shape shows the difference: in
 * `<ancestor:"…answertrim" | F:>x>` the folder's 405 rows are in the result when Everything leaves the group
 * open, and the query answers 0 when it closes at F's `>` because the leftover `x>` then matches nothing.
 * Measured 2026-11-05 that way - OPEN: `size:>1kb` 2,275,751 · `dm:>monday` 83,428 · `datemodified:>monday`
 * 83,428 · `len:>100` 156,027 (= 405 + 155,622) · `childcount:>2` 216,497 · `daterun:>monday` 410 · and
 * `dc:`/`da:`/`dateaccessed:`/`datecreated:` never answered in 20 s, which is the date scan sitting in the
 * union. CLOSED: `attrib:`, `attributes:`, `attribute:`, `type:`, `numchild:`, `childname:`, `file:`, `ext:`,
 * `parent-name:`, `dateviewed:`, `dateinstalled:`, `listlength:` - each answered 0. Round 65 established the
 * open half (`<size:>1kb>` = `size:>1kb` = 2,274,912); round 68 found the closed half, where the old
 * always-comparator rule REFUSED a count Everything answers in 54 ms
 * (`<ancestor:"…answertrim" | attrib:>h>` = 0 rows / 54 ms). A `>` NOT glued to a `word:` DOES close:
 * `<ancestor:"…answertrim" | >x>` answers 0. syntax.md leans on the comparator reading
 * (`!<!ext:exe|<!size:>1kb|!path:Windows>>` = 9,691). Both group readers use this: `groupsIn`, `queryAtoms`.
 * Two measured divergences stay recorded rather than modelled. (a) A CLOSED name in the FIRST alternative
 * position answers a NONZERO count that neither reading predicts: `<len:>100 | AQ>` = 7,571 where OPEN predicts
 * 156,027 and CLOSED predicts 0 (every leftover a CLOSED reading leaves outside the group - `>1kb`, `>100`,
 * `>2026-01-01`, `>1`, `>h`, `>file`, `>bin`, `>x`, `>47` - was measured at 0 rows, so "CLOSED gives 0" is a
 * measured premise, not an assumption), and the same nonzero-first behaviour shows for `attrib:` 841,646,
 * `type:` 39,481, `childname:` 44,296, `file:` 448,061, `ext:` 60, `parent-name:` 504,981. So "closes" describes
 * the LATER alternative position, where each of those answered 0, and the list below encodes behaviour, never a
 * mechanism. (b) `dc:`/`da:`/`datecreated:`/`dateaccessed:` are un-indexed scans that never answer in ANY
 * position, so the discriminator cannot decide them; they stay listed as OPEN because reading them as CLOSED
 * would UN-refuse `<…answertrim | datecreated:today>`, which then burns the whole 15 s leash (round 69).
 * Round 69 also measured that a group's ORDER does not decide whether an ANDed scope rescues a scan alternative:
 * `<dc:today | *.bin> <folder>` = 405 rows / 74 ms and `ext:bin <dc:today | *.bin>` = 3,536 / 54 ms answer as
 * fast as the same groups with `dc:` last, so `unrescuedScanSide`'s "one narrowing part bounds every part" bail
 * stays order-free.
 * Round 96 extended the OPEN side to every other `word:` this box measures as a comparator. The union shape
 * above cannot price a value function (a union alternative is evaluated index-wide), so round 96 also used a
 * bounded variant of the same test - `count(SCOPE, "F:>qqz")` against `count(SCOPE, "<F:>qqz>")`, equal when
 * the group stays open and 0 for the group form when it closes - over `C:\Windows\Web` (54 rows),
 * `C:\Windows\Media` (109) and `C:\Windows\Fonts` (505). OPEN and admitted now, each twin measured identical
 * in count: `child-count`, `child-file-count`, `child-folder-count`, `descendant-count`, `hard-link-count`
 * (all three of `hard-link-count` / `hardlink-count` / `hardlinkcount`), `run-count`, `date-run`,
 * `parent-count`, `height`, `width`, `bit-depth`, `date-taken`, `duration`, `channels`, `sample-rate`,
 * `bit-rate`. NOT admitted, because no scope here made them nonzero and the discriminator could not decide
 * them, so today's CLOSED reading is kept: `frame-rate`, `dimensions`, `orientation`, `latitude`, `longitude`,
 * `page-count`, `date-acquired`/`dateacquired`. The gap was visible in rendered prose: with the dashless
 * `childcount` admitted but the dashed spelling the documentation itself uses not admitted,
 * `<ancestor:"…answertrim" | child-count:>1>` printed a group note quoting a group that ENDS MID-TERM
 * (`<ancestor:"…answertrim" | child-count:>`) and naming an alternative (`child-count:`) es.exe never
 * evaluated, where the dashless spelling named the real one. Probes C:/tmp/esq96/p1-p5.mjs.
 */
const COMPARATOR_ARG_FUNCTIONS =
  /^(size|len|child-?count|child-?file-?count|child-?folder-?count|descendant-?count|hard-?link-?count|run-?count|date-?run|parent-?count|dm|dc|da|datemodified|datecreated|dateaccessed|height|width|bit-?depth|date-?taken|duration|channels|sample-?rate|bit-?rate):$/i;

function comparatorGt(query: string, i: number): boolean {
  if (query[i] !== ">") return false;
  const m = /([A-Za-z][A-Za-z0-9_-]*:)>$/.exec(query.slice(0, i + 1));
  return m !== null && COMPARATOR_ARG_FUNCTIONS.test(m[1]);
}

function queryAtoms(query: string): { atoms: string[]; pipes: number[] } {
  const atoms: string[] = [];
  const pipes: number[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = "";
  const flush = () => {
    if (cur !== "") {
      atoms.push(cur);
      cur = "";
    }
  };
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === "\\") {
      cur += ch + (query[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (!inQuote) {
      if (ch === "<") depth++;
      else if (ch === ">" && depth > 0 && !comparatorGt(query, i)) depth--;
      else if (ch === "|" && depth === 0) {
        flush();
        if (atoms.length > 0) pipes.push(atoms.length - 1);
        continue;
      } else if (depth === 0 && /\s/.test(ch)) {
        flush();
        continue;
      }
    }
    cur += ch;
  }
  flush();
  return { atoms, pipes };
}

/**
 * The text of the first `<...>` group in `query` whose alternatives include one with NOTHING in it; null if none.
 *
 * Two grammar facts own this. (1) Everything CLOSES AN UNCLOSED `<` AT THE END OF THE QUERY, so an unterminated
 * group swallows the rest of the string exactly as a closed one does (measured 2026-11-04:
 * `<ancestor:"…answertrim"` answered 405 = the same group written closed, and `<ancestor:"…answertrim" |`
 * answered 3,777,994 = the same as `<ancestor:"…answertrim" |>`). (2) An alternative that is empty - or empty
 * once its whitespace is trimmed - matches EVERY FILE: `<>`, `<ancestor:"…answertrim" |>`,
 * `<ancestor:"…answertrim" | >`, `<ancestor:"…answertrim"|>` and `<ancestor:"…answertrim"||*.bin>` each answered
 * 3,777,996 rows, which is the whole index, where `<ancestor:"…answertrim">` answers 405.
 *
 * A `<` glued directly after `:` is a FUNCTION ARGUMENT, where an empty branch is not everything at all, so
 * those are skipped: `ext:<bin |>` answered 0 (and `ext:<bin | txt>` answered 0 as well) where `ext:<bin>`
 * answers 3,537; `size:<1mb |>` answered 3,671,146, the same as `size:<1mb>`; `childname:<a |>` answered 529,175
 * against `childname:<a>` = 324,986. Suppressed rather than reworded: no one sentence covers all three.
 *
 * `patternIndex === 0` means a regex query hands the FIRST WHITESPACE TERM to es.exe as its pattern, where `<`,
 * `>` and `|` are pattern characters, so a group inside that term is exempt - the same exemption
 * orphanPipeReport applies to the pattern's own pipes (`patPipes`), for the same reason:
 * `-regex` with `<ancestor:"…answertrim" |>` AS the pattern answered 3,777,998 through regex alternation, not
 * through group grammar, while `-regex plain -- <ancestor:"…answertrim" |>` answered 422 (the pattern's own
 * count, group limiting nothing) against `-regex plain -- <ancestor:"…answertrim">` = 0.
 */
function inQuotesAt(query: string, idx: number): boolean {
  let n = 0;
  for (let k = 0; k < idx; k++) {
    if (query[k] === "\\") {
      k++;
      continue;
    }
    if (query[k] === '"') n++;
  }
  return n % 2 === 1;
}

/** The alternatives of one group body, split on the `|` characters that are NOT inside a nested group. The
 *  split defers to topLevelAlternatives, which is the only splitter here that knows a `>` glued to `word:` is
 *  a comparator and not the nested group's closing bracket: without that, the `>` of `<size:>1kb` closed the
 *  INNER group early and the outer body was cut into alternatives that exist in no grammar. */
function groupBranchTexts(content: string): string[] {
  return topLevelAlternatives(content);
}

/**
 * Every `<...>` group in the query, left to right, exactly as typed. Three guards, shared by both group
 * notes: a `<` glued to a `:` is a FUNCTION ARGUMENT (`ext:<bin|txt>` = 38,457 = bin + txt, so OR does work
 * there, while `ext:<bin |>` answers 0), a `<` inside a quoted literal is a name character, and when
 * `patternIndex === 0` the first whitespace term is the engine's regex pattern, where `<`, `>` and `|` are
 * pattern characters, so a group inside that term is not grammar.
 *
 * An UNCLOSED `<` runs to the end of the query (Everything closes it there) and a group nested inside it is
 * STILL grammar, so the scan does not stop at an unclosed group (measured 2026-11-05:
 * `<<ancestor:"…answertrim" |>` answered 3,778,027 - the whole index, reached through the INNER group's
 * empty alternative - with no note at all, because a scan that stops at the unclosed outer group never looks
 * inside it; the same query with the outer group closed reports the inner one).
 */
function groupsIn(
  query: string,
  patternIndex = -1,
): Array<{ body: string; end: number; start: number; text: string }> {
  const out: Array<{ body: string; end: number; start: number; text: string }> = [];
  let patStart = -1;
  let patEnd = -1;
  if (patternIndex === 0) {
    const pat = splitQueryTerms(query)[0] ?? "";
    if (pat !== "") {
      patStart = query.indexOf(pat);
      patEnd = patStart + pat.length;
    }
  }
  for (let i = 0; i < query.length; i++) {
    if (query[i] !== "<") continue;
    if (query[i - 1] === ":") continue;
    if (inQuotesAt(query, i)) continue;
    if (patStart >= 0 && i >= patStart && i < patEnd) continue;
    let depth = 0;
    let inQuote = false;
    let close = -1;
    for (let j = i; j < query.length; j++) {
      const ch = query[j];
      if (ch === "\\") {
        j++;
        continue;
      }
      if (ch === '"') {
        inQuote = !inQuote;
        continue;
      }
      if (inQuote) continue;
      if (ch === "<") depth++;
      else if (ch === ">") {
        // A `>` glued straight onto `word:` is that FUNCTION's comparator, not the group's closing bracket, so
        // the group stays open past it (`<size:>1kb>` is ONE alternative - see comparatorGt).
        if (comparatorGt(query, j)) continue;
        if (--depth === 0) {
          close = j;
          break;
        }
      }
    }
    // An unclosed `<` runs to the end of the query and has NO closing `>` to trim, so the body ends at the
    // string, not one short of it (measured: `<ancestor:"…answertrim" |` has alternatives `AQ ` and the empty
    // one - trimming the `|` away hid the whole shape). Groups nested inside an unclosed group are still
    // grammar, so the scan keeps going instead of stopping here (see the block comment above).
    const bodyEnd = close === -1 ? query.length : close;
    const end = bodyEnd + 1;
    out.push({ body: query.slice(i + 1, bodyEnd), end, start: i, text: query.slice(i, end) });
  }
  return out;
}

function emptyGroupBranch(query: string, patternIndex = -1): string | null {
  for (const g of groupsIn(query, patternIndex)) {
    if (groupBranchTexts(g.body).some((b) => b.trim() === "")) return g.text;
  }
  return null;
}

/** A `path:` value that names a PLACE: a drive-letter root or a leading separator. `path:` is a substring
 *  test on the WHOLE path, so a bare token reaches everywhere - measured 2026-11-05:
 *  <ancestor:"…answertrim" | path:dat> answered 1,995,993 where the same group with
 *  path:"C:/tmp/esq-e2e-fixtures" answered the folder's OWN count, not an intersection: 2,046 on that
 *  day's fixture inventory, 2,224 on 2026-11-06's, and the bare quoted path answers that same number on
 *  each day. The equality is the claim; the count is fixture state (cases 63 and 197). */
function absPathValue(rest: string): boolean {
  const v = rest.replace(/^"/, "").replace(/"$/, "");
  return /^[A-Za-z]:[\\/]/.test(v) || /^[\\/]/.test(v);
}
/** True when the text left after the prefix characters names a place: `ancestor:` with a value, `parent:`
 *  always, `path:` only when its own value is a path. `ancestor:` with an EMPTY argument is excluded on
 *  purpose: measured 2026-11-05 it answers the WHOLE INDEX (3,779,193 rows) and ANDing it onto
 *  `<…answertrim | ext:bin>` left the answer unchanged at 3,940, so it bounds nothing - while `parent:` with
 *  an empty argument answers 4 rows, so that one really does. */
function placeFunction(text: string): boolean {
  if (/^ancestor:(?!$)/i.test(text)) return true;
  if (/^parent:/i.test(text)) return true;
  const m = /^path:(.*)$/i.exec(text);
  return m !== null && absPathValue(m[1]);
}
/**
 * Does this JOIN SIDE name a place? `orScopeNote` asks which side of a `|` is the folder side, so a
 * negated or parenthesised scope still counts: `(`, whitespace and `!` are allowed in front because
 * `(ancestor:"…")` is a literal-name atom that scopes nothing (see parenAtom()) yet is plainly the folder
 * side of a join - measured `(ancestor:"…")` answers 0 where the same term unwrapped answers 405.
 * Round 63 took `child:` (an ALIAS of `childname:`: `child:dat` = `childname:dat` = 31,867) and `folder:`
 * out of the list, joining round 62's removal of `childname:`: `syntax.md`'s "Path & hierarchy" section
 * classes `file:`, `folder:`, `stem:`, `parent-name:`, `childname:` and `name:` as NAME-valued, and
 * `folder:answertrim` answers 1 row (the folder entry itself) where `ancestor:"…answertrim"` answers 405.
 */
function joinSideScoped(atom: string): boolean {
  return placeFunction(atom.replace(/^[(\s!]*/, ""));
}
const NEG_HEAD = /^\(*!/;
/**
 * A term that LIMITS WHERE Everything looks - the question the group note asks. Three differences from
 * `joinSideScoped`: a `<` is also allowed in front (a group alternative can start with a nested group); a
 * term headed by `!` is an EXCLUSION and limits nothing (F-62-1); and the term must START with the
 * function, so a quoted name that merely contains `path:` no longer counts as scoped (round 61's open
 * gap 4). Silent failures this list used to hide: <ancestor:"…answertrim" | childname:dat> = 32,272,
 * <ancestor:"…answertrim" | folder:dat> = 12,735, <ancestor:"…answertrim" | child:dat> = 32,272 and
 * <ancestor:"…answertrim" | path:dat> = 1,995,993, all unanswered before rounds 62-63.
 */
function positiveScopeTerm(text: string): boolean {
  return splitQueryTerms(text).some((t) => !NEG_HEAD.test(t) && placeFunction(t.replace(/^[(\s!<]*/, "")));
}

/** The terms that apply to the WHOLE result, with this group and the join it sits in cut out - the text a
 *  scope may bound the group with. `|` joins ONLY the two atoms it touches (rounds 46, 53), so a scope
 *  glued to the group's join bounds nothing, while a scope outside that join applies to everything and does
 *  (measured 2026-11-05: ancestor:"…answertrim" | <plain | *.bin> answered 4,672 = 405 + 4,268 - 1 and
 *  <ancestor:"…answertrim" | *.bin> | <ancestor:"…answertrim" | *.bin> answered 4,250 - no bound - where
 *  ancestor:"…answertrim" ext:bin | <plain | *.bin> answered 1 and ancestor:"…answertrim" <plain | *.bin>
 *  answered 1, because there the folder term sits outside the join). Returns the whole query with the
 *  group's own text cut when the group is not one whole atom (a bang or a prefix glued to it): the safe
 *  answer there is to keep the older, wider suppression. */
function boundingTermsOutsideJoin(query: string, group: { text: string; start: number; end: number }): string {
  const { atoms, pipes } = queryAtoms(query);
  const gi = atoms.indexOf(group.text);
  if (gi === -1) return `${query.slice(0, group.start)} ${query.slice(group.end)}`;
  const exempt = new Set<number>([gi]);
  if (pipes.includes(gi)) exempt.add(gi + 1);
  if (pipes.includes(gi - 1)) exempt.add(gi - 1);
  return atoms.filter((_, k) => !exempt.has(k)).join(" ");
}

/** The first group with two or more FILLED alternatives, one of which carries no POSITIVE scoping term,
 *  and with no positive scoping term outside the group either; null otherwise. A group whose alternatives
 *  are ALL unscoped is reported too: the claim is about what limits the alternative, never about the width
 *  of the answer. A term headed by `!` is an EXCLUSION, so it counts as unscoped both inside the group and
 *  outside it (measured 2026-11-05: <ancestor:"…zeroes" | !ancestor:"…answertrim"> answered 3,777,698 and
 *  !ancestor:"…answertrim" <plain | *.bin> answered 4,267, where the positive forms
 *  <ancestor:"…answertrim" | ancestor:"…zeroes"> answer 408 and ancestor:"…answertrim" <plain | *.bin> 1). */
function unscopedGroupBranch(
  query: string,
  patternIndex = -1,
): { branch: string; group: string } | null {
  for (const g of groupsIn(query, patternIndex)) {
    const branches = groupBranchTexts(g.body);
    if (branches.length < 2) continue;
    if (branches.some((b) => b.trim() === "")) continue;
    const bad = branches.find((b) => !positiveScopeTerm(b));
    if (bad === undefined) continue;
    // A positive scope that applies to the whole result bounds every alternative, so the note stands down.
    // A negated one removes rows from the whole index and bounds nothing; so does a term that sits inside
    // the group's own `|` join, because `|` joins only the two terms it touches.
    if (positiveScopeTerm(boundingTermsOutsideJoin(query, g))) continue;
    return { branch: bad.trim(), group: g.text };
  }
  return null;
}

/**
 * The note for an empty group alternative. The claim is about the GROUP, never about the answer being
 * index-wide: whether the ANSWER came back index-wide depends on the terms outside the group, exactly as in
 * orScopeNote's leak note (measured 2026-11-04: `ancestor:"…zeroes" <a.dat |>` answered 3 = every file in that
 * folder, where the same group with no term outside - `<ancestor:"…answertrim" |>` - answered the whole index).
 */
function groupBranchNote(query: string, patternIndex = -1): string {
  const grp = emptyGroupBranch(query, patternIndex);
  if (grp === null) return "";
  return `\n[everything_search: the group ${boundedEcho(grp)} has an alternative with NOTHING in it, and an empty ` +
    `alternative matches EVERY file on the index: the group limited nothing at all, and only the terms ` +
    `OUTSIDE it held this answer down (measured 2026-11-04: <>, <ancestor:"…answertrim" |>, ` +
    `<ancestor:"…answertrim" | >, <ancestor:"…answertrim"|> and <ancestor:"…answertrim"||*.bin> each answered ` +
    `3,777,996 rows - the whole index - where <ancestor:"…answertrim"> answers 405; and with a term outside, ` +
    `that term decides instead: ancestor:"…zeroes" <a.dat |> answered 3 rows, every file in the folder, where ` +
    `ancestor:"…zeroes" <a.dat> answers 1, and ancestor:"…answertrim" <*.bin |> answered 405 where ` +
    `ancestor:"…answertrim" <*.bin> answers 1. Everything closes an unclosed "<" at the end of the query, so ` +
    `<ancestor:"…answertrim" | answered the same whole index. Add the alternative the "|" was supposed to ` +
    `separate, or delete the "|". (A "<" glued to a function - ext:<bin |> - is a function argument, not a ` +
    `name group, and answers 0 there.)]`;
}

/** The note for a group alternative that nothing scopes. Same shape as orScopeNote's leak note, one level
 *  down: inside a group the alternatives are independent, so the scope sitting in a SIBLING alternative
 *  limits only that alternative. */
function unscopedBranchNote(query: string, patternIndex = -1): string {
  const hit = unscopedGroupBranch(query, patternIndex);
  if (hit === null) return "";
  return `\n[everything_search: in the group ${boundedEcho(hit.group)} the alternative ${boundedEcho(hit.branch)} carries no scoping ` +
    `term that LIMITS a search (ancestor:, parent:, or a path: value that IS a path), so NOTHING limits where ` +
    `that alternative may match: this answer is the UNION of the group's alternatives, not the scope narrowed ` +
    `by each of them. The alternative can still add nothing - <ancestor:"…answertrim" | zzz:dat> answered 405, ` +
    `the folder alone, because an unknown "zzz:" is plain text to Everything and matches no name - but the ` +
    `grammar never bounded it either (measured 2026-11-05: <ancestor:"…answertrim" | *.bin> answered 4,250 = 405 + 3,846 - 1 ` +
    `(one .bin file sits in that folder, and the "- 1" is that shared row) and ` +
    `<ancestor:"…answertrim" | ext:bin> answered 3,941 = 405 + 3,537 - 1, where ancestor:"…answertrim" <*.bin> ` +
    `answers 1 and <*.bin> alone answers 3,846. A leading "!" is an EXCLUSION, not a limit: it removes rows ` +
    `from the whole index instead of bounding one alternative, so it neither counts as scoped here nor excuses ` +
    `the group when it sits outside - <!plain | *.bin> answered 3,777,598, ` +
    `<ancestor:"…answertrim" | !*.bin> 3,774,179, <ancestor:"…zeroes" | !ancestor:"…answertrim"> 3,777,698, ` +
    `and !ancestor:"…answertrim" <plain | *.bin> answered 4,267 where the same group with a POSITIVE scope ` +
    `outside answers 1. NAME-valued functions bound no place - childname: and its ALIAS child:, folder:, ` +
    `name:, parent-name:, stem:, file: - and a bare path: token does not either, because path: is a ` +
    `substring test on the whole path: <ancestor:"…answertrim" | childname:dat> answered 32,272 and ` +
    `child:dat the same, <ancestor:"…answertrim" | folder:dat> 12,735, ` +
    `<ancestor:"…answertrim" | stem:dat> 80,704 and <ancestor:"…answertrim" | path:dat> 1,995,993, where ` +
    `<ancestor:"…answertrim" | path:"C:/tmp/esq-e2e-fixtures"> answers exactly what ` +
    `path:"C:/tmp/esq-e2e-fixtures" answers on its own, because that substring set already holds the ` +
    `folder - the group's other alternative added nothing and bounded nothing. No note when a POSITIVE ` +
    `scoping term is ANDed with the group, because there the group does what ` +
    `it looks like: ancestor:"…answertrim" <plain | *.bin> answers 1 and ancestor:"…answertrim" <!plain | ` +
    `*.bin> answers 405. A scope that a "|" joins straight to the group is NOT a limit on it, because the ` +
    `pipe joins only the two terms it touches, so the note still fires: ancestor:"…answertrim" | ` +
    `<plain | *.bin> answered 4,672 = 405 + 4,268 - 1 and <ancestor:"…answertrim" | *.bin> | ` +
    `<ancestor:"…answertrim" | *.bin> answered 4,250. A scope OUTSIDE that join IS a limit: ` +
    `ancestor:"…answertrim" ext:bin | <plain | *.bin> answers 1 and gets no note. To limit every ` +
    `alternative, put the scope where Everything ANDs it to the group - outside the group and outside the ` +
    `join: ` +
    `ancestor:"…answertrim" <plain | *.bin>. (A "<" glued to a function is its argument, and there an empty ` +
    `alternative matches NOTHING: ext:<bin |> answers 0.)]`;
}
/** The first top-level `|` whose two joined terms carry a scope term on one side only; null if none.
 * `patternIndex` is the atom index a regex query hands the engine as its pattern - 0, because es.exe's
 * `-regex` consumes ONE term and the tool puts that term first. A top-level pipe touching that atom is
 * regex alternation, not Everything's OR, so that pair is exempt; a pipe among the OTHER atoms is not:
 * measured 2026-11-04, `-regex "." -- ancestor:"…answertrim" | *.js` answered 310,464 rows, the same query
 * with no regex at all, so the leak - and this note - are live there. The exemption is by atom INDEX, not
 * by text: `ancestor:"X" ancestor:"X" | *.js` under regex keeps the leak on the second copy, and comparing
 * the joined atom against the pattern's string muted the note (measured through execute(), 2026-11-04). */
function orLeakPair(query: string, patternIndex = -1): { left: string; right: string } | null {
  const { atoms, pipes } = queryAtoms(query);
  // How many pipes live inside the pattern term's own text: those are regex alternation. Everything else is
  // Everything's OR. (splitQueryTerms, not atoms, because the pattern slot is the first WHITESPACE term.)
  const patPipes =
    patternIndex === 0 ? ((splitQueryTerms(query)[0] ?? "").match(/\|/g) ?? []).length : 0;
  for (const p of pipes) {
    const left = atoms[p];
    const right = atoms[p + 1];
    if (left == null || right == null) continue;
    // Only pipes inside the pattern term's OWN text are regex alternation. Exempting by atom index
    // over-fired: the tool puts the first term in the pattern slot whatever it is, and a pipe typed after a
    // scope-shaped first term is a real Everything OR (measured 2026-11-04 through execute(): regex:true with
    // ancestor:"…answertrim" | *.js answered 310,464 rows - the unscaled `.js` side - and said nothing, because
    // that pipe sat at atom index 0, which the index rule called "the pattern's index").
    if (p < patPipes) continue;
    if (joinSideScoped(left) !== joinSideScoped(right)) return { left, right };
  }
  return null;
}

/**
 * es.exe parses a query term that begins with `!` as its NOT operator. Typing the name of a file that
 * really is called `!important.txt` therefore answers the OTHER files in scope and silently omits the
 * one it names: measured 2026-11-04 over a 4-file folder, `!important.txt` returned 3 rows and the named
 * file was not among them, and unscoped the same query answered 3,777,361 matches. Quoting is the remedy
 * and this tool carries double quotes through to Everything (`"!important.txt"` = that one file), so the
 * note states the inversion and the spelling. A quoted term never triggers it - that already IS the
 * literal reading - and an intentional exclusion such as `!path:node_modules` sees the first sentence,
 * which is equally true of it.
 */
function notOperatorNote(terms: string[], query = "", patternIndex = -1): string {
  const bangIdx = terms.findIndex((t) => t.startsWith("!") && t.length > 1);
  if (bangIdx < 0) return "";
  const bang = terms[bangIdx];
  // Round 59 F-59-1: an orphan "|" deletes the term beside its empty side, and when that term IS the bang the
  // exclusion never runs. Every branch below promises an exclusion (or a pattern negation), so this check goes
  // first, once. Measured 2026-11-04: `| !plain ancestor:"…paren49"` answered 4 rows - the same 4 as that query
  // with no `!plain`, where `!plain ancestor:"…paren49"` answers 2 - and the SAME answer also carried the orphan
  // note saying `!plain` "dropped out of the query". The parenthesised branch lies the same way:
  // `| !(plain) ancestor:"…paren49" | *.bin` answered 3,850 where the same query with no leading pipe answers
  // 3,849, and that folder does hold a file named `(plain).txt`. Compared by whitespace term, not by atom, so a
  // dropped `!a|b` is caught for its first atom too.
  const orph = orphanPipeReport(query, patternIndex);
  const bangWasDropped =
    orph != null && orph.dropped.some((d) => d === bang || d.split("|")[0] === bang);
  if (bangWasDropped) {
    return `\n[everything_search: ${boundedEcho(bang)} stood beside the empty side of a "|", so es.exe deleted it from the ` +
      `query BEFORE it could exclude anything: this answer applies NO exclusion for ${boundedEcho(bang.slice(1))} and the ` +
      `names it would have removed are still in it (measured 2026-11-04: "| !plain ancestor:"…paren49"" answered ` +
      `4 rows, the same 4 as that query with no !plain, where !plain ancestor:"…paren49" answers 2). Delete the ` +
      `"|" (or add the alternative it was missing) and the exclusion will apply.]`;
  }
  // Under `regex: true` the tool sends the FIRST term as es.exe's -regex pattern, so a bang standing there is
  // a regex pattern with a leading `!` and its parentheses are a GROUP, not text: measured 2026-11-04 in a
  // 4-file folder, `-regex !(plain) -- ancestor:"…paren49"` kept 2 rows and dropped BOTH plain.txt and
  // (plain).txt. A bang in any later position keeps literal grammar even in a regex query
  // (`-regex plain -- ancestor:"…paren49" !(plain)` answered 1 row - the pattern matched both plain names and
  // the bang then dropped only the one literally containing `(plain)`). When the FIRST term is a bang too the
  // pattern branch below returns first, so its `later` clause carries the later-term explanation; the literal
  // branch stays live only when the pattern itself is not bang-shaped. `patternIndex` is 0 under regex, -1 otherwise: the same convention orScopeNote uses, and the
  // round-50 gate on `regexUsed` alone was too broad - it silenced the literal explanation for the later-term
  // shape, where it is the true one. Round 59 F-59-2: the test is against the FIRST WHITESPACE TERM, which is
  // what `termArgs` hands to -regex, not against `terms[0]` (a grammar atom), and it is prefix-matched because
  // `queryAtoms` splits a pattern's own alternation into atoms. Measured 2026-11-04 through execute(): the
  // regex query `| !pl.in | open ancestor:"…paren49"` answered 4 rows - es.exe got the lone `|` as the pattern
  // and `!pl.in` as a later LITERAL term (mirrored argv `-regex | -- !pl.in | open …` = 4, where
  // `-regex !pl.in -- | open …` = 2) - while the atom test told the caller their literal exclusion was a regex
  // pattern negation and named a pattern (`|`) that carries no `!` at all. `!a|b` still matches, because its
  // first atom `!a` is the part of the pattern term up to its first `|`.
  const argvPattern = splitQueryTerms(query)[0] ?? "";
  const isPattern =
    patternIndex === 0 && argvPattern.startsWith("!") && argvPattern.split("|")[0] === bang;
  // A bang whose target contains parentheses excludes the LITERAL text inside them: Everything has no
  // grouping operator, `(` and `)` are ordinary name characters (round 49, measured on a folder holding a
  // file named `(plain).txt`: the term `(plain)` matched exactly that file, `plain` matched 2 and
  // `((plain))` matched 0). So `!(plain)` is a real exclusion only where a name holds the parentheses -
  // measured in a 4-file folder with no such name it kept all 4 rows where `!plain` kept 3. The generic
  // note below cannot tell those two situations apart, so this branch states the literal rule and the
  // check that decides which case the caller is in.
  if (!isPattern && parenAtom(bang)) {
    return `\n[everything_search: ${bang} excludes every file whose name literally contains the text ` +
      `${bang.slice(1)} - the parentheses are ordinary name characters, Everything has no grouping operator, ` +
      `and the test is a substring test at any position in the name. Where no name holds that text the ` +
      `exclusion removes nothing and the rows you meant to drop stay (measured 2026-11-04: ` +
      `ancestor:"…dash48" !(plain) kept all 4 rows of that folder, where ancestor:"…dash48" !plain kept 3; in ` +
      `a folder that does hold a file named (plain).txt the same query is a working exclusion, 4 rows of 5). ` +
      `Keep the parentheses if you meant a literal "(" in a name; otherwise delete them, or quote the whole ` +
      `term ("${bang}") if the name itself starts with "!"` +
      // Round 152 F-7: `queryAtoms` splits this atom at its internal `|`, so the exclusion covers only
      // the left fragment - the right branch is a join side whose matches are kept.
      (bang.includes("|")
        ? ". Note this atom's \"|\": queryAtoms splits it, so the exclusion covers only " +
          (bang.slice(1, bang.indexOf("|")) || "(nothing)") + " - the branch right of the \"|\" is a " +
          "separate search whose matches are KEPT (\"|\" joins only the two terms it touches); " +
          "group with <...> or delete the \"|\" to exclude both" : "") + "`]";
  }
  // `|` joins only the two terms it touches, so a bang term that sits on one side of a top-level `|` does
  // NOT exclude its match from the answer. Measured 2026-11-04 over a 2-file folder: ancestor:"..r46grep"
  // !a.r46rare answered 1 row (a.r46rare excluded); the same query with ` | *.r46rare` answered 2 rows and
  // the "excluded" file was one of them. The pattern atom is exempt for the round-52 reason: under regex its
  // pipe is alternation inside one pattern, not a join of two terms.
  const { atoms, pipes } = queryAtoms(query);
  if (!isPattern && pipes.some((p) => atoms[p] === bang || atoms[p + 1] === bang)) {
    return `\n[everything_search: ${bang} sits on one side of a "|", and "|" joins only the two terms it ` +
      `touches, so every match of the other side is kept and this answer CAN still contain ` +
      `${bang.slice(1)}. Group the alternatives with <...> so ${bang} stands outside the join, or quote the ` +
      `term ("${bang}") if you meant a file name that starts with "!"]`;
  }
  if (isPattern) {
    // Which sentence is TRUE depends on the pattern's own characters: an atom with no parentheses must not be
    // told "the parentheses are a regex GROUP" (that is what this said through round 55 for `!a` and `!a|open`).
    // Measured 2026-11-04 in the 4-file paren49 folder (`(plain).txt`, `plain.txt`, `open(.txt`, `close).txt`):
    // `-regex "!plain"` kept 2 - the two names with no "plain" text - so the ! negates INSIDE the pattern; and
    // `-regex "!plain|open"` kept 1 (`close).txt`, the only name holding neither text) where `!plain` alone kept
    // 2 and `open` alone kept 1, so the ! covers the WHOLE pattern, alternation included, not just the branch
    // on its right. `-regex "!(plain)|open"` also kept 1, so the parentheses change nothing about that binding.
    // Test and name the PATTERN TERM, not the atom: `queryAtoms` splits an internal `|`, so the atom of
    // `!a|open` is `!a` while the string es.exe actually receives as `-regex` is `!a|open` (measured 2026-11-04:
    // naming the atom left the alternation sentence out and told the caller their pattern was two characters
    // shorter than it is - the same reason `patPipes` in orScopeNote counts the whitespace term).
    const patternTerm = splitQueryTerms(query)[0] ?? bang;
    const patParen = /[()]/.test(patternTerm);
    const patPipe = patternTerm.includes("|");
    // A SECOND bang further along the query is a separate argv term, not pattern text: the tool sends only the
    // first WHITESPACE term to -regex, so a later `!x` keeps literal grammar. Through round 56 this branch
    // returned after the pattern sentence and the later exclusion was never mentioned (measured 2026-11-04 in
    // the 4-file paren49 folder: `-regex !plain -- ancestor:"…paren49"` kept 2 rows, and adding the later term
    // `!open` to the same query kept 1 - a real exclusion the caller was told nothing about). Atoms past the
    // pattern are counted, not searched for by text: `queryAtoms` splits the PATTERN at its own internal pipes,
    // so `!a|!b` must not report its second branch as a later term.
    const patAtomCount = 1 + ((splitQueryTerms(query)[0] ?? "").match(/\|/g) ?? []).length;
    const laterIdx = terms.findIndex((t, i) => i >= patAtomCount && t.startsWith("!") && t.length > 1);
    const later = laterIdx >= 0 ? terms[laterIdx] : null;
    const laterInJoin =
      later != null && pipes.some((p) => atoms[p] === later || atoms[p + 1] === later);
    return `\n[everything_search: ${patternTerm} is the FIRST term of a regex query, so it is sent to es.exe as the ` +
      `-regex pattern with a leading !: the ! is Everything's NOT even inside the pattern, so it drops every ` +
      `name the pattern matches, at any position in the name` +
      (patParen
        ? ` - and the parentheses are a regex GROUP, not text (measured 2026-11-04 in a 4-file folder: the ` +
          `pattern !(plain) kept 2 rows and dropped both plain.txt and (plain).txt, where the same term written ` +
          `as a later, literal term dropped only (plain).txt and kept 3)`
        : ` (measured 2026-11-04 in a 4-file folder: the pattern !plain kept the 2 rows whose names hold no ` +
          `"plain" text)`)
      +
      (patPipe
        ? `; and the ! is NOT limited to the branch on its right - it covers the whole alternation, so a "|" ` +
          `here rescues nothing: -regex "!plain|open" kept 1 row of 4 - the one name holding neither text - ` +
          `where !plain alone kept 2 and open alone kept 1`
        : "") +
      `. Put the pattern first without the !, or move the exclusion after it, if you meant Everything's NOT ` +
      `operator on literal text.` +
      (later == null
        ? ""
        : laterInJoin
          ? ` Separate from the pattern, ${later} is a LATER term - only the first term is sent to -regex, so ` +
            `this one is literal text and not part of the pattern. It also sits on one side of a "|", and "|" ` +
            `joins only the two terms it touches, so check the count before treating ${later} as an exclusion.`
          : ` Separate from the pattern, ${later} is a LATER term - only the first term is sent to -regex, so ` +
            `this one is literal text and not part of the pattern: it is Everything's NOT and removes every ` +
            `name containing ${later.slice(1)} from the pattern's matches (measured 2026-11-04 in the same ` +
            `4-file folder: the pattern !plain kept 2 rows and the same query with !open added kept 1). Where ` +
            `no name holds that text the exclusion removes nothing.`) +
      `]`;
  }
  return `\n[everything_search: ${bang} is Everything's NOT operator: this answer EXCLUDES every match of ` +
    `${bang.slice(1)}, and a match means the text appears ANYWHERE in the name - or, for a function-shaped ` +
    `target like path:/ancestor:, anywhere in the FULL PATH - not just at the front ` +
    `(measured 2026-11-04: in a 4-file folder !plain dropped plain.txt AND (plain).txt, 2 rows kept). To ` +
    `search for such a name literally, quote the term: "${bang}"]`;
}

/**
 * The notes that qualify a `count_only` answer, shared by the readable-count branch and the
 * unreadable-count branch (round 54 F-54-5: the unreadable branch carried none at all, so a caller who could
 * not read the number also lost the fact that the number would have been an exclusion count or a
 * half-scoped union). `n === 0` adds the three hints that explain a ZERO (a regex pattern that may not have
 * parsed, the UNC/device-path root note, literal parentheses); `n === null` means the count never answered
 * readably, which is explicitly not a zero, so those stay out - as does the strict-match switch note, which
 * speaks only about a zero - and only the grammar notes fire. Exported so
 * the suite can pin both shapes: nothing on this box reaches the unreadable branch end-to-end, because
 * es.exe always answers a number to -get-result-count here.
 */
export function countGrammarNotes(
  params: { regex?: boolean; caseSensitive?: boolean; diacritics?: boolean; wholeWord?: boolean },
  query: string,
  n: number | null,
): string {
  const patternIndex = regexRequested(params, query) ? 0 : -1;
  // Round 120: A COUNT ANSWER has no truncateHead and no budget of its own, so these caps are the only
  // thing between a caller's text and the ceiling this tool STATES in its own description ("output capped at
  // 15KB"). Measured before the caps: `…mod93 !<20,000-byte term>` with count_only:true answered 41 rows in an
  // answer of 62,473 bytes because the NOT-operator note quoted the caller's whole 60,353-byte term, and
  // three long notes together answered in 58,440 bytes. Each note is capped; the SET is capped.
  const notes =
    // Grammar atoms, not argv tokens (round 55 F-55-2): a <...> group is ONE atom here, so a bang inside a
    // group is not reported as a top-level `!(...)` term carrying the group's closing `>`.
    capAnswerNote(notOperatorNote(queryAtoms(query).atoms, query, patternIndex)) +
    capAnswerNote(orScopeNote(query, patternIndex)) +
    capAnswerNote(groupBranchNote(query, patternIndex)) +
    (groupBranchNote(query, patternIndex) === ""
      ? capAnswerNote(unscopedBranchNote(query, patternIndex))
      : "");
  if (n !== 0) return capNotesTotal(notes);
  const patIdx = regexPatternTermIndex(params, query);
  return capNotesTotal(
    notes +
    // Round 191 F-191-3: a zero drawn with a strict-matching switch set names that switch on the LIST shape
    // since round 160 (F-160-2); the count shape never did, so the identical call with count_only lost the
    // one explanation that blames the caller's own parameter (`ancestor:"C:\TMP\ESQ82-FIX"` with
    // case_sensitive answered a bare `0 matching:`). Same flags, same whole_word gate the list caller uses.
    capAnswerNote(strictMatchZeroNote(
      [params.caseSensitive ? "case_sensitive" : "", params.diacritics ? "diacritics" : "",
        params.wholeWord && !regexRequested(params, query) ? "whole_word" : ""].filter((f) => f !== ""),
    )) +
    capAnswerNote(regexZeroNote(regexRequested(params, query),
      Math.max(0, splitQueryTerms(query).length - 1 - Math.max(0, patIdx)), patIdx)) +
    capAnswerNote(backslashRootNote(query)) +
    (regexRequested(params, query) ? "" : capAnswerNote(parenZeroNote(query))),
  );
}

/**
 * The orphan-`|` drops, computed once so every caller tells the same story. es.exe drops the term beside the
 * empty side - the term BEFORE a trailing pipe, the term AFTER a leading one - and a drop can ORPHAN THE NEXT
 * PIPE, which drops another term: `| ancestor:"…answertrim" | *.bin` lost BOTH terms and answered 3,777,897
 * rows (the entire index) where the same query with no leading pipe answers 4,250; and
 * `| ancestor:"…" | *.bin *.js | *.txt` lost TWO and answered 345,373, which is exactly `*.js | *.txt`, because
 * the third pipe still had a term on each side and the cascade stopped there (all measured 2026-11-04). A pipe
 * with no atom to its left is never pushed into `pipes`, so a leading orphan is detected from the query text
 * and re-added to the sequence walked here. Returns null when no pipe is orphaned - which is different from an
 * orphan that deleted nothing: a lone `|` deletes no term and still answers the entire index.
 */
export function orphanPipeReport(
  query: string,
  patternIndex = -1,
): {
  dropped: string[];
  dropPhrase: string;
  laterDrops: string;
  survivors: string[];
  rest: string;
  liveJoin: boolean;
  leading: boolean;
  lonePipe: boolean;
} | null {
  const { atoms, pipes } = queryAtoms(query);
  // How many pipes live INSIDE the pattern term's own text: under `regex: true` the tool sends the first
  // WHITESPACE term to es.exe as the pattern, so the pipes inside that string are regex alternation and are
  // exempt, while a pipe after it is a separate argv term and a real Everything OR (measured 2026-11-04:
  // `*.js |` with regex:true answered 3,777,826 rows - the whole index - silently, because an exemption by
  // atom index treated that trailing pipe as part of the pattern).
  const patPipes =
    patternIndex === 0 ? ((splitQueryTerms(query)[0] ?? "").match(/\|/g) ?? []).length : 0;
  const leading = patPipes === 0 && /^\s*\|/.test(query) && atoms.length > 0;
  const lonePipe = /^\s*\|\s*$/.test(query);
  const hasTrailing = pipes.some((p) => atoms[p] != null && atoms[p + 1] == null && p >= patPipes);
  if (!leading && !lonePipe && !hasTrailing) return null;
  const seq: Array<{ term?: string; pipe?: boolean; inert?: boolean }> = [];
  if (leading) seq.push({ pipe: true });
  atoms.forEach((a, i) => {
    seq.push({ term: a });
    if (i >= patPipes && pipes.includes(i)) seq.push({ pipe: true });
  });
  // Leftmost orphaned pipe first, repeatedly. That order is also CAUSAL order: `dropped[0]` is the term beside
  // the pipe the caller can SEE, and `dropped.slice(1)` are the ones a later orphan took.
  const dropped: string[] = [];
  for (let pass = 0; pass <= seq.length; pass++) {
    let moved = false;
    for (let i = 0; i < seq.length; i++) {
      const e = seq[i];
      if (!e.pipe || e.inert) continue;
      const hasL = i > 0 && seq[i - 1].term != null;
      const hasR = i + 1 < seq.length && seq[i + 1].term != null;
      if (hasL && hasR) continue;
      if (!hasL && !hasR) {
        e.inert = true;
        continue;
      }
      const vi = hasL ? i - 1 : i + 1;
      dropped.push(seq[vi].term!);
      seq[vi] = {};
      e.inert = true;
      moved = true;
    }
    if (!moved) break;
  }
  const survivors = seq.filter((e) => e.term != null).map((e) => e.term!);
  // Render what actually runs WITH ITS OWN SEPARATORS: two survivors still joined by a live pipe are a union,
  // and joining them with a space would describe an AND (measured 2026-11-04: `| ancestor:"…answertrim" *.js
  // | *.bin` answered 314,309 - the same as `*.js | *.bin` - while an AND of the two names matches nothing).
  // A `<...>` group renders as its own single term, because queryAtoms never pushes a pipe inside a group.
  const parts: string[] = [];
  let liveJoin = false;
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i];
    if (e.term != null) {
      parts.push(e.term);
    } else if (e.pipe && !e.inert) {
      parts.push("|");
      if (i > 0 && seq[i - 1].term != null && i + 1 < seq.length && seq[i + 1].term != null) {
        liveJoin = true;
      }
    }
  }
  return {
    dropped,
    dropPhrase: nameList(dropped),
    laterDrops: nameList(dropped.slice(1)),
    survivors,
    rest: parts.join(" "),
    liveJoin,
    leading,
    lonePipe,
  };
}

/** `a`, `b` and `c`. A term typed twice is named once as `a (both copies)`: naming it twice reads as two
 * different deletions (shape: `| ancestor:"…answertrim" | ancestor:"…" | *.bin`). */
function nameList(names: string[]): string {
  const seen = new Map<string, number>();
  for (const nm of names) seen.set(nm, (seen.get(nm) ?? 0) + 1);
  const parts = [...seen.entries()].map(([nm, k]) =>
    k === 2 ? `${nm} (both copies)` : k > 2 ? `${nm} (${k} copies)` : nm,
  );
  if (parts.length === 0) return "the term beside the empty side";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} and ${parts[parts.length - 1]}`;
}

/**
 * The same drop fact for everything_grep's refusals, which are about FILES. Returns "" when nothing was
 * deleted, so a refusal that has nothing to do with an orphan `|` keeps its own wording.
 */
export function orphanDropSentence(query: string): string {
  const rep = orphanPipeReport(query);
  if (!rep || rep.dropped.length === 0) return "";
  return (
    `this query has a "|" with nothing on one side of it, so es.exe deleted ${rep.dropPhrase} before it ` +
    (rep.survivors.length === 0
      ? `selected anything - that left NO search term at all, so the file set is the ENTIRE INDEX.`
      : `selected any files - the query that actually ran was ${rep.rest}.`)
  );
}

// Round 106 F-106-2: the candidate-cap refusal named the same four narrowing functions whatever the caller had
// already typed, so a query carrying two of them was told to add them again (measured 2026-11-05:
// `ext:txt size:>1kb` matched 12,933 files and the body said "Narrow the query (ext:, ancestor:, size:,
// !path:)"; case 51's own query carries `ext:` AND `ancestor:`, and the System32 refusal's query carries
// `ancestor:`). The advice now lists only the functions the query does not already apply; when it applies all
// four, the body says which value has to get tighter instead. Term-based on purpose: `splitQueryTerms` keeps the
// quotes, so a term that begins `"` is a NAME and never counts as carrying a function.
// Both exported so test/e2e-spaced-path.mjs can pin the advice shapes as CALLED values and derive the four names
// instead of re-typing them: a QUOTED term that spells a function, and a function glued behind a group OPENER, are
// unreachable through a real over-cap refusal (a quoted literal intersects to 0 candidates; the small group tried
// in round 106 answered at 201 files and tripped no cap), so case 152 can only see the five shapes a refusal shows
// and case 154 pins the rest.
export const CAP_NARROWING: Array<{ name: string; prefix: string }> = [
  { name: "ext:", prefix: "ext" },
  { name: "ancestor:", prefix: "ancestor" },
  { name: "size:", prefix: "size" },
  { name: "!path:", prefix: "path" },
];

/** The four narrowing names, in `CAP_NARROWING`'s own order. Every shipped sentence that LISTS them is
 *  built from here (round 179 F-179-07): three arms re-typed the list beside a condition that already read
 *  the constant, so the constant and the prose could drift apart with nothing red. */
function capNarrowingNames(): string[] {
  return CAP_NARROWING.map((f) => f.name);
}

/** The figure a candidate-cap refusal quotes, TOGETHER WITH the label that figure can honestly carry
 *  (round 179 F-179-2). `fileRows` exists only when the folder probe answered; `listTotal` is a ROW count,
 *  which includes the folder rows this cap does not charge, so it may not be called "files". Exported so
 *  the suite can pin all three arms as CALLED VALUES. What stays unreachable live on this box is the MIDDLE
 *  arm, and the surviving invariant for that is only that the `attributes:d` probe has answered every scope
 *  driven (1.2 M rows in 0.2 s, 2026-11-06). The reason written here before - "a scan-only scope dies in the
 *  30 s list fetch long before the cap gate" - was falsified 2026-11-07: `da:2026-11-07` reached the cap gate
 *  and printed a refusal, so `list.total == null` AT THE GATE is live (the F-118-2 branch takes it, and now
 *  prints a floor instead of a page length). Round 195 F-195-01 deletes the next claim this comment made - "a
 *  scan-only scope still never reaches the `else` refusal, because the folder probe beside a `da:` ask answers
 *  too" - the gate is `capBase !== "" && fileRows != null && fileRows <= MAX_CANDIDATE_FILES`, so a scope that
 *  reaches here with `folderRows === 0` takes the `else` with `fileRows` = this answer's page length, which is
 *  why both callers now pass `list.total == null ? null : fileRows`: a page floor is never labelled "files". */
export function capRefusalFigure(fileRows: number | null, listTotal: number | null): string {
  if (fileRows != null) return `${fileRows.toLocaleString("en-US")} files`;
  if (listTotal != null)
    // F-194-6: both callers append `, over the <cap>-file cap.` to whatever this returns, so the explanation
    // is a parenthetical - unparenthesised the assembled sentence read "...so the file count may be lower,
    // over the 2000-file cap.", which is a dangling clause.
    return `${listTotal.toLocaleString("en-US")} rows (the folder count for this query did not answer, and `
      + "folder rows are not charged against this cap, so the file count may be lower)";
  // F-195-05: with neither figure the only evidence is this answer's own fetch, and the arm above refuses to
  // call a row figure a file count - so this one may not claim a file population off 2,001 rows either. It
  // names the ceiling it came from and what it cannot say.
  const fetchCeiling = (MAX_CANDIDATE_FILES + 1).toLocaleString("en-US");
  return `at least ${fetchCeiling} rows (this answer's row fetch stops at that ceiling, so the figure is a `
    + "fetch floor and not a count, no count answered for this query, and a row figure holds folder rows this "
    + "cap does not charge - so no file count exists anywhere in this call)";
}

/** The FOUR narrowing functions `CAP_NARROWING` offers that a query does not already apply, derived
 *  from that constant. Round 124 F-124-1: `esFailureMessage`'s timeout arm used to hard-code "add
 *  parent:, ancestor:, ext:, or size: constraints" whatever the caller had typed, which is the same
 *  defect rounds 105/106 removed from the candidate-cap refusal, and this census is what lets both
 *  sites read ONE list. Term-based, and so a quoted term is a NAME: exactly `narrowTheQueryAdvice`'s
 *  rule, restated in set terms because the two callers word their advice differently. */
function missingNarrowingNames(query: string): string[] {
  const carried = new Set<string>();
  for (const raw of splitQueryTerms(query)) {
    const term = raw.replace(/^[(!<\s]+/, "");
    if (!term || term.startsWith("\"")) continue;
    // Round 152 F-12: a POSITIVE `path:` is not the `!path:` narrowing this list offers - credit it
    // only when the term is actually negated, or the refusal claims every narrowing is applied when
    // an exclusion is still on the table.
    const neg = /^[(!<\s]*!/.test(raw);
    const head = term.slice(0, term.indexOf(":") + 1).toLowerCase();
    for (const f of CAP_NARROWING)
      if (head === `${f.prefix}:` && (f.name !== "!path:" || neg)) carried.add(f.name);
  }
  return CAP_NARROWING.map((f) => f.name).filter((n) => !carried.has(n));
}

export function narrowTheQueryAdvice(query: string): string {
  const carried = new Set<string>();
  for (const raw of splitQueryTerms(query)) {
    const term = raw.replace(/^[(!<\s]+/, "");
    if (!term || term.startsWith("\"")) continue;
    const neg = /^[(!<\s]*!/.test(raw); // round 152 F-12: positive `path:` is not `!path:`
    const head = term.slice(0, term.indexOf(":") + 1).toLowerCase();
    for (const f of CAP_NARROWING)
      if (head === `${f.prefix}:` && (f.name !== "!path:" || neg)) carried.add(f.name);
  }
  const missing = CAP_NARROWING.map((f) => f.name).filter((n) => !carried.has(n));
  if (missing.length === CAP_NARROWING.length) {
    return `Narrow the query (${capNarrowingNames().join(", ")}).`;
  }
  if (missing.length > 0) {
    return `Narrow the query further (${missing.join(", ")} - the query does not use them yet).`;
  }
  return (
    "The query already applies every narrowing this list offers - tighten a value it already has: a deeper "
    + "ancestor:, a narrower ext:, or a larger size: bound."
  );
}

/**
 * The `|` hazard, stated correctly as of round 46: `|` binds TIGHTER than the implicit AND, so it joins one
 * term to one term and every other term applies to the whole result. Measured 2026-11-04 over a 405-file
 * folder (404 `.js`, 1 `.bin`) with the components `ancestor:"…answertrim"` = 405, `*.js` = 310,463,
 * `ancestor:"…answertrim" *.js` = 404:
 *
 * - `ancestor:"…" | *.js` = 310,463 - the scope is one side of the join, so the other side ran unscaled.
 * - `ancestor:"…" *.js | *.bin` = 405 and `*.js | *.bin ancestor:"…"` = 405 - the scope sits OUTSIDE the
 *   join and limits both sides, which is why the note must NOT fire on those shapes (it did through 45).
 * - `*.txt | ancestor:"…" !b.js` = 34,849 - the join's left side is unscoped even though the scope term is
 *   in the same query.
 * - `ancestor:"…" <*.bin> | *.js` = 405 - a `<...>` group is one term on its side of the join.
 * - `ancestor:"…" *.js |` = 405, not 404 - the join degenerates and the term before the empty side is
 *   dropped, so the answer is the scoped set with a term silently deleted (round 45 had this backwards and
 *   said the SCOPE was what disappeared).
 *
 * Do NOT wrap alternatives in parentheses: they are literal name characters, not a group, so `<(A | B)>`
 * asks for names holding "(A" or "B)" and answers 0 on a corpus without them where `<A | B>` answers
 * 39,295. A `|` inside a `<...>` group, inside
 * double quotes, or escaped is not top-level and cannot fire either branch. Same family as
 * notOperatorNote: the answer is not empty, it is wider (or narrower) than the query that was typed.
 */
// Exported ONLY so the suite can pin the LONE-`|` sentence (the csvLineToTabs precedent at case 26);
// a lone pipe answers the entire index, and no live query needs to prove a note's wording.
export function orScopeNote(query: string, patternIndex = -1): string {
  const { atoms, pipes } = queryAtoms(query);
  // The orphan drops run FIRST and decide which join to talk about: a join whose terms were deleted is not
  // this query's join any more. Asking orLeakPair about the ORIGINAL text made the note explain `|` for a term
  // es.exe had already removed - `| ancestor:"…answertrim" | *.bin` was told "so *.bin is not limited by the
  // term it is joined to" for a query whose effective search was EMPTY, and
  // `| ancestor:"…answertrim" | *.bin *.js` got the same sentence about `*.bin` while its answer (310,463) was
  // every `.js` on the index (measured 2026-11-04). After a drop the leak pair is recomputed from what survives;
  // with no live join left, the orphan branches below describe the survivors instead.
  const orphan = orphanPipeReport(query, patternIndex);
  const dropped: string[] = orphan?.dropped ?? [];
  const survivors: string[] = orphan?.survivors ?? [];
  const rest = orphan?.rest ?? "";
  const leading = orphan?.leading ?? false;
  const lonePipe = orphan?.lonePipe ?? false;
  const leak = orLeakPair(
    dropped.length > 0 ? rest : query,
    dropped.length > 0 ? -1 : patternIndex,
  );
  if (leak) {
    const scopedSide = joinSideScoped(leak.left) ? leak.left : leak.right;
    const unscoped = joinSideScoped(leak.left) ? leak.right : leak.left;
    // A parenthesised scope atom contributes NOTHING to the query, so the answer is not merely unscoped on
    // one side - the scope is absent from the whole result. Measured 2026-11-04: (ancestor:"…") = 0 rows
    // against 405 unparenthesised, and (ancestor:"…") | *.bin = 3,846 = the entire index-wide .bin set,
    // where the same query with no parentheses answered 4,250.
    const parenGlued = parenAtom(scopedSide);
    return `\n[everything_search: "|" joins ONLY the two terms it touches and every other term applies to ` +
      `the whole result, so ${boundedEcho(unscoped)} is not limited by the term it is joined to. Nothing inside the join ` +
      `bounds it either; whether the ANSWER comes back index-wide depends on the terms OUTSIDE the join, ` +
      `which do apply to the whole result (measured 2026-11-04: ` +
      `ancestor:"C:\\tmp\\esq-e2e-fixtures\\answertrim" | *.js ` +
      `answered 310,463 rows, while ancestor:"…answertrim" *.js | *.bin - one scope outside the join - ` +
      `answered 405, and a duplicated scope did the same: ancestor:"…answertrim" ancestor:"…answertrim" | ` +
      `*.js = 405), so a small count is not evidence that the join was scoped correctly. Move the ` +
      `scope term out of the join by grouping the alternatives with <...> and NO parentheses: ` +
      `ancestor:"C:\\proj" <*.js | *.bin> = 405. Parentheses are literal name characters here, so <(A | B)> ` +
      `asks for names holding "(A" or "B)" and answers 0 where the same group written without them answers 39,295.` +
      (parenGlued
        ? ` And the scope term in this query is itself wrapped in parentheses, which Everything matches as `
          + `literal name characters, so it scopes nothing at all: (ancestor:"…answertrim") answered 0 rows ` +
          `where the same term on ` +
          `its own answered 405, and (ancestor:"…answertrim") | *.bin answered 3,846 - every .bin file in ` +
          `the index, not the scoped ones. Delete the parentheses; group alternatives with <...> instead.`
        : "") +
      // No measurement of this clause's own: the numbers that used to sit here were measured on a DIFFERENT
      // query than the one being described, and contradicted the example above it in the same note (that note
      // said `ancestor:"…" *.js | *.bin` = 405 while this clause said the same text = 404).
      (dropped.length > 0
        ? ` And this query ALSO has a "|" with nothing on one side of it, so es.exe deleted ` +
          `${boundedEcho(orphan?.dropPhrase ?? "the term beside the empty side")} before the join ran` +
          (dropped.length > 1
            ? " (the first drop left the next pipe with an empty side too, and so on)"
            : "") +
          `. The join that actually ran is ${boundedEcho(rest)}. Delete the "|" or add the term it was missing.`
        : "") +
      `]`;
  }
  if (dropped.length > 0 || lonePipe) {
      // Round 152 F-3: a LONE `|` deletes NOTHING (this function's own doc says so) - the no-survivor
      // sentence must not claim a drop, must not name the placeholder term, and must not imply the
      // query once limited something.
      if (lonePipe && dropped.length === 0) {
        return `\n[everything_search: this query held nothing but the "|" itself, so it had NO search ` +
          `term at all - nothing was deleted, nothing limited this answer, and it answered the ENTIRE ` +
          `INDEX (measured 2026-11-04: an empty query answers 3,777,826; orphan pipes also CASCADE - ` +
          `"| ancestor:"…answertrim" | *.bin" lost BOTH terms and answered 3,777,897 where the same ` +
          `query with no leading pipe answers 4,250). Nothing in this answer is scoped - delete the ` +
          `"|" or add the terms it needs.]`;
    }
    // Round 190 F-3: every caller-term insertion in this function goes through boundedEcho, which is what the
    // MAX_ECHO_BYTES rule and the MAX_NOTE_BYTES comment ("boundedEcho at every insertion site") both claim.
    // These arms used to interpolate the dropped term, the survivor REST and the cascade list RAW, so one
    // oversized term pushed THIS note past MAX_NOTE_BYTES and capAnswerNote cut its TAIL - the measured
    // evidence and the delete-the-pipe advice - which is the F-120-6 failure. Values inside the echo cap come
    // back byte for byte, so cases 91/93/94/184's byte-exact note pins still hold.
    const gone = orphan?.dropPhrase ?? "the term beside the empty side";
    if (survivors.length === 0) {
      return `\n[everything_search: this query has a "|" with nothing on one side of it, so es.exe dropped ` +
        `${boundedEcho(gone)} - and that left NO search term in the query at all, so nothing limited it any more and it ` +
        `answered the ENTIRE INDEX (measured 2026-11-04: ancestor:"…answertrim" | answered 3,777,826 rows ` +
        `where the same query with no pipe answered 405, and a leading "| *.js" answered 3,777,826 where *.js ` +
        `alone answered 310,463; orphan pipes also CASCADE - "| ancestor:"…answertrim" | *.bin" lost BOTH ` +
        `terms and answered 3,777,897 where the same query with no leading pipe answers 4,250; and an empty ` +
        `query answers 3,777,826). Nothing in this answer is scoped - delete the "|" or add the term it was ` +
        `missing.]`;
    }
    if (survivors.some((a) => joinSideScoped(a))) {
      if (leading) {
        return `\n[everything_search: this query STARTS with "|", so ` +
          `${boundedEcho(dropped[0] ?? gone)} has nothing on the pipe's left side and dropped out of the query` +
          (dropped.length > 1
            ? `, which left the next pipe with an empty side too, so ${boundedEcho(orphan?.laterDrops ?? "")} went next`
            : "") +
          ` while the rest ran (${boundedEcho(rest)}). Add the missing alternative or delete the "|"]`;
      }
      // Only the term beside the VISIBLE empty side may be named as the one the trailing pipe took: a second
      // term went because the first drop orphaned another pipe (measured 2026-11-04:
      // `ancestor:"…answertrim" ext:bin | *.js |` = 405, and the pipe at the end sits after `*.js` alone).
      return `\n[everything_search: the "|" after ${boundedEcho(dropped[0] ?? gone)} has nothing after it. "|" joins only ` +
        `two terms, so ${boundedEcho(dropped[0] ?? gone)} dropped out of the query` +
        (dropped.length > 1
          ? `, which left the pipe before it with an empty side too, so ${boundedEcho(orphan?.laterDrops ?? "")} went next`
          : "") +
        ` and only ${boundedEcho(rest)} ran (measured: ancestor:"…answertrim" *.js | answered 405 rows - the whole folder - ` +
        `where ancestor:"…answertrim" *.js answers 404). Add the missing alternative or delete the "|"]`;
    }
    // Something did survive the drop, so this answer is NOT the whole index - it is the surviving terms run
    // WITHOUT the dropped one, which is exactly the case the round-55 wording got wrong: measured 2026-11-04,
    // a leading "| ancestor:"…answertrim" *.js" answered 310,463 rows (every `.js` on the index, because the
    // scope dropped out) where `ancestor:"…answertrim" *.js` answers 404; the mirror image
    // "| *.js ancestor:"…answertrim"" drops `*.js` instead and answers 405.
    return `\n[everything_search: this query has a "|" with nothing on one side of it, so es.exe dropped ` +
      `${boundedEcho(gone)}${dropped.length > 1 ? " - the first drop left the next pipe with an empty side too" : " - the term beside the empty side"} ` +
      `- and the REST of the query ran without ${dropped.length > 1 ? "them" : "it"}. The answer is ` +
      `therefore every match of ${boundedEcho(rest)} across the WHOLE INDEX, not the subset the dropped term` +
      `${dropped.length > 1 ? "s" : ""} would have limited` +
      `${orphan?.liveJoin ? " (that REST is itself a join, so neither side of it limits the other)" : ""}. ` +
      `(measured 2026-11-04: a leading "| ancestor:"…answertrim" *.js" answered 310,463 rows - every .js on ` +
      `the index - where ancestor:"…answertrim" *.js answers 404, and the mirror image "| *.js ` +
      `ancestor:"…answertrim"" dropped *.js and answered 405). Delete the "|" or add the term it was missing.]`;
  }
  // No one-sided scope leak, but a paren-carrying atom on either side of a top-level join usually matches
  // no name at all (the parentheses are literal), so the answer is narrower than the query typed and
  // orLeakPair cannot see it: both joined atoms carry a scope here. Measured 2026-11-04:
  // (ancestor:"…answertrim") | ancestor:"…join46" = 2 rows where the same query unwrapped = 407, and
  // ancestor:"…answertrim" | (ancestor:"…join46") = 405. The wording states the rule and the check rather
  // than asserting this answer's size, because a file name CAN legitimately contain parentheses.
  for (const p of pipes) {
    const wrapped = [atoms[p], atoms[p + 1]].find(
      (a, k) => a != null && p + k !== patternIndex && parenAtom(a));
    if (wrapped != null) {
      return `\n[everything_search: "|" joins ONLY the two terms it touches, and ${wrapped} contains ` +
        `parentheses, which Everything matches as ordinary name characters - there is no grouping ` +
        `operator. If no file name holds that text this side of the join contributed nothing, so the ` +
        `answer is smaller than the query asks for (measured: (ancestor:"…answertrim") | ` +
        `ancestor:"…join46" answered 2 rows where the same query with no parentheses answered 407, the ` +
        `union of folders of 405 and 2; and in a folder holding a file named (plain).txt the term ` +
        `(plain) really does match it). Delete the parentheses unless you meant a literal "(" in a name; ` +
        `group alternatives with <...>]`;
    }
  }
  return "";
}

/**
 * A query that answered nothing AND contains parentheses: on this install `(` and `)` are ordinary LITERAL
 * name characters - Everything has no grouping operator, `<...>` is the only one - so such a term asks for
 * names that literally contain them, which most corpora do not have. Measured 2026-11-04 on a folder built
 * for exactly this: `plain` matched 2 files, `(plain)` matched the one named `(plain).txt`, `((plain))`
 * matched 0; and on corpora without parenthesised names, `ancestor:"…" (aaa-oversized)` answered 0 where
 * matched 0. A backslash does not escape them either: on the same folder \(plain\) answered 0, while the
 * the same pair without parentheses answered 4. Not offered for a regex query, where parentheses are regex
 * groups and carry no Everything meaning. A parenthesis inside a quoted value (a path scope such as
 * "C:\Program Files (x86)") is not search text either - see queryHasSearchParen(). Hedged wording: a zero can also just be an honest
 * empty result, and the caller cannot tell the two apart from the answer alone.
 */
/** Does some term carry a parenthesis in its SEARCH text, as opposed to inside a quoted value? A scope
 * written ancestor:"C:\Program Files (x86)" contains parens that belong to a path the caller picked on
 * purpose, and a zero from that query is honest - they must not trigger the grammar hint (measured
 * 2026-11-04: that scope plus a nonexistent extension answers 0, and 139,721 rows without the extension).
 * An unterminated quote is the same shape from the other side: Everything reads the rest of the term as the
 * quoted value, so this strips it too - otherwise `ancestor:"C:\Program Files (x86)` (no closing quote, a
 * real typo) would trigger the paren hint on an honest zero. */
function queryHasSearchParen(query: string): boolean {
  return splitQueryTerms(query).some((t) => /[()]/.test(t.replace(/"[^"]*"/g, "").replace(/"[^"]*$/, "")));
}

function parenZeroNote(query: string, tool = "everything_search"): string {
  if (!queryHasSearchParen(query)) return "";
  return `\n[${tool}: this answer is empty and the query contains parentheses. Everything has no grouping ` +
    "operator - a paren is an ordinary character matched inside a name - so a term like this one asks for " +
    "names that literally contain them (measured on a folder built for it: plain = 2 files, (plain) = the " +
    "one named (plain).txt, ((plain)) = 0; and `(aaa-oversized | *.bin)` = 0 where the same two atoms " +
    "without parentheses answered 3,854). A backslash is not an escape on this path: \\(plain\\) asks for a " +
    "name containing a backslash and answers nothing, so write a literal parenthesis plainly. If the " +
    "parentheses were not meant to be part of the file name, drop them; to group alternatives use <...> " +
    "instead]";
}

/** ONE text for the scope `everything_grep` INVENTS when the caller omits `query` (round 115 F-115-2). Every
 *  answer shape that carries no caller-chosen scope prints it: the normal answer (both render modes, and an
 *  all-directory candidate set) AND the single-binary early return, which until round 116 F-116-1 disclosed
 *  nothing at all. The zero-candidate early return keeps its own older sentence (round 52 F-52-1) naming the
 *  scope, and now states this same mechanism. Case 164 pins all five shapes and this builder's single
 *  occurrence in the source. Round 117 F-117-1: callers pass the list the candidates ACTUALLY came from
 *  (`candidateList.esQuery`), so a call whose candidate cap was rescued quotes the RESCUED scope - the
 *  same string `details.esQuery` carries (round 94's rule) - and `rescued` names the one term in it that
 *  the caller never typed. */
function defaultScopeNote(esQuery: string, rescued = false): string {
  return `[everything_grep: no query was given, so the candidates came from ${boundedEcho(esQuery)}` +
    // The cap rescue adds `!attributes:d` to the candidate list (round 94 F-94-2); the cap note beside
    // this one counts the rows it dropped, so this clause only says WHOSE term it is.
    (rescued
      ? " (the trailing !attributes:d is this tool's own - the cap note in this answer gives the row " +
        "and file counts)"
      : "") +
    " - Everything's path: function is a SUBSTRING test on the whole path, so every row whose " +
    "path contains node_modules or .git was skipped, .gitignore and .github files " +
    "included. Pass a query to choose the scope.]";
}

/** A zero drawn while a strict-matching switch was set may be that switch's doing, not the index's. The
 *  note fires only when such a flag was actually set, and each measurement it quotes is the fixture's,
 *  re-driven on this box (case_sensitive 2026-11-05, diacritics and whole_word 2026-11-06,
 *  C:\tmp\esq82-fix). whole_word is listed only outside regex mode, where the switch is inert.
 *  Round 160 F-160-2: before this the answer blamed the app and the index for a zero the caller caused. */
function strictMatchZeroNote(flags: string[]): string {
  if (flags.length === 0) return "";
  const proof: string[] = [];
  if (flags.includes("case_sensitive")) {
    proof.push('measured 2026-11-05 at C:\\tmp\\esq82-fix: ancestor:"C:\\TMP\\ESQ82-FIX" answered 7 rows '
      + "with case_sensitive off and 0 rows with it on");
  }
  if (flags.includes("diacritics")) {
    proof.push("measured 2026-11-06 in the same folder: `cafe` answered 2 rows (`cafe.txt` and "
      + "`café.txt`) with diacritics off and 1 row with it on");
  }
  if (flags.includes("whole_word")) {
    proof.push("measured 2026-11-06 in the same folder: `alpha` answered 2 rows (`alpha.txt` and "
      + "`alphax.txt`) with whole_word off and 1 row with it on");
  }
  const one = flags.length === 1;
  return "\n\nNote: this call set " + flags.map((f) => `\`${f}\``).join(" and ") + ", so this zero may be " +
    (one ? "that parameter's doing" : "those parameters' doing") + ", not the index's: a scope or name " +
    "spelled differently from the way the index stores " +
    (one ? "it matches nothing under that parameter" : "them matches nothing under those parameters") +
    " (" + proof.join("; ") + "). Re-run with " + (one ? "it off" : "them off") + ", or spell the target " +
    "the way the index stores it.";
}

export function noResultsText(query: string, regexUsed = false, strictFlags: string[] = [], patternIdx = 0,
  countSkipped: string | null = null, totalUnknown = false): string {
  const rootNote = backslashRootNote(query);
  // Round 160 F-160-1: backslashRootNote exists precisely to retract the "run everything_status" steer
  // for a `\`-rooted scope, so the two must not both print in one answer. The count-zero shape already
  // printed the note alone; the list shape now agrees with it. The parenthetical says what status really
  // prints (newest indexed row + the 24 h warning) rather than a "stale snapshot" this install never takes.
  // Round 191 F-191-7 (the deliberate LIMIT of that rule, welded by case 192): the retraction is NOT extended
  // to the other explained zeros (a strict-match switch, an orphan-pipe drop, a `!` term, an unparsed pattern),
  // because the steer has two halves and only one of them is dead there. "is the app running" IS dead on any
  // zero - a zero means es.exe answered 0 rows, which already proves it answers es.exe at all - but "is the
  // index fresh" stays live on exactly those answers, since a stale index really can hide a file that the
  // caller's own switch also happens to exclude. Retracting the whole line would let a strict-flag zero assert
  // a cause it has not proven, so both print.
  const tips = rootNote === ""
    ? "Tips: check query syntax with everything_syntax. If you expected results, " +
      "run everything_status to check that the Everything app is running and the index is fresh " +
      "(it reports the newest indexed row and warns past 24 h; a file created or renamed after that " +
      "row can be missing). everything_status does not list the volumes this index covers - " +
      "everything_search with root: does, and a path on a volume it does not cover answers 0 forever."
    : "Tips: check query syntax with everything_syntax. The note below names a shape that cannot match " +
      "this index at all, so this answer does not send you to everything_status.";
  // Round 198 axis 2: a zero whose COUNT was skipped is a different claim from a counted zero, and 3 bytes of
  // text was all that told them apart - `orientation:>1 ext:mjs` answered 480 B with total=null where a counted
  // zero answered 477 B (`latitude:47 ext:ttf`) and an indexed-only zero 470 B (C:/tmp/esq198/out198.txt). The
  // header form of this reason exists only on an answer that PRINTS rows, so on a zero page nothing said it.
  // `syntax.md` already warns that a zero on an un-indexed property is NOT proof of absence; now the answer that
  // prints that zero says so too. Keyed so a counted zero's bytes stay untouched.
  // Round 199 F-199-03 widened the KEY, not the sentence: `total` is null on more than the skip route - the count
  // call can be spawned and still not answer (a 15 s timeout, a spawn error, a reply that is not a bare integer,
  // or the `sort` pre-count being reused rather than re-asked), which is the state `buildResultText`'s header
  // already names on an answer that prints rows. A zero page keyed only on the skip was silent for exactly the
  // zeros whose total is least known. The second arm prints only when no term was skipped AND the count did not
  // answer. Round 199 never reached it on a zero page - every zero page its drives met got there through the skip.
  // Round 200 reached it, by a partner sized just INSIDE the count lease so the count IS asked and then overruns
  // its own 15 s leash: `orientation:>1 ext:json` (84,237 entries, and `orientation:` then rode the default 170 us,
  // whose lease is 88,235) answered total=null with countSkippedTerm=null at 15,168 ms and printed this arm, and
  // answered total=0 at 14,346 ms and printed neither. Round 203 gave this column a 600 us count rate, so a partner
  // that size is now SKIPPED instead of asked and that route to the arm is closed by the price - which is what the
  // price is for. The arm stays implemented and welded as an invariant (no total and no skip means this note) rather
  // than as a fixed shape: any column can still overrun at the top of its lease on a cold box.
  const skipNote = countSkipped !== null
    ? `\n\nNote: no total answered here, so 0 rows is NOT proof that nothing matches: \`${countSkipped}\` is a `
      + "value this index answers only by testing every entry, and this call did not count it "
      + "(details.countSkippedTerm names it)."
    : totalUnknown
      ? "\n\nNote: no total answered here, so 0 rows is NOT proof that nothing matches: this call asked the "
        + "count for this query and it did not answer in time, so the page can be empty because the count never "
        + "finished, not because nothing matches."
      : "";
  const base = `No results found for: ${boundedEcho(query)}\n` + tips + skipNote;
  // Round 16 F-16-1, shared with everything_grep since round 17 - see backslashRootNote().
  // The paren hint is skipped for a regex query, where `(` `)` are regex groups and mean nothing to
  // Everything's own grammar - under EITHER spelling. Round 52 F-52-3: this tested the `regex` flag only,
  // so the in-query function still drew the literal-name hint (measured through execute(): `regex:(zzz)`
  // answered with paren=true here while the flag form said nothing).
  // Round 120: a zero-result answer is another unbudgeted answer, and backslashRootNote/parenZeroNote quote
  // the caller's query back - capped here for the same reason as the count answer above.
  return capNotesTotal(
    base +
    capAnswerNote(rootNote) +
    capAnswerNote(strictMatchZeroNote(strictFlags)) +
    capAnswerNote(regexZeroNote(regexUsed,
      Math.max(0, splitQueryTerms(query).length - 1 - Math.max(0, patternIdx)), patternIdx)) +
    (regexUsed || queryAsksRegex(query) ? "" : capAnswerNote(parenZeroNote(query))),
  );
}

// ONE builder for the `count_only` "is not applied to this answer" account. A count answer carries no rows, so
// anything else the caller asked for is absent from it and the answer says so instead of dropping it quietly
// (measured 2026-11-04: details, columns, sort and order each vanished without a word, and details.columns still
// echoed columns that were never fetched). TWO branches can answer a count - the refused-count one and the
// answered one - and each used to carry its own copy of these pushes and its own copy of the sentence; the
// copies were only ever correct by editing both (round 107 read them as a pair to prove they agreed), so there is
// now one side to edit. `list` is what `details.countOnlyIgnored` echoes; `note` is the rendered account ("" when
// nothing was dropped). The six possible entries are the parameters that change nothing about a count; `regex`,
// `case_sensitive`, `whole_word`, `match_path` and `diacritics` are deliberately absent because they change which
// rows the count covers, and `total_size` has its own line.
function countOnlyIgnoredAccount(
  params: { sort?: string; order?: string; limit?: number },
  detailsAsked: boolean,
  extraCols: string[],
  offset: number,
): { list: string[]; note: string } {
  const list: string[] = [];
  // Round 193 F-193-03: `details` and `columns` are TWO parameters, and a call that sent `details: true` and
  // never mentioned `columns` was being told its `columns` was dropped. Each is named only when the call sent
  // it, and the requested column list rides with the `columns` entry.
  if (detailsAsked) list.push("details");
  if (extraCols.length) list.push(`columns (${extraCols.join(", ")})`);
  if (params.sort) list.push(`sort=${params.sort}`);
  if (params.order) list.push(`order=${params.order}`);
  if (params.limit != null) list.push(`limit=${params.limit}`);
  if (offset > 0) list.push(`offset=${offset}`);
  return {
    list,
    note:
      list.length === 0
        ? ""
        : `\n[count_only returns the count only: ${list.join(", ")} ` +
          `${list.length === 1 ? "is" : "are"} not applied to this answer]`,
  };
}

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------

const SEARCH_QUERY_DESCRIPTION =
  "Everything index query. Partial names match by default (wildcards apply to the " +
  "whole filename). '*' any characters (not across \\), '?' one character, '**' any " +
  "characters including \\; '|' = OR, '!' = NOT, \"...\" = exact phrase, <...> = grouping. " +
  "Common terms: ext:pdf · size:>100mb · size:1mb..10mb · " +
  "size:empty|tiny|small|medium|large|huge|gigantic · dm:today (date modified; also " +
  "yesterday, thisweek, lastweek, 10mins, 2days, 3weeks, 2024..2025) · dc:/da: (created/accessed) · " +
  "parent:C:\\Users (directly in) · ancestor: (any depth under) · parent-name: · " +
  "stem: · file:/folder: · regex:x (with the regex flag). " +
  "Quote EVERY function value that contains a space. Unquoted, a path-valued function " +
  "(ancestor:, parent:, path:) returns 0, but a NAME-valued one (file:, folder:, stem:, " +
  "parent-name:, childname:) splits the value and returns a plausible WRONG non-zero set " +
  "(measured: file:\"Program Files\" 0 vs file:Program Files 330). " +
  "Call everything_syntax for the full verified reference (including terms broken " +
  "on this 1.5 beta). " +
  `A query longer than ${MAX_PARAM_BYTES.toLocaleString("en-US")} bytes is refused before anything runs: es.exe is ` +
  "started with this text on its command line, and a count answer echoes it back.";

const SEARCH_DESCRIPTION =
  "Search the local Windows filesystem with the Everything index — instant, " +
  "machine-wide (typically <100 ms). PREFER this over find/ls/glob or bash directory " +
  "scans for file-by-name/path/extension/size/date questions; use everything_grep " +
  "for file CONTENTS (it reuses this index to pick the files, so the scan skips " +
  "the directory walk). count_only=true answers the count and no row list (add total_size for the byte " +
  "total). Two separate ceilings: ONE answer is cut at 15KB and says how many lines it dropped, and a call " +
  "never reads past the first 2000 matches, so offset stops there. Windows only.";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  if (process.platform !== "win32") return;

  pi.on("session_start", () => {
    void checkHealth();
  });

  // ---- everything_search --------------------------------------------------

  pi.registerTool({
    name: "everything_search",
    label: "Everything Search",
    description: SEARCH_DESCRIPTION,
    promptSnippet:
      "File search on this machine: Everything index — instant, machine-wide.",
    promptGuidelines: [
      "File search: use everything_search for any file-by-name/path/extension question — instant, machine-wide — including 'all X under folder Y' globs (ancestor:/path:, !path:node_modules to skip deps). find/ls only inside the repo: they walk disk and drown in node_modules. Content search with a name/path/type/date clue: use everything_grep (Everything picks the files, in-process scan, no walk); plain grep only for content-only search (no scoping clue) or scope:'symbol'",
    ],
    parameters: Type.Object({
      query: Type.String({ description: SEARCH_QUERY_DESCRIPTION }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Skip the first N matches (paginate with limit). Hard ceiling: only the first " +
            "2000 matches are ever fetched, so offset must stay below 2000 - narrow the " +
            "query (or sort) to reach anything past that. An offset at or past 2000 answers with that " +
            "explanation instead of scanning, and a page the ceiling cuts short says so in the output.",
        }),
      ),
      sort: Type.Optional(
        StringEnum(
          [...SORT_COLUMNS],
          {
            description:
              "Sort results by this field (default: index order, typically name). Six of the nine cost " +
              "tens of milliseconds whatever the query matches (measured 2026-11-05 at `-n 500` on 9,670, " +
              "324,987 and 3,778,486 matches: 35-49 ms as es.exe, 54-77 ms through this tool, the same at all " +
              "three scales; `syntax.md` prices the same six at `-n 2000` at 73-98 ms, which is the fetch size, " +
              "not a second rate); `attributes`, `date-created` and `date-accessed` order EVERY match before " +
              "they can " +
              "return a page (about 12.5-25 ms per 1,000 entries at the scopes of 324,987 and up, a rate of the " +
              "QUERY rather than of the row count: 4,129-4,339 ms for 324,987 across runs; on the 2026-11-07 " +
              "drives 1,461,299 took 18.3-18.7 s, 1,059,906 took 14.1-24.2 s and 1,816,088 took 40.3-45.5 s; " +
              "`syntax.md` prices those three at `-n 2000` on a 15,035-row scope at 348-350 ms, which is the " +
              "fetch size again and not a second rate) and " +
              "are refused past 1,500,000 matches - that refusal is priced on a count, so a query whose " +
              "count is never asked (scan-only terms, see `count_only`) is not priced and runs anyway. Direction " +
              "comes from `order`. A property not listed here cannot be sorted on and is refused before es.exe is " +
              "asked: a property sort reads EVERY match, so `-n` cannot save it (re-measured 2026-11-05 at 324,987 " +
              "and at 3,778,361 entries with -n 3: `author`, `width` and `bitrate` each burned the full 30 s and " +
              "answered nothing - 30,009-30,111 ms, twice each; on a 14,996-row `ext:exe` scope the same names " +
              "cost 1.4-2.5 s, " +
              "16.4 s with a cold property store). Rows are grouped by KIND before the key is applied: folder "
              + "rows print FIRST ascending and LAST descending whatever the key (measured 2026-11-06 sorting "
              + "`C:\\tmp\\esq82-fix` by `size`: the 70-byte folder esq82-innerprobe\\ printed ahead of the "
              + "10-byte alphax.txt ascending and after it descending), so a page mixing files and folders always "
              + "shows out-of-key rows at the near end. `attributes` orders by Everything's attribute ORDER, "
              + "not by the numeric `attributes` column the same row prints (measured over the attr99 fixture: "
              + "ascending "
              + "read Archive, Archive, Compressed, Hidden, NotContentIndexed, Normal, Offline, ReadOnly, "
              + "System, Temporary while that column read 32, 32, 2048, 2, 8192, 128, 4096, 1, 4, 256). "
              + "`date-recently-changed` is the one name whose key no answer on this box prints - its column is "
              + "blank on every row of every kind measured - so the only check available on it is that the two "
              + "directions return different rows.",
          },
        ),
      ),
      order: Type.Optional(
        StringEnum(["ascending", "descending"], {
          description:
            "Sort direction (default ascending; only meaningful beside `sort` - a lone `order` is accepted, "
            + "changes nothing, and the answer names it as inert).",
        }),
      ),
      details: Type.Optional(
        Type.Boolean({
          description:
            "Include size (bytes) and ISO date-modified columns for each result.",
        }),
      ),
      count_only: Type.Optional(
        Type.Boolean({
          description:
            "Return only the total match count, no paths. A query whose ONLY narrowing is un-indexed " +
            "scan terms (dc:, content:, and attrib: with ANY value except the DIRECTORY flag - attributes:d " +
            "and its !d/>d spellings ARE indexed and ARE counted: 738,526 rows in 45 ms, 2026-11-07) has no count to " +
            "fetch on this box, and the answer says so at once instead of waiting out a 15 s timeout; da: " +
            "(date-accessed) refuses even beside indexed terms - no narrowing measured here brings its count " +
            "inside a leash (da:2026-11-01 ext:exe counted 5 in 59.2 s). A count answer carries no " +
            "rows, so " +
            "details/columns, sort/order, limit and offset do not apply to it — if you pass any of " +
            "them, the output names the ones it did not use. For any query that could match many " +
            "files, run this FIRST to size the answer before fetching — combine with total_size " +
            "for bytes. A count that es.exe answers in no readable form is reported as unreadable, " +
            "never as zero.",
        }),
      ),
      regex: Type.Optional(
        Type.Boolean({
          description:
            "Treat the FIRST query term as a regular expression: es.exe's -regex consumes exactly one " +
            "argument, so later terms stay ordinary searches (measured 2026-11-04: -regex plain together " +
            "with a second term (plain) answered 1 row - the intersection - where the group on its own " +
            "answered 2). es.exe's engine, matched against the filename; with match_path, against the " +
            "whole path. Two measured traps: an unquoted SPACE inside a pattern is a term separator - " +
            "es.exe ANDs the parts, so a b matches names holding both letters, while the same pattern " +
            "quoted matches the literal text with the space (5 vs 1 on a 5-file fixture, 2026-11-04); and " +
            "es.exe answers 0 with exit code 0 for a pattern it cannot parse, so a zero is not proof the " +
            "pattern was valid. es.exe's engine is PCRE-family, verified here on a 5-name fixture: " +
            "`[[:alpha:]]`, `\\p{L}`, `(?i:)`, `(?>…)`, `\\K`, `\\A`, `\\z` and `(?P<name>` each answered 5 " +
            "rows, while `\\k<name>` after a `(?<name>` group answered 0. That is a DIFFERENT grammar from " +
            "everything_grep's `pattern`, which is JavaScript RegExp - the same string selects rows here and " +
            "is refused there, or is read as literal letters there.",
        }),
      ),
      case_sensitive: Type.Optional(
        Type.Boolean({
          description:
            "Case-sensitive matching (default: case-insensitive). It applies to EVERY part of the query, scope " +
            "values included, so a path written in the wrong case silently matches nothing: measured 2026-11-05 " +
            "on a fixture at C:\\tmp\\esq82-fix, ancestor:\"c:\\tmp\\esq82-fix\" and " +
            "ancestor:\"C:\\TMP\\ESQ82-FIX\" each answered 0 rows where the index's own spelling answered every " +
            "file in that folder; with this parameter off all three spellings answered that same full set. " +
            "Write the scope the way the index stores it, or leave this parameter off.",
        }),
      ),
      whole_word: Type.Optional(
        Type.Boolean({
          description:
            "Match whole words only. INERT in regex mode: es.exe ignores whole-word matching once a regular " +
            "expression is in play - measured 2026-11-06 at C:\\tmp\\esq82-fix, `alpha` with whole_word " +
            "answered 1 row, with `regex: true` answered 2, and with both answered the same 2, and an " +
            "in-query `regex:` term behaves the same way. The answer says so when both are set. To bound " +
            "an expression, carry the bound in it (`\\balpha\\b`) or drop the regex.",
        }),
      ),
      match_path: Type.Optional(
        Type.Boolean({
          description:
            "Match the full path (not just the filename).",
        }),
      ),
      diacritics: Type.Optional(
        Type.Boolean({
          description:
            "Match diacritical marks exactly (é does not match e). Default: diacritics are ignored - measured " +
            "2026-11-06 on a fixture at C:\\tmp\\esq82-fix, where `cafe` found both `cafe.txt` and `café.txt` " +
            "(2 rows) and found `cafe.txt` alone with this on (1). Accent folding never drops a hyphen - " +
            "`ignore-punctuation:` does that - so a hyphenated spelling is not this parameter's case. Unlike " +
            "case_sensitive this changes accent folding ONLY: an UPPER-cased search term and an UPPER-cased " +
            "ancestor: still answer with it on (0 rows is case_sensitive's trap, not this one's).",
        }),
      ),
      total_size: Type.Optional(
        Type.Boolean({
          description:
            "Also return the total size (bytes) of ALL matches for the query. When es.exe gives no " +
            "byte total (a timeout, an error, an unreadable reply) the output prints " +
            "'total size: unknown' and says which, instead of printing nothing.",
        }),
      ),
      columns: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Extra property columns per result (implies details). Whether a column carries a VALUE depends on " +
            "the FILE KIND, so scope the query to that kind: `ext:jpg` shows image properties, `ext:mp3` audio " +
            "ones, `ext:pdf` document ones, `ext:dll` executable ones. A FOLDER row carries no FILE-TYPE " +
            "property (`extension`, `content-type`, `file-signature` and every shell media/document column are " +
            "blank on it) and an `ancestor:` listing returns subdirectories FIRST, so a shell-property probe " +
            "reads as all-blank. The FILESYSTEM-native columns are the exception and fill folder rows too: " +
            "over 200 large folder rows (`folder: size:>100mb`, 2026-11-05, re-driven 2026-11-06) " +
            "`attributes`, `date-created`, `date-accessed`, `kind` (value `folder`) and `run-count` filled " +
            "200/200, `hard-link-count` 199/200, `parent-name` 197/200, `volume-label` 107/200 then 104/200 " +
            "re-driven - 200/200 inside a labelled volume. Those two readings are raw `es.exe -export-tsv` " +
            "captures at `-n 200 -sort size-descending`, because no answer of this tool can hold them: its " +
            "byte budget cuts a 200-wide-row call near 125 rows and `limit` stops at 500. " +
            "Re-driven 2026-11-06 over the 96 rows one answer printed: the `parent-name` blanks ARE the " +
            "volume roots (`E:\\`, `C:\\`, `D:\\`), and the single `hard-link-count` blank is " +
            "`C:\\System Volume Information\\` - a protected folder whose properties cannot be read, not a " +
            "volume root. " +
            "Measured 2026-11-05 and re-driven 2026-11-06 in that same shape (`-n 40 -sort size-descending`, " +
            " one `ext:` corpus per name - the whole " +
            "index's top 40 by size, so re-driving the same `ext:` lands on different rows), where DENSE " +
            "versus SPARSE matters more than the name: on images (`ext:jpg`) `width`, `height`, `bit-depth` " +
            "and `aspect-ratio` filled 40 of 40 rows, `camera-maker`, `camera-model`, `iso-speed` and " +
            "`f-stop` 34 of 40 and `date-taken` 36 of 40 (2026-11-05 read 33 and 18 - the top-40 caveat " +
            "above), while `latitude`, `longitude` and `tags` are SPARSE - 1 of 40 each, present only on the " +
            "files that carry them (`tags` read 0 of 40 `ext:jpg` and 1 of 40 `ext:png`). The AUDIO technical " +
            "properties (`length`, `audio-bitrate`, " +
            "`total-bitrate`, `audio-channels`, `audio-sample-rate`, `audio-bits-per-sample`) are dense on " +
            "`ext:mp3` (40 of 40) and on `ext:mp4` (40 of 40), but over `ext:wav` they filled 38 of 40 - 2 wav " +
            "rows carry no audio properties at all. `video-bitrate` and `frame-rate` need a VIDEO " +
            "corpus: 0 of 40 `ext:mp3`, 40 of 40 `ext:mp4`. Audio TAGS are sparse (`artist`, `album`, `title` " +
            "2 of 40 `ext:mp3`, `year` 3 of 40, `track` 1 of 40, `genre` 1 of 40 `ext:wav`; 2026-11-05 read 3 " +
            "and 4). `page-count` " +
            "needs a document (28 of 40 `ext:pdf`) and `company`, `product-name`, " +
            "`product-version` and `version` an executable (32 of 40 `ext:exe`). `author` and `title` answer on " +
            "PDFs (13 and 15 of 40), on `.doc` (6 of 12), and wherever a PNG text chunk or an audio tag carries " +
            "them (`author` 1 and `title` 1 of 40 `ext:png`, `title` 2 of 40 `ext:mp3`) - but all 25 `ext:docx` " +
            "rows here came back BLANK for `author`, `title` AND " +
            "`page-count`, so a Word-document corpus buys none of the document columns. `hard-link-count` " +
            "carries a value on every row " +
            "Everything can read (1 for a lone name, 2+ for a hard link; 1 of 2,000 `ext:txt` rows came back " +
            "blank re-driven 2026-11-06 and 19 of 2,000 on 2026-11-05 - a different unreadable row each run, " +
            "same raw capture as the folder figures above). Live here and unnamed above: `date-created`, " +
            "`date-accessed`, `date-changed`, `extension` (blank on a folder; keeps the name's own case), " +
            "`parent-name`, `volume-label` (blank on an UNLABELLED volume, which is not a dead column), `kind` " +
            "(a coarse word, SIX values seen here - `document`, `program`, `picture`, `folder`, `music` and " +
            "`video` (`ext:mp3` rows read `music`, `ext:mp4` and `ext:mov` rows read `video`, and `ext:zip` " +
            "rows read `folder` although a zip is not one) - and it " +
            "renders BLANK for `ext:dll`, `ext:js`, `ext:ttf` and " +
            "`ext:md`, which is no registered kind rather than a dead column), `run-count` (0 for anything never " +
            "opened through Everything, while `date-run` IS one of the five dead names), `comment` (sparse: 3 " +
            "of 40 `ext:mp3`). `attributes` is the NUMERIC Win32 bitfield, not the letters the `attributes:` query " +
            "takes: it equals `[IO.File]::GetAttributes` for the same file and every folder row carries bit " +
            "16. `file-signature` is the MIME type read from the file's BYTES (a PNG named `thumbnail3.jpg` " +
            "reads `image/png`); `content-type` is the MIME type read from its EXTENSION (that same file says " +
            "`application/jpg`). `software` needs an INSTALLER: 36 of 40 `ext:msi` rows carry a product name, " +
            "0 of 40 `ext:exe` rows do - even inside `C:\\Program Files`. Five names render NOTHING for any " +
            "file kind sampled on this box: `date-run`, `date-recently-changed`, `date-acquired` (ask " +
            "`date-created` instead), `lens-model` and `people` - each 0 of 40 over `ext:csv`, `ext:mjs`, " +
            "`ext:ttf`, `ext:md`, `ext:pdf` and `ext:mp3` driven 2026-11-06. Four more fill ONLY legacy OLE " +
            "documents and nothing else: `word-count` 6 of 12 `ext:doc` and 5 of 9 `ext:ppt`, `line-count` " +
            "6 of 12 `ext:doc` (0 of 9 `ext:ppt`), both 0 of 25 `ext:docx` and 0 of 40 `ext:pdf`, " +
            "`last-author` 6 of 12 `ext:doc`, 8 of 14 `ext:xls`, 5 of 9 `ext:ppt`, and `slide-count` 5 of 9 " +
            "`ext:ppt` - `ext:ppt` is the corpus that answered those, there being no .pptx here. " +
            "Invalid names " +
            "are rejected with the full 55-name allowlist. A SHELL-property column costs " +
            "about 0.7-1.3 ms per row FETCHED (measured 2026-11-05 as a slope over an `ext:exe` scope of roughly "
            + "15 K rows at limits 50-500: " +
            "`author` adds 0.70 ms a row, `width` 1.22 ms, and both together 1.84 ms - columns ADD - while a " +
            "listing with no extra column cost 59-67 ms at every one of those limits). A FILESYSTEM-native column " +
            "is 30-47x cheaper on its own pairs: warm at `-n 2000 ext:exe` on a 15,015-row reading of that " +
            "scope (62-63 ms with no column; both counts as the same day's run recorded them) " +
            "`hard-link-count` added 0.027-0.029 ms a row and `attributes` 0.036-0.037 ms, while `author` cost " +
            "1.125-1.274 ms a row in the same two passes - 39-47x for the first pair, 30-35x for the second. " +
            "`syntax.md` prices the SAME `-n 2000` `author` fetch at 1.70 ms a row from a colder hour: that is " +
            "the box state named below, not a fourth rate. `limit` is capped at 500 " +
            "and a long page is cut further by the 15 KB answer budget, so the rows FETCHED are the rows priced. " +
            "The rate did not move across the candidate sets measured here - none matched, 9,670 and 83,610 - " +
            "and none of those three is the whole index: the same 500 rows with `author;width` cost 869 ms " +
            "over a 9,670-entry candidate set and 850 ms over an 83,610-entry one, and a listing that matched " +
            "nothing paid 66 ms (round 85's run, 2026-11-05). What one call actually costs is box state, "
            + "though: the same " +
            "500-row `author` request measured 406-449 ms in one hour and 1,345-1,376 ms earlier the same day " +
            "(`width` 662-739 ms against 2,416-2,445 ms), and the first property read after the machine has " +
            "waited can cost ten times the slope again (one `author` call took 16.4-16.6 s; a 45 s gap showed " +
            "no penalty). So treat the per-row rate as the model and a total as one run's reading. Ask for few " +
            "columns on a large limit; a name asked for twice is answered once, and the answer names the " +
            "duplicate.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const query = stringParam("query", params.query).trim();
      if (!query) throw new Error("query must be a non-empty string");
      const limit = intParam("limit", params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
      const offset = intParam("offset", params.offset, 0, 0, WHOLE_NUMBER_MAX);
      // Every BOOLEAN this tool reads goes through flagParam, once, here. pi does not validate tool
      // parameters at runtime (round 82) and the reads used to disagree with each other: `if (params.count_only)`
      // is truthiness, so `count_only:"false"` took the count-only branch (measured 2026-11-05: it answered
      // "5 file(s) match:" where `count_only:false` answers the 5-row listing), while `params.details === true`
      // took `details:"true"` OFF (no size/date columns). `asked` is what the rest of this function reads,
      // so no site can re-invent the comparison.
      const asked = {
        regex: flagParam("regex", params.regex),
        caseSensitive: flagParam("case_sensitive", params.case_sensitive),
        wholeWord: flagParam("whole_word", params.whole_word),
        matchPath: flagParam("match_path", params.match_path),
        diacritics: flagParam("diacritics", params.diacritics),
        details: flagParam("details", params.details),
        countOnly: flagParam("count_only", params.count_only),
        totalSize: flagParam("total_size", params.total_size),
      };
      // sort/order are checked for EVERY branch (round 84 F-84-5). The list runner has refused an unpriced
      // name since round 82, but with count_only:true the parameter never reaches that runner, so the same
      // bad name answered "[count_only returns the count only: sort=bitrate is not applied to this answer]"
      // here and `sort:{}` echoed "sort=[object Object]" - the verdict depended on an unrelated parameter.
      validateSortOrder(params.sort, params.order);

      const prep = prepareEsQuery(query);

      // es.exe answers a duplicated property column ONCE, and the field that survives sits at the
      // LAST position it was asked for: measured 2026-11-04, `-add-columns "width;height;width"`
      // exported height-then-width, so a header built from the raw request printed `width` over the
      // height VALUE (and `"width;width"` exported one field under a two-name header). De-duplicate
      // before the call - first mention wins, so es.exe never sees a duplicate - and say what dropped.
      const requestedCols = stringListParam("columns", params.columns);
      const extraCols = [...new Set(requestedCols)];
      const droppedCols = requestedCols.filter((c, i) => requestedCols.indexOf(c) !== i);
      const badCols = extraCols.filter((c) => !COLUMN_ALLOWLIST.includes(c));
      if (badCols.length > 0) {
        // Round 183 F-183-04: the details-row clause is why `path`, `size` and `date-modified` are refused
        // - those are columns every details row already carries. Printed for EVERY unknown name it told a
        // caller that their unrecognised name failed because it was already in the row, so the clause now
        // rides only the names it actually describes.
        const alreadyInRow = badCols.filter((c) => c === "path" || c === "size"
          || c === "size-bytes" || c === "date-modified");
        throw new Error(
          `Unknown column(s) for everything_search: ${boundedEcho([...new Set(badCols)].join(", "))}. ` +
            (alreadyInRow.length > 0
              ? `path, size-bytes and date-modified are already in every details row (that is why asking `
                + `for one of them fails); `
              : "")
            + `the extra columns available are: ${COLUMN_ALLOWLIST.join(", ")}`,
        );
      }
      const detailsMode = asked.details || extraCols.length > 0;
      // Notes that describe the WHOLE answer (page-cut, duplicate columns, total size). They are
      // appended after the byte cut, not before it, so a long page cannot drop them - see outText.
      let trailingNotes = "";
      // Round 167 F-167-01: the ignored-parameter note used to run one way (grep named search's twelve,
      // search named nothing). The same sentence runs here now, and the `count_only` answer carries it
      // beside its own "is not applied" account. The throwing paths (unknown column, refused sort) die
      // before notes exist, so a call that both sends a foreign key and asks for something refused reports
      // the refusal only.
      const foreignSearchNote = foreignParamNote("everything_search", params, FOREIGN_AT_SEARCH);
      if (foreignSearchNote !== "") trailingNotes += capAnswerNote(foreignSearchNote);

      // The flag arguments are needed by the count_only refusal now (a per-entry walk is priced with its own
      // count), so they are built once here instead of inside the branch below.
      const matchFlags = matchFlagArgs({
        regex: asked.regex,
        caseSensitive: asked.caseSensitive,
        wholeWord: asked.wholeWord,
        matchPath: asked.matchPath,
        diacritics: asked.diacritics,
      });
      // count_only / total_size: fast calls, no result fetch
      if (asked.countOnly) {
        // A count this index cannot answer is refused NOW, not after the leash expires: measured on a
        // 75 s leash, `-get-result-count dc:today` and `content:zip` never answered at all, so the 15 s
        // wait only delayed this admission (and cost four suite cases 15 s each). A query with an
        // indexed term beside the scan-only one keeps the normal path - dc:2026-11-01 ext:exe counted 97 in
        // 116 ms on 2026-11-06 (99 in 2 s on 2026-11-04). A scan-only term alone on one side of a union is
        // refused the same way: round 66 measured
        // fifteen union shapes, and the nine nothing was ANDed onto never answered in 20 s while the six with
        // an ANDed term answered in milliseconds.
        const deadTerm = uncountableScanTerm(
          prep.esQuery,
          splitQueryTerms(prep.esQuery),
          regexRequested(asked, prep.esQuery) ? 0 : -1,
        );
        // Round 71 F-71-2: a value function WITH partners is PRICED, not guessed. The AND of the partners is one
        // indexed count (40-60 ms measured), and if that many entries cannot be walked inside this 15 s leash the
        // count is refused with the number that says so, instead of spending the whole leash to learn the same
        // fact from a timeout. See PROPERTY_WALK_US_PER_ROW for the measured warm rate and its cold caveat.
        const wideTerm = deadTerm
          ? null
          : await widePropertyWalk(prep.esQuery, matchFlags, signal, "count");
        const dead = deadTerm ?? wideTerm;
        if (dead) {
          const { list: skippedIgnored, note: ignoredNote } = countOnlyIgnoredAccount(
            params,
            asked.details === true,
            extraCols,
            offset,
          );
          const why = metadataNotAskedBody(dead);
          return {
            content: [
              {
                type: "text",
                text:
                  `${prep.escapeWarning}No count asked for: ${boundedEcho(query)}\n${why}` +
                  // The refusal body above IS the answer; these two lines are its notes, so round 187 F-4
                  // brings them under the set ceiling like every other note set.
                  capNotesTotal(
                    (asked.totalSize
                      ? "\ntotal size: unknown - no -get-total-size call was made either, for the same "
                        + "reason as the count"
                      : "") + ignoredNote,
                  ),
              },
            ],
            details: {
              query,
              esQuery: prep.esQuery,
              total: null as number | null,
              shown: 0,
              offset,
              withDetails: false,
              columns: extraCols,
              totalSizeBytes: null as number | null,
              // Round 193 F-193-05: this field is the SIZE account and nothing else - the same sentence the
              // answer prints beside the byte figure. It used to carry the whole count-refusal body, so a caller
              // reading it learned about the COUNT while the answer itself printed no size line at all (a call
              // that never asked for `total_size`). The refusal body stays in the answer text; `countSkippedTerm`
              // is what marks this branch.
              totalSizeNote: asked.totalSize
                ? "no -get-total-size call was made either, for the same reason as the count"
                : "no -get-total-size call was made",
              csvFallback: false,
              truncated: false,
              countOnlyIgnored: skippedIgnored,
              // The public `details` key stays the TERM STRING it has always been (round 66: two suite cases
              // that read it caught the moment it became an object); the union shape is in the prose.
              countSkippedTerm: dead?.term ?? null,
            },
          };
        }
        // The byte total is summed from the sizes the index already holds, so its cost does not depend on how many
        // entries the query matches: measured 39-48 ms for `ext:xml` (9,669), `ext:json` (83,454), `ext:ts`
        // (324,987) AND `*` (3,777,046 entries, 5,590,371,888,760 bytes) - `C:/tmp/esq77/p1.mjs`. What a size call
        // CAN pay for is the query's own per-entry value walk, and that arrives at the COUNT rate: `latitude:47`
        // over `ext:json` 5,870 ms size vs 8,747 ms count, `keywords:nobody` over the same partner 5,951 vs 5,953,
        // and `orientation:` over `ext:png` 7,179 vs 7,195 (`p1b.mjs`). So this call stays exactly as it is -
        // parallel, capped at the
        // count leash - and `widePropertyWalk`'s count price already refuses the only shape that could blow it.
        const totalSizeP = asked.totalSize
          ? runEs(["-get-total-size", ...termArgs(matchFlags, splitQueryTerms(prep.esQuery))], signal, COUNT_TIMEOUT_MS)
          : null;
        const [r, ts] = await Promise.all([
          runEs(["-get-result-count", ...termArgs(matchFlags, splitQueryTerms(prep.esQuery))], signal, COUNT_TIMEOUT_MS),
          totalSizeP ?? Promise.resolve(null),
        ]);
        if (r.spawnError || r.code !== 0)
          throw new Error(esFailureMessage(r, prep.esQuery, regexRequested(asked, prep.esQuery) ? 0 : -1));
        const rawCount = r.stdout.toString("utf-8").trim();
        // Strict, the way everything_status parses the same reply: parseInt's NaN used to fall
        // through to 0, so a count that answered "n/a" (or nothing) with exit code 0 printed
        // "0 file(s) match" — the false zero this extension exists to prevent (measured 2026-11-04
        // against a compiled es.exe stub; the list path already reported null here).
        const n = parseCountAnswer(rawCount);
        const size = sizeAnswerOf(ts, n);
        const countLine =
          n != null
            // "matching", not "file(s) match": a count answer counts INDEX ROWS, and a folder is a row
            // (round 93 measured `size:>1gb` = 1,126 rows, 662 of them folders), so the list header's word is
            // the word this line uses too.
            ? `${n.toLocaleString("en-US")} matching: ${boundedEcho(query)}` +
              // Everything that could make this NUMBER mean something other than "N files in the scope you
              // typed" is stated here: the `!` exclusion (whose count IS an exclusion count whatever the
              // number is) and the `|` leak, plus - only when the count is 0 - the four hints that explain a
              // zero (a strict-matching switch, regex parse failure, UNC/device root, literal parentheses).
              // Round 53 F-53-2/F-53-3
              // fixed this branch's missing backslashRootNote and its flag-only regex gate; the suffix now
              // lives in countGrammarNotes() because the unreadable branch below needs the same notes.
              countGrammarNotes(asked, query, n)
            : `The Everything count did not answer in a readable form for: ${boundedEcho(query)}\n` +
              `es.exe exited 0 and answered ${
                rawCount ? `"${rawCount.slice(0, 40)}"` : "nothing"
              } to -get-result-count. That is NOT zero matches: check everything_status, or re-run ` +
              `without count_only and read the header (it says "total unknown" when the total is dark).` +
              // Round 54 F-54-5: these notes describe the QUERY, not the number, so an unreadable count
              // carries them too - the caller still needs to know that the number, had it answered, would
              // have been an exclusion count or a half-scoped union. The zero-only hints are excluded inside
              // the builder, because this answer explicitly is not a zero.
              countGrammarNotes(asked, query, null);
        // The "is not applied" account, shared with the refused-count branch (see countOnlyIgnoredAccount).
        const { list: ignored, note: ignoredNote } = countOnlyIgnoredAccount(
          params,
          asked.details === true,
          extraCols,
          offset,
        );
        return {
          content: [
            {
              type: "text",
              text:
                `${prep.escapeWarning}${countLine}` +
                // Round 180 F-3: these three are whole-answer notes too, and this return has NO truncateHead
                // behind it - measured today the fullest shape sits 640 bytes under MAX_OUTPUT_BYTES with
                // nothing enforcing that. Each is capped at its own site the way the list path caps its own,
                // and round 187 F-4 puts the SET under MAX_NOTES_TOTAL_BYTES like every other note set, so the
                // README's "bounded at their own sites and by that set ceiling" is enforced on this shape.
                capNotesTotal(
                  `${asked.totalSize ? capAnswerNote(sizeSentence({ ...size, count: n, query })) : ""}` +
                    capAnswerNote(ignoredNote) + capAnswerNote(foreignSearchNote),
                ),
            },
          ],
          details: {
            query,
                        esQuery: prep.esQuery,
            total: n,
            shown: 0,
            offset,
            withDetails: false,
            columns: extraCols,
            totalSizeBytes: size.bytes,
            totalSizeNote: size.note,
            countSkippedTerm: null as string | null,
            csvFallback: false,
            truncated: false,
            countOnlyIgnored: ignored,
          },
        };
      }

      const fetchCount = Math.min(offset + limit, MAX_FETCH);
      const list = await fetchEsList({
        query,
        regex: asked.regex,
        caseSensitive: asked.caseSensitive,
        wholeWord: asked.wholeWord,
        matchPath: asked.matchPath,
        diacritics: asked.diacritics,
        sort: params.sort,
        order: params.order,
        fetchCount,
        offset,
        detailsMode,
        extraCols,
        totalSize: asked.totalSize,
        signal,
      });

      const lines = list.lines.slice(offset, offset + limit);
      const total = list.total;
      const totalBytes = list.totalSizeBytes;

      let text: string;
      if (lines.length === 0) {
        if (offset >= MAX_FETCH) {
          // True whatever the count says - and the count is exactly what does not answer on a
          // scanning query, where this path used to print a plain "no results" and send the reader
          // hunting for a query problem that is really the ceiling.
          text =
            (total != null
              ? `${total.toLocaleString("en-US")} matching, but `
              : "The total did not answer; either way, ") +
            // The arms below offer narrowing because there it genuinely re-selects the fetched set.
            // THIS branch is gated only on offset >= MAX_FETCH, so the fetch has already stopped and
            // nothing but the offset moves the window (measured 2026-11-06 at offset 2000: the same
            // sentence printed over 6,987 rows, over a 2-row narrowed query, and with sort=size).
            `offset ${offset} is at or past the ${MAX_FETCH}-row fetch ceiling, so this window can ` +
            `hold no row. Lower the offset - the only lever at this offset. Narrowing the query or ` +
            `changing sort changes WHICH rows sit inside the first ${MAX_FETCH}; reach those rows ` +
            `from a lower offset.`;
        } else if (total != null && total > 0) {
          // Two different reasons for an empty window, and only one of them is the fetch ceiling: when the
          // WHOLE answer is smaller than the offset, narrowing cannot add rows behind the end of the answer.
          // Round 160 F-160-8 (measured: `ext:heic` holds 124 rows; offset 200 was past the answer's end).
          text = (total != null && total < MAX_FETCH)
            ? `${total.toLocaleString("en-US")} matching, but none in this window (offset ${offset}, ` +
              `limit ${limit}) - the whole answer holds ${total.toLocaleString("en-US")} rows, so offset ` +
              `${offset} is past its end. Lower the offset to see the last rows; narrowing the query ` +
              `cannot add rows behind the end of the answer.`
            : `${total.toLocaleString("en-US")} matching, but none in this window (offset ${offset}, ` +
              `limit ${limit}). At most ${MAX_FETCH} rows are fetched, so offset must be below ` +
              `${MAX_FETCH} - lower the offset, or narrow the query to reach later rows.`;
        } else if (total == null && offset > 0) {
          // Round 191 F-191-2: an empty WINDOW is not a zero-result answer when the total was never measured.
          // The known-total arm above can say "the whole answer holds N rows, so offset X is past its end";
          // with no total this answer cannot tell "the query is empty" from "the window sits past the rows",
          // so it must not print "No results found" - a caller paginating a scan-only query (no count is ever
          // asked for one, e.g. `dc:today`, driven 2026-11-07) was told its query matches nothing.
          text = `No rows in this window (offset ${offset}, limit ${limit}), and the total for this query ` +
            `did not answer - so this answer is NOT a claim that the query matches nothing. Rows may sit ` +
            `behind this window: lower the offset, or set it to 0, to see what the fetch holds.`;
        } else {
          // whole_word is a proven narrower (2 rows to 1), so it belongs beside the other two - but ONLY
          // outside regex mode, where it is inert: blaming it for a zero there would be a new wrong reason.
          text = noResultsText(query, regexRequested(asked, query),
            [asked.caseSensitive ? "case_sensitive" : "", asked.diacritics ? "diacritics" : "",
              asked.wholeWord && !regexRequested(asked, query) ? "whole_word" : ""]
              .filter((f) => f !== ""),
            regexPatternTermIndex(asked, query),
            list.countSkippedTerm?.term ?? null,
            total == null);
        }
      } else {
        const header =
          extraCols.length > 0
            ? `path\tsize-bytes\tdate-modified\t${extraCols.join("\t")}`
            : "path\tsize-bytes\tdate-modified";
        const body = detailsMode ? [header, ...lines] : lines;
        text = buildResultText(query, total, offset, lines.length, body, list.countSkippedTerm);
        // A page shorter than asked for WHILE more rows exist was cut by the fetch ceiling, not by
        // the query. Measured 2026-11-04: offset 1995 + limit 100 on a 15,035-row query printed 5 rows
        // under a header that read like the query had run out ("showing 5 after offset 1995").
        if (total != null && lines.length < limit && total > offset + lines.length) {
          trailingNotes += capAnswerNote(
            `\n[page cut short: one call fetches at most the first ${MAX_FETCH} matches, and offset ` +
            `${offset} + limit ${limit} reaches past that - lower the limit, or narrow the query (or ` +
            `change sort) to bring the rows you want inside the first ${MAX_FETCH}]`);
        }
        // A property column asked for twice is de-duplicated ABOVE, in `execute`: raw es.exe answers each
        // column once at the LAST position it was asked for (duplicateColumnNote's measurement), so a header
        // built from the raw request would print the first name over the second column's value. The request
        // reaching here is already first-mention-first, which is why the table came back `path size-bytes
        // date-modified width author` with ONE width field (columns ["width","author","width"], 2026-11-04).
        // Say what was dropped, or the column count in the answer no longer
        // matches what the caller sent.
        if (droppedCols.length > 0) trailingNotes += capAnswerNote(duplicateColumnNote(droppedCols));
        // A property column blank on every fetched row is an install fact, not a data fact (see
        // blankColumnNote): say so, or the reader takes a blank field for "this file has no such value".
        if (extraCols.length > 0 && lines.length > 0) {
          const blankCols = extraCols.filter((_, i) =>
            lines.every((l) => (l.split("\t")[3 + i] ?? "").trim() === ""));
          if (blankCols.length > 0) trailingNotes += capAnswerNote(blankColumnNote(blankCols, lines.length));
        }
      }
      // A term that begins with `!` is Everything's NOT operator, which is almost never what a caller
      // who typed a file name meant (see notOperatorNote). Fires on the answered and the empty answer.
      // Round 54 F-54-4: the third argument is the PATTERN INDEX (0 under regex, -1 otherwise), not the
      // regex flag: a `!` term standing AFTER the pattern still excludes literal text, so it still needs the
      // note, while a `!` standing IN the pattern needs the regex-group note instead.
      // Grammar atoms, not argv tokens: splitQueryTerms splits on whitespace, so a term like
      // `<plain | !(plain)>` arrives as three tokens and the note machinery starts talking about `!(plain)>`,
      // a string the caller never typed (round 55 F-55-2). queryAtoms keeps a <...> group as one atom.
      trailingNotes += capAnswerNote(notOperatorNote(
        queryAtoms(query).atoms,
        query,
        regexRequested(asked, query) ? 0 : -1,
      ));
      // A top-level `|` splits the query into branches, and a scope term only limits its own branch, so
      // half the answer can come from every volume while the caller thinks it is scoped (orScopeNote).
      // Under `regex: true` the FIRST term is the engine's pattern and only that term's `|` is regex
      // alternation; a pipe among the remaining literal terms leaks exactly as usual (measured 2026-11-04:
      // `-regex "." -- ancestor:"…answertrim" | *.js` answered 310,464, the same count as the same query
      // with no regex at all). So the note stays live and the pattern term is named as the one join side
      // that cannot leak.
      trailingNotes += capAnswerNote(orScopeNote(query, regexRequested(asked, query) ? 0 : -1));
      // An alternative with NOTHING in it inside a <...> group is not a half-written scope, it is a
      // match-everything term, and the orphan machinery cannot see it at all: that pipe sits inside a group
      // (depth > 0), so no top-level pipe was orphaned and orScopeNote has nothing to report
      // (measured 2026-11-04: ancestor:"…zeroes" <a.dat |> answered 3 rows - the whole folder - where
      // ancestor:"…zeroes" <a.dat> answers 1). groupBranchNote is the only note that speaks for it.
      // A group whose alternative carries no scoping term is the sibling case: the answer is the UNION of the
      // alternatives, so a scoped alternative does not limit the unscoped one. The empty-alternative note wins
      // when both could apply, because an empty alternative matches everything.
      trailingNotes += capAnswerNote(
        groupBranchNote(query, regexRequested(asked, query) ? 0 : -1)
        || unscopedBranchNote(query, regexRequested(asked, query) ? 0 : -1));
      if (asked.totalSize) {
        // A total that did not answer is admitted, not hidden. Round 19 measured the LIST path
        // printing nothing while the count said "(total unknown)"; round 21 found the count_only path
        // still silent for every size failure, and found this sentence claiming a 15 s timeout even
        // when the size call had answered with an error. Both paths now build one sentence from
        // sizeSentence(), which names which failure it was.
        trailingNotes += capAnswerNote(
          sizeSentence({ bytes: totalBytes, note: list.totalSizeNote, count: total, query }));
      }
      // `order` without `sort` is accepted and silently inert (a direction reverses a sort that
      // is not there); named, never swallowed - the discipline count_only answers already apply.
      if (params.order && !params.sort) {
        trailingNotes += capAnswerNote(
          `\n[everything_search: order=${params.order} was accepted but changes nothing here - no ` +
          "`sort` was asked for, and a direction only reverses an existing order.]");
      }
      // `whole_word` in regex mode is that same shape: accepted, sent, and inert. Measured 2026-11-06 at
      // C:\tmp\esq82-fix (`alpha` in that folder): whole_word alone answered 1 row, `regex: true` alone
      // answered 2, and regex + whole_word answered the SAME 2 - and an in-query `regex:` term gave 2 with
      // and without whole_word alike, so it is regex mode that ignores the switch, not one spelling of it.
      // A caller who asked for a whole-word bound must not silently get the wider set.
      if (asked.wholeWord && regexRequested(asked, query)) {
        trailingNotes += capAnswerNote(
          "\n[everything_search: whole_word was accepted but changes nothing here - es.exe ignores " +
          "whole-word matching in regex mode (measured 2026-11-06 at C:\\tmp\\esq82-fix: `alpha` with " +
          "whole_word answered 1 row, with regex answered 2, and with both answered the same 2), so this " +
          "answer is NOT whole-word narrowed. Either drop `regex` and keep whole_word, or carry the bound " +
          "in the expression (`\\balpha\\b`).]");
      }
      // The three match-set sorts are priced on a count, so a query with NO askable count is never priced:
      // the sort runs and orders every match inside the 30 s list budget instead of being refused. Three doc
      // carriers say that hole exists; until now the answer itself never did - the caller saw only a short
      // page under a "total unknown" header. Measured 2026-11-06: `dc:2026-11-01` + sort=attributes answered
      // rows and printed no word about the sort it had let through unpriced.
      if (params.sort && PER_ENTRY_SORT_COLUMNS.includes(params.sort) && list.countSkippedTerm) {
        trailingNotes += capAnswerNote(
          `\n[everything_search: sort=${params.sort} was not priced for this query - no count was askable `
          + "(see `count_only`), so this answer may have ORDERED EVERY MATCH inside the list budget instead "
          + "of being refused. Narrow the query (`ext:`, `path:`, `ancestor:`) or drop the sort.]");
      }
      if (prep.escapeWarning) text = prep.escapeWarning + text;

      // Reserve the marker's bytes in the budget so the FINAL response
      // (content + marker) never exceeds MAX_OUTPUT_BYTES. truncateHead
      // never emits partial lines, so rows stay fully intact.
      // The notes that describe the whole answer are part of the FINAL response too, so their bytes
      // come out of the content budget before the rows are cut (same rule as the marker's reserve).
      // Round 120: every note is capped BEFORE its bytes leave the row budget (capAnswerNote at each of the
      // eleven LIST-answer sites, capNotesTotal here - case 211 pins that count). One note quoting a
      // 20,523-byte query put notesBytes at 21,446,
      // made the maxBytes below NEGATIVE, and the answer printed zero rows at 21,555 bytes.
      const notes = capNotesTotal(trailingNotes);
      const notesBytes = Buffer.byteLength(notes);
      const trunc = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: MAX_OUTPUT_BYTES - TRUNCATION_MARKER_RESERVE - notesBytes,
      });
      // After a byte/line cut the header must describe what RENDERED, not what was
      // asked for: an unrelabelled header reads as a promise the response does not keep
      // (observed 2026-11-04: "28,972 matching (showing 500)" above 187 lines).
      // Round 155 F-6: MEASURE the echo's height instead of guessing 1 - `stringParam` accepts a
      // query carrying a newline and the verbatim `query:` echo renders one row per break, which a
      // guessed constant would credit to the kept-content share.
      const echoText = lines.length > 0 ? boundedEcho(query) : "";
      const echoRows = 1 + (echoText.match(/\n/g)?.length ?? 0);
      // Round 189 F-2: prepareEsQuery CONCATENATES the escape warning with the aged-build/`-argv` warning
      // and each ends in a newline, so a query tripping BOTH prepends TWO lines while this credited one -
      // which made rowsKept, the relabelled header and this marker's row figure claim one row more than
      // the answer rendered. Count the newlines, the way echoRows above measures the echo's height. The
      // both-warnings shape is unreachable on this box (the second needs the -argv gate reading NO, and the
      // suite's aged stub cannot serve a list fetch, so no byte-cut page exists there): case 216 pins this
      // expression and both warning terminators.
      const warnLines = prep.escapeWarning ? (prep.escapeWarning.match(/\n/g)?.length ?? 0) : 0;
      const structural =
        warnLines +
        (lines.length > 0 ? 1 + echoRows + (detailsMode ? 1 : 0) : 0);
      const rowsKept = trunc.truncated
        ? Math.max(0, trunc.outputLines - structural)
        : lines.length;
      // The whole-answer notes go OUTSIDE the byte-budgeted content: a long page used to delete them,
      // because only the marker's bytes were reserved (measured 2026-11-04 - a page-cut answer that
      // also hit the 15 KB budget printed neither the `total size:` line nor the `[page cut short: …]`
      // note it had built).
      const outText = (trunc.truncated
        // One answer must not say "showing N" in two populations: the header N is ROWS (rowsKept)
        // and this marker's N was LINES, so the only arithmetic a caller could do looked like a loss
        // of the structural lines (round 169 F-2: header 148 against marker 151 of 303). Both figures
        // are printed now, so the 3-line difference is visible as what it is.
        // Round 189 F-1: the tail used to offer "lower limit/offset". Rendered rows are
        // min(limit, MAX_FETCH - offset), so LOWERING the offset can only GROW the page - the sibling
        // `[page cut short: …]` note names only levers that do work, and the two must not disagree.
        ? `${relabelShown(trunc.content, rowsKept)}\n[truncated at ` +
            `${trunc.truncatedBy === "bytes" ? `${MAX_OUTPUT_BYTES / 1024}KB` : `${trunc.maxLines} lines`}: ` +
            `showing ${trunc.outputLines} of ${trunc.totalLines} lines `
            + `(${rowsKept} of ${Math.max(0, trunc.totalLines - structural)} rows) — refine the query, `
            + "drop columns/details, or lower the limit]"
        : trunc.content) + notes;
      return {
        content: [{ type: "text", text: outText }],
        details: {
          query,
                    esQuery: prep.esQuery,
          total,
          shown: trunc.truncated ? rowsKept : lines.length,
          offset,
          withDetails: detailsMode,
          columns: extraCols,
          totalSizeBytes: totalBytes,
          totalSizeNote: list.totalSizeNote,
          countSkippedTerm: list.countSkippedTerm?.term ?? null,
          csvFallback: list.csvFallback,
          truncated: trunc.truncated,
          // Same key as the count_only answer's, empty here, so a caller can read it on every
          // everything_search response instead of guessing which shape ran.
          countOnlyIgnored: [],
        },
      };
    },
  });
  // ---- everything_grep ------------------------------------------------------

  pi.registerTool({
    name: "everything_grep",
    label: "Everything Grep",
    description:
      "Content search without the directory walk: candidate files selected instantly " +
      "from the Everything index via `query` (name/path/extension/size/date filters), " +
      "then scanned in-process. Output is byte-compatible with the grep tool " +
      "(LINE:HASH anchors, same headers, summary mode, truncation markers - the row shape, the anchor hash " +
      "and the 500-char cut were checked byte for byte against pi's grep; two divergences are deliberate: a " +
      "row names its file relative to the CALLER'S cwd (absolute when the file sits outside it) where pi " +
      "names it relative to its own search root, and the line-cap footer is always printed here even when the " +
      "match-limit marker already fired), " +
      "capped at 20 KB with the scan stopping when the budget is full " +
      "(unscanned candidates are reported in the marker); match lines over " +
      "500 chars render with a '... [truncated]' suffix, anchor hash stays " +
      "on the full line. PREFER " +
      "over grep whenever files can be scoped by name, path, extension, or date. " +
      "grep remains for pure content-only searches (no scoping clue) and " +
      "scope:'symbol'. Windows only.",
    promptSnippet:
      "Content search over an Everything-index file list — instant, no walk, grep-compatible output.",
    promptGuidelines: [
      "Content search with a name/path/type/date clue: use everything_grep (Everything picks the files, in-process scan, no walk).",
      "Plain grep: only for content-only search (no scoping clue) or scope:'symbol'.",
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "Pattern to find in file contents. JavaScript RegExp by default, applied to ONE " +
          "LINE at a time (so ^ and $ are line bounds); pass literal=true to match the text " +
          "exactly. Not ripgrep syntax, and each ripgrep-ism below is REFUSED rather than answered as " +
          "letters: (?i) (use ignoreCase), [[:alpha:]] (use [A-Za-z]), and the anchors \\A, \\z, \\Z, " +
          "\\G - patterns apply to ONE LINE at a time, so ^ and $ are the only anchors. \\p{L} works - " +
          "Unicode mode turns on by itself. Lookaround ((?=…), (?<!…)) and backreferences (\\1, " +
          "\\k<name> after its (?<name>…) group) DO work here — pi's builtin grep (ripgrep) refuses " +
          "both. Also refused, for the same reason: " +
          "\\b{start}, \\B{end}, \\N{…}, \\Q…\\E, an \\k<name> whose group is missing, a bare \\pL/\\P " +
          "with no brace, [a-b--c] " +
          "set difference. `\\u{41}` switches Unicode mode on and answers the character, as ripgrep " +
          "does; `\\x{41}` has no JavaScript spelling at all and is refused. Unicode mode is never a " +
          "flag you pass here - it is ours, and a rejection it causes now says so. This engine is NOT " +
          "everything_search's: that tool's `regex:true` hands the pattern to es.exe, whose grammar is " +
          "PCRE-family, so `[[:alpha:]]`, `\\p{L}`, `(?i:)`, `(?>…)`, `\\K`, `\\A` and `\\z` SELECT rows " +
          "there and are refused or read as literal letters here. " +
          `A pattern longer than ${MAX_PARAM_BYTES.toLocaleString("en-US")} bytes is refused: this tool never spawns with it, but ` +
          "every refusal echoes it back verbatim, and a regular expression that long is a mistake, not a search.",
      }),
      query: Type.Optional(
        Type.String({
          description:
            "Everything index query selecting the candidate files (same syntax as " +
            "everything_search; at most 2000 candidate files are selected and a larger set is "
            + "refused before any file is read - a query matching MORE ROWS than that is still answered "
            + "when its surplus rows are folders, because folder rows are never opened and are not charged "
            + "against the cap; a candidate over 2 MiB is skipped, and binary files are never searched). "
            + "Omit to search the current project directory " +
            '(ancestor:"<cwd>", excluding node_modules and .git). Those two are ' +
            "Everything PATH SUBSTRING tests, not folder names: any row whose path " +
            "merely CONTAINS one is skipped, so .gitignore, .gitattributes and " +
            ".github files are excluded as well (measured in one repo, files and folders " +
            "together: 547 rows outside node_modules fell to 383 once .git was excluded, " +
            "and of the file rows it dropped the only ones outside a .git folder were the " +
            "repo's three .gitignore files). An empty " +
            "answer may mean the file you wanted was out of scope - pass your own " +
            "query to decide the scope. Quote a value " +
            'that contains a space: ancestor:"C:\\Program Files", never ' +
            "ancestor:C:\\Program Files - an unquoted value ends at its first " +
            "space and the words are ANDed, so a spaced path matches nothing. " +
            'Examples: ext:ts ancestor:"C:\\proj" !path:node_modules; ' +
            "size:>10mb dm:today. " +
            `A query longer than ${MAX_PARAM_BYTES.toLocaleString("en-US")} bytes is refused before anything runs: es.exe is ` +
            "started with this text on its command line to pick the candidates.",
        }),
      ),
      ignoreCase: Type.Optional(
        Type.Boolean({ description: "Ignore case (default: case-sensitive)." }),
      ),
      literal: Type.Optional(
        Type.Boolean({
          description: "Treat pattern as a literal string, not a regular expression.",
        }),
      ),
      context: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Lines of context before and after each match (overlapping ranges " +
            "merge; a line that is both match and context renders as a match). No ceiling: " +
            "a large value prints whole files around every match, and it is the 20 KB answer " +
            "budget that stops the scan (and names what went unread), not a clamp here.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: GREP_MAX_LIMIT,
          description: `Max matches to return (default ${GREP_DEFAULT_LIMIT}, max ${GREP_MAX_LIMIT}). Both modes stop at this many MATCHES in total. Coverage has a SECOND ceiling - the answer's byte budget - and the two modes do not share it, because a printed row costs bytes a per-file count does not: measured 2026-11-05 with pattern "the" over pi's installed docs at limit 500, the full answer stopped on the 20 KB budget before spending its 500 matches and covered 11 files, while the summary answer spent all 500 and covered 16. To cover more files: raise this number, narrow the query or the pattern, or use summary mode - whichever ceiling stopped the scan is named in the answer.`,
        }),
      ),
      summary: Type.Optional(
        Type.Boolean({
          description:
            "Per-file match counts only (one line per file, count descending) — " +
            "no line content, no anchors. A count answer carries no rows, so a context value " +
            "is not applied to it — the output names that. The match limit still caps the total " +
            "MATCHES here, so a few files holding many matches crowd the other files out of the " +
            "counts (measured 2026-11-05: limit 100 over the 42 .md files of pi's installed docs " +
            "listed 3 of them; over a flat corpus the same limit covers the same files as a full " +
            "answer). A printed row costs bytes a count does not, so when the answer's byte budget is " +
            "what stopped a full answer, summary mode covers MORE files at the same limit.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pattern = stringParam("pattern", params.pattern, "pattern");
      if (!pattern) throw new Error("pattern must be a non-empty string");
      // Read ONCE, validated. pi passes tool parameters through without checking the schema (round 82),
      // and the raw truthiness below INVERTS intent when a caller writes a string: measured 2026-11-05,
      // pattern `b.t` with literal:"false" answered 0 matches (identical to literal:true) while literal
      // mode off answers 3, because "false" is a non-empty string. Same shape for summary and ignoreCase
      // (pattern ALPHA with ignoreCase:"false" answered 2 matches; ignoreCase:false answers 0).
      const literal = flagParam("literal", params.literal);
      const ignoreCaseOn = flagParam("ignoreCase", params.ignoreCase);
      const summaryMode = flagParam("summary", params.summary);
      // pi passes params through unvalidated (round 82), so everything_search's parameters can arrive
      // here too and do nothing; the suffix note beside the coverage note names them (round 92). Do
      // not write the shared list-runner's name in this region - .e2e-grep.mjs counts its mentions.
      const ignoredParams = SEARCH_ONLY_PARAMS.filter((k) => k in params);
      let re: RegExp;
      if (!literal) {
        const dialect = patternDialectReject(pattern);
        if (dialect) throw new Error(dialect);
      }
      const flags =
        (ignoreCaseOn ? "i" : "") +
        (!literal && patternNeedsUnicode(pattern) ? "u" : "");
      try {
        re = new RegExp(
          literal ? escapeForRegex(pattern) : pattern,
          flags,
        );
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        // \p{Greek} is ripgrep's lone-script spelling and JavaScript rejects it
        // (measured, node 24: "Invalid property name"), while \p{Script=Greek} and
        // \p{Lu} compile. The engine's own message never says which form it wants.
        const loneScript =
          /Invalid property name/.test(why) && /\\p\{[^{}=]*\}/.test(pattern);
        // ripgrep accepts possessive quantifiers and (mostly) atomic groups; JavaScript rejects
        // both with a message that does not name the construct (measured node 24: "Nothing to
        // repeat" for a*+, "Invalid group" for (?>a*). ripgrep 15.1: a*+ answers, (?>a*) refuses.
        const quantifier =
          (/Nothing to repeat/.test(why) && /[*+?]\+|\)\+/.test(pattern)) ||
          (/Invalid group/.test(why) && pattern.includes("(?>"));
        throw new Error(
          `Invalid pattern: ${pattern} — ${why}` +
            (literal
              ? ""
              : " — patterns are JavaScript RegExp, not ripgrep: there is no (?i) flag (use " +
                "ignoreCase), no [[:alpha:]] class (use [A-Za-z]); pass literal=true to search " +
                "this text exactly" +
                (loneScript
                  ? "; and a Unicode class wants the property form \\p{Script=Greek}, not the lone " +
                    "script name \\p{Greek}"
                  : "") +
                (quantifier
                  ? "; and a possessive (a*+) or atomic ((?>a*)) quantifier has no JavaScript spelling " +
                    "at all - drop the trailing + or the ?>"
                  : "") +
                (unicodeFlagIsOurs(pattern, flags)
                  ? "; and Unicode mode is ON here because this pattern holds \\p{...} or \\u{...} " +
                    "(that is what makes \\p{L} a letter class and \\u{41} the letter A) - the same " +
                    "pattern compiles WITHOUT that flag, so the escape the engine rejected is one " +
                    "Unicode mode disallows: write it without the backslash, or as [\\-] inside a class"
                  : "")),
        );
      }

      // Clamped like everything_search: an unbounded limit only enlarges the marker's
      // digit count (the scan stops on the output budget regardless), and the fixed
      // GREP_MARKER_RESERVE is sized for the digits a legal limit can produce. A value that is
      // not a number at all is REFUSED, not clamped: with the old Math.floor the NaN reached
      // `totalMatches >= effectiveLimit`, which is false for every count, so the match ceiling
      // silently switched OFF (measured 2026-11-05), and a NaN `context` made the renderer print
      // the "[3 matches in 3 files]" header and NOT ONE match line - a whole answer, lost.
      const effectiveLimit = intParam("limit", params.limit, GREP_DEFAULT_LIMIT, 1, GREP_MAX_LIMIT);
      const context = intParam("context", params.context, 0, 0, WHOLE_NUMBER_MAX);
      const cwd = ctx?.cwd ?? process.cwd();
      // Optional parameter: omitted or null still means "search the cwd" (the documented default, round 83).
      // Anything that IS there must be a string - `query:5` died as "params.query?.trim is not a function".
      const userQuery =
        params.query === undefined || params.query === null
          ? ""
          : stringParam("query", params.query).trim();
      // The cwd is quoted: a spaced working directory must stay ONE function
      // value, or splitQueryTerms would AND its words and silently change the
      // candidate set (the exact failure this extension exists to avoid).
      const esQuery =
        userQuery || `ancestor:"${cwd}" !path:node_modules !path:.git`;

      const list = await fetchEsList({
        query: esQuery,
        fetchCount: MAX_CANDIDATE_FILES + 1,
        detailsMode: false,
        extraCols: [],
        signal,
      });
      // Round 94 F-94-2: the cap branch below may replace the candidate list (folder rows are not charged
      // against a cap that bounds the scan), so the list every later reader uses is named once here.
      let candidateList = list;
      let capRescue = "";
      // Round 117: the three counts the cap rescue measured, kept for the answer shapes that return
      // BEFORE the cap note is pushed (the zero-candidate and single-binary early returns), which until
      // then had no way to say a rescue happened at all.
      let rescueInfo: { rows: number; folders: number; files: number; countsKnown: boolean } | null = null;

      if (
        (list.total != null && list.total > MAX_CANDIDATE_FILES) ||
        list.lines.length > MAX_CANDIDATE_FILES
      ) {
        // Round 94 F-94-2: this cap bounds the SCAN, so it may only be charged against rows the tool can
        // open. es.exe answers FOLDER rows too (round 93: `size:>1gb` = 1,126 rows, 662 of them folders), a
        // folder candidate is classified `skippedDir` and never opened, and charging one for the cap
        // withheld an answer this tool could give: measured 2026-11-05, ancestor:"E:\basalt" matched 2,924
        // rows of which 1,192 are folders - 1,732 files, inside the 2,000-file cap - and the call refused.
        // One extra COUNT settles the population (every `attributes:d` and `!attributes:d` count measured
        // here answered in under 50 ms, at fixture and whole-index scale alike), and the re-fetch below is
        // the same list call with one more term. Every call that never tripped the cap keeps its normal
        // esQuery, so `details.esQuery` still echoes the caller's query, and `skippedDir` keeps its meaning
        // for any row that does reach the scan.
        // Round 119 F-119-1: every question below APPENDS a term, so each one has to be asked of the query that
        // actually RAN. A `|` whose EMPTY SIDE is the end of the query takes an appended term as its other side
        // instead of deleting its neighbour, so appending changes the population being counted (measured
        // 2026-11-05 on C:\tmp\esq119-fix\max94 - 2,048 rows, 100 folders, 1,948 files: the caller's
        // `ancestor:"…" ext:txt |` ran as `ancestor:"…"`, and its folder probe
        // `ancestor:"…" ext:txt | attributes:d` answered 2,045 - txt UNION folders - where the honest folder
        // count for that population is 100; the answer then claimed "3 file rows" for a candidate list its own
        // never-read note counted at 1,948, and details.candidatesTotal came back null). A pipe with BOTH sides
        // filled does NOT capture an appended term (`… attributes:d | ext:txt !attributes:d` = 1,945, the same
        // as the grouped spelling `<…> !attributes:d`), so only the dangling pipe needs resolving, and
        // `orphanPipeReport`'s `rest` IS the text es.exe ran. When the resolution deletes EVERYTHING (a pipe
        // cascade that leaves no term) the RESCUE is skipped - the rows `list` already holds ARE the whole
        // index - and the refusal below says so with the orphan hint beside it.
        const capBase = (orphanPipeReport(esQuery, -1)?.rest ?? esQuery).trim();
        // An EMPTY capBase means the cascade deleted every term, so NOTHING narrowed the list this cap is
        // measuring - the population is the whole index and `attributes:d` alone counts its folders honestly.
        // The rescue below stays gated on a non-empty base: re-selecting candidates for an empty query would
        // ask es.exe for the whole index.
        const folderProbeQuery = capBase === "" ? "attributes:d" : `${capBase} attributes:d`;
        const probe = await runEs(
          ["-get-result-count", ...termArgs([], splitQueryTerms(folderProbeQuery))],
          signal,
          COUNT_TIMEOUT_MS,
        );
        if (probe.aborted) throw new Error(esFailureMessage(probe, esQuery, -1));
        const folderRows: number | null =
          probe.code === 0 && !probe.spawnError && !probe.timedOut
            ? parseCountAnswer(probe.stdout.toString("utf-8").trim())
            : null;
        const matchedRows = list.total ?? list.lines.length;
        const fileRows = folderRows == null ? null : matchedRows - folderRows;
        // F-194-7: hoisted out of the `else` branch, because BOTH cap refusals need it - a caller whose
        // `ancestor:` was deleted by a dangling `|` has to hear it whichever figure refused them, and the
        // F-118-2 refusal used to be the one cap refusal with no orphan hint while its advice census still
        // credited that deleted term as applied.
        // Round 56: an orphan "|" in a grep `query` silently drops the term beside the empty side, and the
        // term that drops out is usually the caller's scope, so the bare "narrow the query" advice sends
        // people to add an ancestor: they had already typed (measured 2026-11-04: query
        // `ancestor:"…answertrim" |` tripped the cap at 3,777,858 candidates = the whole index, where the
        // same query with no pipe selects 405).
        // Round 58: the sentence names WHICH terms es.exe deleted, because the singular "the term beside the
        // empty side" covered up a cascade - `| ancestor:"…answertrim" | *.bin` deleted TWO terms and left
        // nothing, which is why its candidate count was 3,777,923 (measured 2026-11-04).
        const orphanSentence = orphanDropSentence(esQuery);
        const orphanHint = orphanSentence
          ? ` And: ${orphanSentence} Delete the "|" and retry.`
          : "";
        if (capBase !== "" && fileRows != null && fileRows <= MAX_CANDIDATE_FILES) {
          candidateList = await fetchEsList({
            query: `${capBase} !attributes:d`,
            fetchCount: MAX_CANDIDATE_FILES + 1,
            detailsMode: false,
            extraCols: [],
            signal,
          });
          // F-118-2: the `+1` on this second fetch is there for the same reason it is on the first - a list
          // that still does not fit the cap has to REFUSE, not answer off a page that `slice` then trims in
          // silence. The arithmetic just above can say "fits" while the list it predicts does not:
          // `matchedRows` and `folderRows` are TWO separate es.exe counts of a live index (this box gains
          // ~10 rows a minute), and when the row count did not answer at all `matchedRows` is only the first
          // fetch's page length. Nothing else in this function ever looks at the narrowed list's size.
          if (
            (candidateList.total != null && candidateList.total > MAX_CANDIDATE_FILES) ||
            candidateList.lines.length > MAX_CANDIDATE_FILES
          ) {
            const narrowedRows = candidateList.total ?? candidateList.lines.length;
            // F-194-1: when this second fetch's OWN count did not answer, `narrowedRows` is the FETCH CEILING
            // (this call asks for MAX+1 rows), not a file count, and nothing else in the call ever asked a
            // files-only count - so there is no file figure to print. Driven 2026-11-07 with query
            // "da:2026-11-07": this branch printed "still selects 2,001 files ... the file-only count is the
            // one that decides" for a query whose files-only count this same tool refuses to ask
            // (`No count asked for: da:2026-11-07 !attributes:d`, details.countSkippedTerm "da:"). A
            // non-indexed scan also fills incrementally, so that page length tracks the fetch size rather
            // than the index. The unknown state prints a floor and drops the claim it cannot keep.
            const fetchCeiling = (MAX_CANDIDATE_FILES + 1).toLocaleString("en-US");
            throw new Error(
              `Candidate cap: after dropping folder rows the query still selects ` +
              (candidateList.total != null
                ? `${narrowedRows.toLocaleString("en-US")} files, over the ` +
                  `${MAX_CANDIDATE_FILES}-file cap - the file-only count is the one that decides, since ` +
                  "folder rows are never opened and the raw row count could not settle it - and " +
                  `answering anyway would cut the scan short without saying which files the answer missed. `
                : `more than ${fetchCeiling} FILE rows - this answer's narrowed list fetch stopped at its ` +
                  `${fetchCeiling}-row ceiling and this query's file-only count is not askable, so the true ` +
                  "population is at least that high and no file-only count exists anywhere in this call. ") +
              narrowTheQueryAdvice(capBase) + orphanHint,
            );
          }
          // F-179-1: the file figure is the RE-FETCHED list's own count - the population this scan walks and
          // what details.candidatesTotal reports - not `matchedRows - folderRows`, which is the difference of
          // TWO EARLIER counts of a live index. The row and folder figures still come from those calls
          // (nothing else can produce them); when the difference and the narrowed count disagree, the note
          // says so in the open instead of printing arithmetic that does not add.
          // F-194-2 adds the other half: when the NARROWED count is not askable at all, `narrowedFiles` IS
          // `fileRows` by construction, so the agreeing wording would print a difference under the promise
          // that this is the re-fetched list's own count - the figure the README says `details.candidatesTotal`
          // reports, which on that shape is null. Same trap one branch earlier: when the ROW count did not
          // answer, `matchedRows` is this answer's own page length, so it prints as a floor.
          const narrowedFiles = candidateList.total ?? fileRows;
          capRescue =
            (list.total != null
              ? `the query matched ${matchedRows.toLocaleString("en-US")} rows`
              : `the query matched at least ${(MAX_CANDIDATE_FILES + 1).toLocaleString("en-US")} rows (this ` +
                `answer's row fetch stops at that ceiling, so its row figure is a floor, not a count)`) +
            // F-195-04: "N of them" is a partitive, so it only holds when the row figure above is a COUNT. In
            // the no-row-count state that figure is this answer's fetch floor, and a whole-population folder
            // count can sit ABOVE it (a 2,001-row floor beside a folder probe of 99,854), so the folder number
            // prints as its own count and says why it does not fit inside the floor.
            `, over the ${MAX_CANDIDATE_FILES}-file cap, because ` +
            (list.total != null
              ? `${folderRows!.toLocaleString("en-US")} of them ` +
                // F-194-3: the family inflects everywhere else (`1 folder row`, `1 candidate file NOT searched`);
                // driven 2026-11-07, a 2,000-file + 1-folder scope printed "1 of them are folder rows".
                `${folderRows === 1 ? "is a folder row" : "are folder rows"}`
              : `the folder probe for this query counts ` +
                `${folderRows!.toLocaleString("en-US")} folder rows (its own count over the whole population, ` +
                `so it can exceed the row floor above, which is a fetch ceiling)`) +
            "; grep never opens those, so " +
            (candidateList.total != null
              ? `this answer's candidate list is the ${narrowedFiles.toLocaleString("en-US")} file ` +
                `row${narrowedFiles === 1 ? "" : "s"}` +
                (narrowedFiles === fileRows
                  ? ""
                  : ` (the narrowed list's own count; the row and folder figures above came from two earlier `
                    + `counts of a live index, whose difference is ${fileRows.toLocaleString("en-US")})`)
              : `this answer's candidate list is FILE rows only, and this query's file-only count is not ` +
                `askable (details.candidatesTotal is null), so no file figure is claimed here`) +
            `. Candidate list: ${capBase} !attributes:d`;
          rescueInfo = {
            rows: matchedRows,
            folders: folderRows!,
            files: narrowedFiles,
            countsKnown: list.total != null && candidateList.total != null,
          };
        } else {
          throw new Error(
            // The figure and its label are chosen together by `capRefusalFigure`: the FILE rows when the
            // folder probe answered, honest ROWS when it did not (round 179 F-179-2: labelling a row count
            // "files" over-claimed, because the folders inside it are not charged against this cap). The
            // folders the query also matched are counted in the sentence below instead of inflating this one.
            // F-195-01: `fileRows` is `matchedRows - folderRows` and `matchedRows` falls back to THIS ANSWER'S
            // PAGE LENGTH when the row count did not answer, so beside a whole-population folder count it is a
            // page floor minus a population - not a file count, and it can go negative. Only a real row count
            // makes it a figure this refusal may label "files".
            `Candidate cap: the query matched ${capRefusalFigure(list.total == null ? null : fileRows, list.total)}, over the ` +
            `${MAX_CANDIDATE_FILES}-file cap. ` +
              // The quoting advice used to be appended here unconditionally, and it sent agents fixing
              // something that was already right: measured 2026-11-04 on
              // ancestor:"C:/Users/<you>/AppData/Roaming/npm" ext:js (18,483 files, quoted correctly).
              // An UNQUOTED spaced function value scopes to one word, which makes a result set SMALLER, so
              // it can never be the reason a query matched too many files. prepareEsQuery warns about it
              // on the old es.exe where it is a false zero; that is its home, not a cap refusal.
              (folderRows == null || folderRows === 0
                ? ""
                // F-194-3: a 2,001-row population can hold exactly ONE folder, and this clause read
                // "1 of the matched rows are folders" (driven 2026-11-07, C:\tmp\esq194-fix\onefolder).
                : (list.total == null
                    // F-195-04: with no row count the subtraction below is a page length minus a whole-index
                    // folder count (measured on a `da:`-scoped scope: a 2,001-row fetch floor beside a folder
                    // probe of 99,854), which prints a NEGATIVE "files are". The probe's own count is the only
                    // honest figure here, and no file figure is claimed.
                    ? `${folderRows.toLocaleString("en-US")} of this query's rows ` +
                      (folderRows === 1 ? "is a folder," : "are folders,") +
                      " which grep never opens and does not count against the cap; the row figure above is a " +
                      "fetch floor, this query's file-only count did not answer, so no file figure is claimed. "
                    : `${folderRows.toLocaleString("en-US")} of the matched rows ` +
                      // Only the count noun inflects. The relative clause's subject is GREP ("grep never opens
                      // them and does not count them against the cap"), so `does` never becomes `do` - the first
                      // draft of this fix inflected it and case 78's pin refused it.
                      (folderRows === 1 ? "is a folder," : "are folders,") +
                      ` which grep never opens and does not count against the cap; ` +
                      `${fileRows!.toLocaleString("en-US")} files are. `)) +
              // F-194-7: round 119's rule is that every question about this population is asked of the text
              // es.exe ran, so the narrowing census reads `capBase` - a dangling `|` may have deleted one of
              // the four from the string the caller typed, and the caller must not be told it is applied.
              narrowTheQueryAdvice(capBase) + orphanHint,
          );
        }
      }
      const candidates = candidateList.lines.slice(0, MAX_CANDIDATE_FILES);

      if (candidates.length === 0) {
        const orphanZero = orphanDropSentence(esQuery);
        return {
          content: [
            {
              type: "text",
              // pi parity stays the FIRST line; the note (one helper shared with everything_search,
              // round 17) says these files were never candidates, so "0 matches" is not an answer
              // about their contents.
              text: `[0 matches in 0 files]` +
                // Round 152 F-13: the escape-operator guard lives in the shared list pipeline, so a
                // grep `query` holding `\ext:ts` gets this same false zero - the warning rides along
                // after the parity line, which must stay first.
                (candidateList.escapeWarning ? "\n" + candidateList.escapeWarning.trimEnd() : "") +
                // Round 117 F-117-2: when the cap rescue re-selected the candidate list as FILES only and
                // that list came back empty, every row the query matched was a FOLDER row. "the Everything
                // query selected 0 candidate files" was then false (measured 2026-11-05: `attributes:d size:>1mb`
                // = 36,931 rows, 0 of them files; 36,434 the same way on 2026-11-07 - the answer claimed zero candidates and no cap note, while
                // the same folders at 100 rows got the all-directory note from the main return path).
                "\n[everything_grep: " +
                // F-195-04: this gate is chosen from what the FETCH showed as well as from the derived count.
                // `rescueInfo.files` is `candidateList.total ?? fileRows`, and `fileRows` can be negative in the
                // no-row-count state, which used to miss this gate and print the generic zero for a scope whose
                // every row is a folder. F-195-02: when no count answered for this shape's population either, a
                // zero is a property of the FETCH, not of the query, and the note says only that.
                (rescueInfo !== null && (candidateList.lines.length === 0 || rescueInfo.files === 0)
                  ? (rescueInfo.countsKnown
                      ? `the query selected ${rescueInfo.rows.toLocaleString("en-US")} rows and every one of ` +
                        `them is a folder row, which this tool never opens (the candidate list was re-selected ` +
                        `as files only after the row count passed the ${MAX_CANDIDATE_FILES}-file cap), so no ` +
                        "file was openable - "
                      // F-194-2: with either count unaskable that arithmetic is not a count of the
                      // population, so this shape claims only what it actually fetched: an empty files-only list.
                      // F-195-04: the folder probe is one count this call DID get - the rescue gate cannot be
                      // reached without it - so the note names the folders it found instead of leaving only a
                      // fetch failure, and still claims no row total.
                      : "the candidate list this tool re-selected as FILES only came back empty, " +
                        `the folder probe for this query counts ${rescueInfo.folders.toLocaleString("en-US")} ` +
                        `folder row${rescueInfo.folders === 1 ? "" : "s"}, and the counts for this query are ` +
                        "not askable, so this answer cannot say how many rows the query held - ")
                  : candidateList.total == null
                    // Round 199 F-199-02: `everything_search`'s zero page names the term whose count was never
                    // asked (round 198); this answer named neither term nor reason for the SAME state on the
                    // SAME query - `orientation:>1 ext:mjs` printed the term on one tool and nothing here
                    // (C:/tmp/esq199/out199b.txt). `fetchEsList` already hands every caller the skip, so name
                    // it. A null `candidatesTotal` has two routes, so this splits the way `buildResultText`'s
                    // header splits: a count this call refused to ask, and a count that was asked and did not
                    // answer. Round 199 never met the second one; round 200 did, with a pattern no file holds over
                    // `orientation:>1 ext:json`: `candidatesTotal: null` and this sentence at 15,162 and 15,164 ms
                    // of three runs (84,237 entries fitted the 88,235 that `orientation:`'s THEN-170 us lease bought,
                    // and the count then overran the 15 s leash; the third run's count answered at 12,025 ms and took
                    // the counted-zero arm). Round 203's 600 us `orientation:` rate closes THAT route - a partner that
                    // size is skipped before it is asked. Which side a run lands on is cache warmth, so the suite welds the
                    // invariant rather than a fixed shape. It stays the shorter sentence.
                    ? "the candidate list this fetch returned came back empty and " +
                      (candidateList.countSkippedTerm
                        ? `no count was asked for this query: \`${candidateList.countSkippedTerm.term}\` is a ` +
                          "value this index answers only by testing every entry, and this call did not count "
                          + "it, "
                        : "no count answered for this query, ") +
                      "so this answer cannot say how many candidate files the query selected - "
                    : "the Everything query selected 0 candidate files, so no file was opened - ") +
                "this answer says nothing about any file's contents. " +
                (userQuery
                  ? "Run everything_search with the same query to see what it selects; " +
                    "everything_syntax lists the scope terms (ext:, path:, ancestor:, parent:).]"
                  : // Round 52 F-52-1: with no `query` (or a blank one) the scope was the working-directory
                    // default, so "the same query" named something the caller never typed and could not
                    // retype. Measured through execute() with a ctx naming an empty folder: this branch IS
                    // reachable without a query, and esQuery holds the scope that actually ran.
                    // F-117-3: verbatim, like `defaultScopeNote` - the answer must show the query that ran,
                    // not a JSON-escaped spelling of it (a pasted `\"` form answers 0).
                    "No query was given, so the scope was this working directory: " +
                    `${boundedEcho(esQuery)}. Those two exclusions are Everything PATH SUBSTRING ` +
                    "tests, not folder names, so a row whose path merely CONTAINS either string is out of " +
                    "the set - a .gitignore file anywhere is excluded, which is how a directory holding " +
                    "rows can still select zero candidates. Pass query: to widen it; everything_syntax " +
                    "lists the scope terms (ext:, path:, ancestor:, parent:).]") +
                (orphanZero === "" ? "" : capAnswerNote(`\n[everything_grep: ${orphanZero}]`)) +
                capAnswerNote(backslashRootNote(esQuery)) +
                (queryAsksRegex(esQuery)
                  ? ""
                  : // Round 52 F-52-3: `(` `)` in a regex query are regex groups, so this hint is a claim
                    // about which grammar ran. everything_grep has NO `regex` parameter (measured: a call
                    // passing regex:true ignored it and esQuery came back "(zzznope52)"), so the reachable
                    // spelling here is the in-query `regex:` function - and neither this branch nor
                    // noResultsText tested it, so `regex:(plain)` was told Everything has no grouping
                    // operator. Round 50 tested the flag spelling only.
                    capAnswerNote(parenZeroNote(esQuery, "everything_grep"))),
            },
          ],
          // The SAME key set every other answer this tool gives carries, so a caller that
          // reads details.candidatesTotal blind never gets undefined. Every counter here is 0 because nothing
          // was FETCHED, and the skip-accounting sum (scanned + notScanned + the four skip buckets + dir =
          // total) closes wherever a count answered. Round 199 F-199-01 struck the same "zero is the honest
          // value" shortcut from `candidatesTotal` alone: hardcoding 0 there let the printed note say "this
          // answer cannot say how many candidate files the query selected" while the machine-readable field
          // asserted that zero - the false zero this project hunts, on the channel a model does not see. The
          // field is the count call's reply, so it is null exactly when that call was never asked or did not
          // answer, which is the fact the note beside it names and the README's identity discounts.
          details: {
            pattern,
            query: userQuery === "" ? null : userQuery,
            esQuery: candidateList.esQuery,
            candidatesTotal: candidateList.total,
            candidatesScanned: 0,
            candidatesNotScanned: 0,
            matches: 0,
            files: 0,
            skippedBinary: 0,
            skippedMissing: 0,
            skippedUnreadable: 0,
            skippedDir: 0,
            skippedBig: 0,
            perFileCapApplied: false,
            budgetStopped: false,
            answerCapTrimmedFiles: 0,
            answerCapTrimmedLines: 0,
            budgetCutLines: 0,
            budgetDroppedGroups: 0,
          },
        };
      }

      // In-process scan + budget-aware render (synchronous): files are read in
      // candidate order and each matching file is rendered as soon as it is
      // scanned, so the scan stops the moment the output budget or the match
      // limit is full — later files stay unscanned (no wasted I/O, no post-hoc
      // cut). Rendered lines are always whole (head-first, like truncateHead).
      interface GrepCandidate {
        abs: string;
        lines: string[] | null;
        matches: number[]; // 1-based line numbers
        status: "unscanned" | "ok" | "binary" | "missing" | "unreadable" | "big" | "dir";
        transcoded: boolean; // text came from a UTF-16 transcode - see the render site
      }
      const files: GrepCandidate[] = candidates.map((abs) => ({
        abs,
        lines: null,
        matches: [],
        status: "unscanned" as const,
        transcoded: false,
      }));
      let skippedBinary = 0;
      let skippedMissing = 0;
      let skippedBig = 0;
      let totalMatches = 0;
      let stop = false;
      let budgetStopped = false;
      let perFileCapApplied = false;
      let anyLineTruncated = false;

      // summaryMode, literal and ignoreCaseOn were read and validated at the top of this execute().
      const groupBlocks: string[][] = []; // rendered lines per matching file
      let renderedBytes = 0;
      // Lines of the LAST group the byte budget could not fit (includes a "... +N more
      // matches" note if that was the line cut) - the budget marker names this explicitly.
      let budgetCutLines = 0;
      // Whole groups dropped because only their header line fit (see renderFile): a file with matches
      // that is inside `files` but printed nowhere, so it has to be counted or the answer cannot close.
      let budgetDroppedGroups = 0;
      // The header ("[N matches in M files]") is emitted after the scan, so
      // reserve room for it up front; GREP_MARKER_RESERVE covers the worst
      // case of the suffix markers (limit + line-cap footer + budget stop).
      const HEADER_RESERVE = 40;
      const budget = GREP_OUTPUT_MAX_BYTES - GREP_MARKER_RESERVE - HEADER_RESERVE;
      const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

      // Render one scanned file's group (head-first, whole lines only).
      // Returns true when the output budget was hit — the scan must stop.
      const renderFile = (f: GrepCandidate, applyCap: boolean): boolean => {
        if (summaryMode) return false;
        const group: GrepRenderGroup = {
          displayPath: displayPathFor(f.abs, cwd),
          absolutePath: f.abs,
          matchCount: f.matches.length,
          lines: f.lines,
          transcoded: f.transcoded,
          matches: f.matches,
        };
        const { lines: entries, truncated: entryFlags } = renderGrepGroupEntries(
          group,
          context,
          applyCap,
        );
        const groupLines = [
          `--- ${group.displayPath} (${group.matchCount} matches) ---`,
          ...entries,
        ];
        const lineFlags = [false, ...entryFlags]; // parallel to groupLines
        const kept: string[] = [];
        let b = 0;
      let hitBudget = false;
      let cutHere = 0;
      for (let i = 0; i < groupLines.length; i++) {
        const nb = b + byteLen(groupLines[i]) + 1;
        if (renderedBytes + nb > budget) {
          hitBudget = true;
          cutHere = Math.max(0, groupLines.length - i);
          break;
        }
        kept.push(groupLines[i]);
        b += byteLen(groupLines[i]) + 1;
        if (lineFlags[i]) anyLineTruncated = true;
      }
      // A byte cut can stop a block immediately AFTER a `--` separator, which prints a separator with
      // nothing after it. pi renders `--` only BETWEEN two runs of lines and never emits a trailing one, and
      // a dangling one is worse than cosmetic: it reads as "content elided here". Measured 2026-11-04 on the
      // notecorpus fixture at context 0: the last printed group held rows 1,4,7,10,13 plus FIVE separators,
      // the fifth dangling above the blank line that precedes the budget marker. Trailing separators go back
      // to the cut count, so rendered + cut still accounts for every line the group held (that group holds
      // 22 lines: header + 10 rows + 10 separators + the one `... +K more matches` note the cut swallows).
      while (kept.length > 1 && kept[kept.length - 1] === "--") {
        kept.pop();
        b -= byteLen("--") + 1;
        cutHere++;
      }
      // A group that kept only its HEADER line would print
      // "--- file (22 matches) ---" with no rows beneath it - pi never renders such a
      // group (its per-file cap always leaves a "... +N more matches" note), so drop it
      // and do not charge its bytes; the next file gets the room instead. fileCount
      // stays a PRE-cap files-with-matches count; README's grep contract says so.
      // Measured 2026-11-04 (limit:300 over the 405-file answertrim fixture) such a group WAS dropped
      // and named nowhere: the answer led with "[112 matches in 112 files]" while printed groups (109)
      // plus details.answerCapTrimmedFiles (2) came to 111, and the only clue was "1 rendered line cut
      // from the last file" - a file that IS printed. So a dropped group is counted, and its lines are
      // NOT charged to budgetCutLines, which means "cut from a group you can see".
      if (kept.length > 1) {
        groupBlocks.push(kept);
        renderedBytes += b;
        budgetCutLines = cutHere;
      } else if (hitBudget) {
        budgetDroppedGroups++;
      }
        return hitBudget;
      };

      // runningMatches = matches found in files BEFORE the current one. The
      // per-file cap (10/file) applies to a file when the total INCLUDING its own
      // matches exceeds 50. DELIBERATE deviation from pi's truncateGrepIR, which gates
      // GLOBALLY on the finished total and then caps every file: it truncates a result it
      // already holds, while we stream and stop on budget, so the decision must be made
      // per file at render time. README design decision 6; a round-6 review filed this as
      // a defect and the decision was reaffirmed (2026-11-04) - do not "fix" it back.
      let runningMatches = 0;
      // CANCELLATION: this loop is SYNCHRONOUS, so an AbortSignal cannot flip while it runs - a per-file
      // `signal?.aborted` check here would be dead code, because nothing can set the flag until this block
      // yields, and it never does. The signal is honoured at the one real boundary instead: `runEs` refuses to
      // spawn the candidate fetch when the signal is already aborted and kills the child when it aborts later
      // (suite case 112 pins that). What bounds an un-cancelled scan are this loop's own caps - 2,000 files,
      // 2 MiB each, the 20 KB output budget (6-30 s worst legal, round 79's measurement).
      for (let i = 0; i < files.length && !stop; i++) {
        const f = files[i];
        // Size gate BEFORE the read: MAX_GREP_FILE_BYTES must keep an oversized
        // file out of memory, not merely out of the scan.
        try {
          const st = statSync(f.abs);
          // A directory is not a searchable file. Everything's index contains folders, and
          // readFileSync on one throws EISDIR, which used to land in the could-not-be-read bucket
          // and tell the agent the wrong reason (measured 2026-11-04: the folder
          // everything-search/settings-screenshots was reported as locked or access denied). pi's
          // grep is never handed a directory, so folders are skipped here without a note.
          if (st.isDirectory()) {
            f.status = "dir";
            continue;
          }
          // Size gate BEFORE the read: MAX_GREP_FILE_BYTES must keep an oversized
          // file out of memory, not merely out of the scan.
          if (st.size > MAX_GREP_FILE_BYTES) {
            f.status = "big";
            skippedBig++;
            continue;
          }
        } catch (statErr) {
          // statSync itself failed - but this catch sees THREE shapes, because statSync follows links: an
          // index row whose path is really gone, and a LINK row whose TARGET is gone. lstatSync does not
          // follow the link, so it tells them apart. Measured 2026-11-05 on the suite's own fixture:
          // Everything holds `linkcorpus\deadlink` as a DIRECTORY row (`attributes:d` matches it, its
          // attribute letters render `DLI`) while statSync answers ENOENT and lstatSync answers a
          // symbolic link of 45 bytes. Without the second look the row landed in `missing`, so the skip
          // note called a FOLDER row "1 candidate file NOT searched - indexed but no longer on disk":
          // the same wrong-reason class as the EISDIR case above, and flatly against this tool's own
          // rule that FOLDERS never appear in that note. A link to a FILE would take this branch too and
          // is never opened either; an unprivileged file symlink is EPERM here (round 90), so only
          // folder links are measurable on this box. What the second look cannot settle is settled below
          // by the error code the stat call actually returned, never by the assumption that a failed
          // stat means a missing file.
          let linkRow = false;
          try {
            const lst = lstatSync(f.abs);
            linkRow = lst.isSymbolicLink() || lst.isDirectory();
          } catch { /* no lstat either - the stat error's own code decides below */ }
          if (linkRow) {
            f.status = "dir";
            continue;
          }
          // A row lstat cannot see is stale ONLY if the OS said it is not there. Measured 2026-11-06 on
          // C:\Windows\System32\config: statSync AND lstatSync both answer EPERM across that protected
          // tree, and 230 rows there - `_Channels` among them, a directory whose own children are still
          // indexed - were reported as "indexed but no longer on disk", an existence claim the OS never
          // made. ENOENT is the stale shape; any other code is a read this OS refused, which is exactly
          // what `unreadable` and the note's "(locked or access denied)" mean. A row whose stat is refused
          // has no type known to this tool, so it is also the one shape that can put a folder row in the
          // note - the skip-note bullet and decision 9 carry that exception.
          const statCode = (statErr as NodeJS.ErrnoException)?.code;
          if (statCode && statCode !== "ENOENT") {
            f.status = "unreadable";
            continue;
          }
          f.status = "missing";
          skippedMissing++;
          continue;
        }
        let buf: Buffer;
        try {
          buf = readFileSync(f.abs);
        } catch (readErr) {
          // Two shapes share this catch, and the skip note must not conflate them. A file that
          // was present for the statSync a moment ago and is ENOENT here was DELETED inside this
          // loop (measured 2026-11-06: 18 and 17 candidates in one scan each, with a deleter
          // running concurrently): it belongs with the stale index rows, because "locked or access
          // denied" is a reason it never had. Anything else - an exclusive handle, a permission
          // denial - is genuinely unreadable, and we keep scanning the rest (pi's grep aborts the
          // whole root here).
          if ((readErr as NodeJS.ErrnoException)?.code === "ENOENT") {
            f.status = "missing";
            skippedMissing++;
            continue;
          }
          f.status = "unreadable";
          continue;
        }
        // Text-vs-binary and decoding follow pi's SCAN engine (NUL-based, UTF-16 BOM
        // honoured, invalid UTF-8 tolerated as replacement chars), not pi's single-target
        // warning rule - see decodeForScan in grep-core.ts for the measurements. Using the
        // warning rule here instead silently skipped 4 of 8 encodings pi finds (round 9 R-1/R-2).
        const dec = decodeForScan(buf);
        if (dec.kind === "binary") {
          f.status = "binary";
          skippedBinary++;
          continue;
        }
        const lines = dec.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        // A summary grep never renders (renderFile returns at its first line), so NOTHING ever reads a summary
        // call's stored lines - and because a summary call renders no bytes, the output budget that normally stops
        // the scan never fills, so every matching candidate's full content stayed live to the end of the call with
        // no bound but the 2,000-file cap. Store content only when there is a renderer that will use it.
        f.lines = summaryMode ? [] : lines;
        f.status = "ok";
        f.transcoded = dec.transcoded;
        for (let li = 0; li < lines.length; li++) {
          if (re.test(lines[li])) {
            f.matches.push(li + 1);
            totalMatches++;
            if (totalMatches >= effectiveLimit) {
              stop = true;
              break;
            }
          }
        }
        if (f.matches.length > 0) {
          const applyCap =
            runningMatches + f.matches.length > GREP_TRUNCATION_THRESHOLD;
          // Summary mode runs none of that machinery: `renderFile` returns at its first line there and
          // `f.lines` is left empty, so a crossed running-total line drops nothing. The flag therefore
          // belongs to the grouped render only - the same reason a trimmed summary reports no dropped
          // groups and no cut lines (case 50). Without `!summaryMode` every summary answer past the
          // threshold claimed a cap it never applied.
          if (applyCap && !summaryMode) perFileCapApplied = true;
          if (renderFile(f, applyCap)) {
            stop = true;
            budgetStopped = true;
          }
          runningMatches += f.matches.length;
          // Round 79: renderFile has already taken every line it wants out of this file (it reads `f.lines` once,
          // through renderGrepGroupEntries), and nothing after this loop reads it - the post-loop accounting uses
          // `f.status` only. Release it here exactly as the no-match branch below does, so the call's peak is ONE
          // file's content instead of every matching file's. Measured before this line existed: 100 x 2 MiB text
          // files that all match cost 709 MiB of live heap for 200 MiB of content, and a --max-old-space-size of
          // 200 or 400 MiB died with `Reached heap limit` on that shape while the same corpus with no match passed
          // at 56 MiB.
          f.lines = [];
        } else {
          // renderFile() only ever runs for a file with matches, so a
          // non-matching candidate's retained lines are dead weight. Release them:
          // without this every candidate file's full content is held for the
          // whole call, however long the scan runs.
          f.lines = [];
        }
      }

      // Single binary candidate → explain the silence (grep skips binaries).
      if (candidates.length === 1 && files[0].status === "binary") {
        return {
          content: [
            {
              type: "text",
              text: `[Warning: '${candidates[0]}' appears to be a binary file — grep skips binary files. Use a hex tool or the read tool to inspect it.]` +
                (candidateList.escapeWarning ? "\n" + candidateList.escapeWarning.trimEnd() : "") + // round 152 F-13
                // Round 116 F-116-1: this early return used to carry NO scope disclosure of any kind, so an
                // omitted `query` here left the caller unable to see that the ONE candidate was a set the tool
                // had narrowed for them (measured: a cwd holding one binary file answered the warning only).
                (userQuery === ""
                  ? "\n\n" + defaultScopeNote(candidateList.esQuery, rescueInfo !== null)
                  : "") +
                // Round 154 F-1: `defaultScopeNote`'s rescued clause points at "the cap note in
                // this answer" - the main return pushes it (capAnswerNote(capRescue)); this early
                // return must carry it too, or the pointer names a note that never prints.
                (capRescue !== ""
                  ? "\n" + capAnswerNote(`[everything_grep: ${capRescue}]`)
                  : ""),
            },
          ],
          // The same 19-key contract as every other answer this tool gives (see the
          // zero-candidate shape above). Round 199 F-199-01: `candidatesTotal` is the candidate COUNT call's
          // reply wherever it runs, so this carries that reply rather than the one row the answer names - on a
          // scope whose count was never asked (a priced walk) the honest field is null, and the identity the
          // extension README documents for these buckets is evaluable only when that field is not null.
          details: {
            pattern,
            query: userQuery === "" ? null : userQuery,
            esQuery: candidateList.esQuery,
            candidatesTotal: candidateList.total,
            candidatesScanned: 0,
            candidatesNotScanned: 0,
            matches: 0,
            files: 0,
            skippedBinary: 1,
            skippedMissing: 0,
            skippedUnreadable: 0,
            skippedDir: 0,
            skippedBig: 0,
            perFileCapApplied: false,
            budgetStopped: false,
            answerCapTrimmedFiles: 0,
            answerCapTrimmedLines: 0,
            budgetCutLines: 0,
            budgetDroppedGroups: 0,
          },
        };
      }

      const matchedFiles = files.filter((f) => f.matches.length > 0);
      const fileCount = matchedFiles.length;
      let text: string;
      // Everything that will be printed except the notes: header line first, then either one line per
      // matching file (summary) or the rendered groups. Trimmed after the notes are built, never before.
      let rowLines: string[] = [];
      // pi appends the limit marker after BOTH output shapes (grep-output.ts:158-160), so a
      // summary cut short by `limit` has to warn too. Without it a partial count reads as
      // final - observed: "[3 matches in 1 files] … \huge.ts: 9 matches" with no warning
      // while the true count was 1,200, and only the grouped path told the truth.
      const suffixes: string[] = [];
      if (totalMatches >= effectiveLimit) {
        suffixes.push(
          `[Search stopped at ${effectiveLimit} matches; completeness unknown — refine pattern or increase limit]`,
        );
      }
      if (summaryMode) {
        // Summary = count-only. It stops at `limit` exactly like the grouped path (the scan is NOT
        // guaranteed to complete - the old comment here claimed it was). Its file list is NOT trimmed here
        // any more: giving it a row-only budget (20,480 - 320) is what let the finished answer overflow,
        // and the note reporting the trim then died in the final clamp (round 31 F-1). Every entry is
        // rendered and the single answer-cap trim at the end of execute() decides what fits, with the
        // notes' bytes already known.
        rowLines = [
          `[${totalMatches} matches in ${fileCount} files]`,
          ...[...matchedFiles]
            .sort((a, b) => b.matches.length - a.matches.length)
            .map((f) => `${f.abs}: ${f.matches.length} matches`),
        ];
        if (context > 0) {
          // Same rule as everything_search's count_only answer (round 21): a parameter this output
          // shape cannot honour is named, not swallowed. Measured 2026-11-04: summary + context:3
          // returned byte-identical output to summary alone, with nothing to tell them apart.
          suffixes.push(
            `[everything_grep: summary mode prints per-file counts only — context:${context} is not applied to this answer]`,
          );
        }
      } else {
        rowLines = [`[${totalMatches} matches in ${fileCount} files]`, ...groupBlocks.flat()];
        if (anyLineTruncated) suffixes.push(LINE_TRUNC_FOOTER);
        if (budgetStopped) {
          const notScanned = files.filter((f) => f.status === "unscanned").length;
          // Round 156 F-7: a folder row sitting behind the cut was never stat'd, so it hides in
          // `unscanned` - the marker must not call it a candidate FILE (the never-read note of
          // round 95 F-95-1 already gives folder rows their own clause; this is the same fact).
          const dirRowsG = files.filter((f) => f.status === "dir").length;
          suffixes.push(
            `[everything_grep: output budget (${formatSize(GREP_OUTPUT_MAX_BYTES)}) reached after ` +
              // Round 169 F-1/F-5: the noun agrees with what is being counted, and the denominator
              // travels with it. Without `of ${files.length}` this is the only coverage count in a
              // budget-stopped answer and nothing in that answer states what it is a part of (the
              // independent count_only of the driven query answered 171 while the marker said 167, and
              // 4 read). The folder arm's first cut also printed the noun twice - driven live through
              // execute(): "5 candidate candidate not scanned".
              `${totalMatches} matches in ${fileCount} files. ${notScanned} of ${files.length} ` +
              `${dirRowsG ? "candidates" : `candidate file${notScanned === 1 ? "" : "s"}`} not ` +
              `scanned` +
              (dirRowsG
                ? ` (the candidate list also held ${dirRowsG} folder row${dirRowsG === 1 ? "" : "s"}; `
                  + "some of the unscanned candidates may be folder rows, which this tool never opens)"
                : "") +
              // A byte cut INSIDE a file also swallows that file's "... +N more matches"
              // note (it is the group's last line), so the loss must be named here or
              // nothing reports it at all.
              (budgetCutLines > 0
                ? `, and ${budgetCutLines} rendered line${budgetCutLines === 1 ? "" : "s"} cut from the `
                  + `last printed file`
                : "") +
              (budgetDroppedGroups > 0
                ? `, and ${budgetDroppedGroups} file${budgetDroppedGroups === 1 ? "" : "s"} with matches `
                  + `not printed at all (group did not fit the remaining room)`
                : "") +
              `. Narrow the pattern or query, or use summary mode.]`,
          );
        }
      }
      // Skip accounting has no pi analogue to copy: pi's grep ABORTS the whole search when one
      // file is unreadable (measured 2026-11-04, a corpus with one exclusively-locked file - it
      // printed only "rg: ... used by another process (os error 32)" and returned ZERO matches for
      // the entire root), while we keep scanning. Our counts are therefore a completeness claim
      // only we can qualify: without this note, a search that skipped a 3.4 MB file and a locked
      // one printed "[1 matches in 1 files]" and read as exhaustive. Names are capped at 5 per
      // reason; binaries are counted but never named (a folder of PNGs would drown the note).
      const notSearched: { n: number; label: string; names: string[] }[] = [];
      const big = files.filter((f) => f.status === "big");
      const gone = files.filter((f) => f.status === "missing");
      const unreadable = files.filter((f) => f.status === "unreadable");
      const binaries = files.filter((f) => f.status === "binary");
      if (big.length) notSearched.push({ n: big.length, label: `over the ${formatSize(MAX_GREP_FILE_BYTES)} size limit`, names: big.map((f) => f.abs) });
      if (gone.length) notSearched.push({ n: gone.length, label: "indexed but no longer on disk", names: gone.map((f) => f.abs) });
      if (unreadable.length) notSearched.push({ n: unreadable.length, label: "could not be read (locked or access denied)", names: unreadable.map((f) => f.abs) });
      if (binaries.length) notSearched.push({ n: binaries.length, label: "binary", names: [] });
      if (notSearched.length) {
        const totalSkipped = notSearched.reduce((a, s) => a + s.n, 0);
        const parts = notSearched.map((s) => {
          const named = s.names.length
            ? ` (${s.names.slice(0, 5).map((p) => basename(p)).join(", ")}${s.names.length > 5 ? ` +${s.names.length - 5} more` : ""})`
            : "";
          return `${s.n} ${s.label}${named}`;
        });
        suffixes.push(
          `[everything_grep: ${totalSkipped} candidate file${totalSkipped === 1 ? "" : "s"} NOT searched - ${parts.join("; ")}. `
            + `The counts above exclude them; search those files directly if they matter.]`,
        );
      }
      // When the MATCH LIMIT ended the scan (not the output budget, whose marker names them), the
      // number of candidate files never opened went unreported: pi's limit marker says "completeness
      // unknown" and nothing says how much was left unread. Measured 2026-11-04: a summary over
      // 1,366 candidates printed "[500 matches in 206 files]" having read 315 of them.
      // COVERED means the files actually searched (status "ok"), NOT `files.length - neverRead`. The
      // difference is the skipped ones - over 2 MB, gone from disk, locked, binary - and the skip note
      // above has already promised "The counts above exclude them". Measured 2026-11-04 on a fixture with
      // four oversized files: `files.length - neverRead` announced 305 covered while only 301 were
      // searched, so the note was counting as covered the very files the skip note had disclaimed. With
      // this number the three figures close - but ONLY once DIRECTORY candidates are counted as skipped too:
      // round 87 measured a 10-candidate fixture (5 searched, 1 over the size limit, 1 gone from disk, 1
      // locked, 1 binary, 1 folder) and the folder is in `files.length`, in none of the three renderer
      // buckets, and never named in the skip note above; `details.skippedDir` is where it is accounted for.
      // Round 95 F-95-1: that accounting is why the DENOMINATOR here was `files.length` - a ROW count - and
      // the sentence called it files. Measured 2026-11-05 over a 40-candidate scope holding 8 folders: the
      // note announced "cover 2 of 40 candidate files; 30 were never read", but 8 of those 40 can never be a
      // file, so neither the covered count nor the never-read count can add up to the number printed. The
      // denominator is now the FILE candidates and the folder rows get their own clause, so searched +
      // never-read + the skip note's buckets close over the files and the folders stand outside the sentence.
      // With no folder in the candidate list the note is BYTE-IDENTICAL to what it said before (cases 34, 118
      // and 133 quote it), so only the answers that were wrong change.
      const neverRead = files.filter((f) => f.status === "unscanned").length;
      const searchedCount = files.filter((f) => f.status === "ok").length;
      const dirRows = files.filter((f) => f.status === "dir").length;
      if (neverRead > 0 && !budgetStopped) {
        suffixes.push(
          `[everything_grep: the counts above cover ${searchedCount} of ` +
            `${files.length - dirRows} candidate files` +
            (dirRows
              ? ` (the candidate list also held ${dirRows} folder row${dirRows === 1 ? "" : "s"}, `
                + "which this tool never opens)"
              : "") +
            `; ${neverRead} were never read. ` +
            "The scan order is Everything's own name order, not path order, so the files " +
            "never read are the TAIL of that order.]",
        );
      }
      // Round 92: a caller who passed one of everything_search's parameters here got a byte-identical
      // answer with it dropped (pi validates nothing - round 82 - and SEARCH_ONLY_PARAMS' comment
      // carries the twelve-key measurement). Say so, because the silent one that matters is `sort`:
      // no sort is sent, so Everything's own name order decides which files this answer covered.
      // Round 94 F-94-2: a call whose cap trip was only FOLDER rows says which rows its candidate list
      // dropped, with the same figures the refusal would have quoted.
      // Round 115 F-115-2: with `query` omitted the tool INVENTS the scope (the ancestor:"<cwd>" query built
      // above), and Everything's `path:` function is a PATH SUBSTRING test, so every .gitignore in the tree is
      // out of scope by construction - measured in this repo (re-measured 2026-11-06 at the round-186
      // cadence): 547 rows outside node_modules fell to 383 once .git was excluded (1,780->311 when round
      // 115 first measured it, 500->333 at the round-135 cadence, 760->357 at round 160, 1,022->376 at
      // round 179, and 547->383 here - the .git-INCLUSIVE side grows with every commit AND COLLAPSES when
      // git housekeeping packs the loose objects, which is what renews this pair; the .git-EXCLUSIVE side
      // moved by 7 over the same span), and the only
      // losers outside a .git folder were its three .gitignore files (the root
      // README has carried that measurement since 2026-11-04; no agent-facing surface said it). A caller who
      // searched for ignore-file content and got "No matches" could not see why, so the invented scope is now
      // named in the answer itself.
      if (userQuery === "") {
        // Round 117 F-117-1: `candidateList.esQuery`, not `esQuery` - on a rescued call the candidates
        // came from the re-selected file-only list, and this note claims to name where they came from.
        suffixes.push(defaultScopeNote(candidateList.esQuery, rescueInfo !== null));
      }

      if (capRescue !== "") suffixes.push(capAnswerNote(`[everything_grep: ${capRescue}]`));
      const foreignGrepNote = foreignParamNote("everything_grep", params, FOREIGN_AT_GREP);
      if (foreignGrepNote !== "") suffixes.push(foreignGrepNote);
      if (ignoredParams.length > 0) {
        const one = ignoredParams.length === 1;
        suffixes.push(
          `[everything_grep: ${ignoredParams.join(", ")} ${one ? "is not a parameter" : "are not parameters"} of this ` +
            `tool and ${one ? "was" : "were"} ignored - everything_search has them. No sort is sent to es.exe, so the ` +
            "scan runs in Everything's own name order and a truncated answer covers the FIRST files of that order.]",
        );
      }
      // A query that matches a DIRECTORY (Everything indexes folders) used to answer
      // "[0 matches in 0 files]" with nothing to explain it, where pi's grep - handed a directory -
      // searches inside it and answers normally. Measured 2026-11-04. Folders are deliberately NOT
      // in the skip note above (an ancestor: query matches folders on every search, so a standing
      // count would be pure noise), but an empty result aimed at a folder is the one case an agent
      // cannot diagnose on its own, so it gets a hint with a query that actually works.
      const dirs = files.filter((f) => f.status === "dir");
      // dirs.length === files.length is what makes the wording below true: EVERY candidate was a
      // directory. An ancestor: query over a real repo also matches folders, so a looser test
      // (any dir at all) told the agent "the only candidates were directories" after a search that
      // had read hundreds of files - caught the first time this branch ran against the repo corpus.
      if (totalMatches === 0 && dirs.length > 0 && dirs.length === files.length) {
        const listed = dirs.slice(0, 3);
        const listOfNames = listed.map((d) => `"${basename(d.abs)}"`).join(", ");
        const more = dirs.length > listed.length ? ` +${dirs.length - listed.length} more` : "";
        // The example carries the folder's OWN PATH, because ancestor: is a path function and the
        // basename that reads well in the name list matches nothing once it is dropped inside it
        // (measured 2026-11-06 through the shipped tool: ancestor:"esq82-fix" answered "No results
        // found" - and then steered to everything_status - where ancestor:"C:\tmp\esq82-fix" answered
        // 7 rows in both slash spellings).
        suffixes.push(
          `[everything_grep: 0 matches, and the only ${dirs.length === 1 ? "candidate was a directory" : "candidates were directories"} (${listOfNames}${more}) - directories are not searchable. To search a folder's contents, match the files inside it instead, e.g. ancestor:"${listed[0].abs}"].`,
        );
      }
      // A `|` with an empty side changes WHICH FILES were opened: es.exe deletes the term beside the empty side
      // before the candidate list is even built (measured 2026-11-04 through execute(): query
      // ancestor:"…answertrim" ext:bin | selected 405 candidate files and scanned 401 of them, where the same
      // query with no pipe selected 1). Through round 56 only the candidate-cap refusal mentioned this, so an
      // orphan pipe that stayed under the cap answered a file set nobody asked for in silence. The note is the
      // one everything_search renders, with its label swapped, so the two tools cannot drift apart; the closing
      // clause says these claims are about candidate files, not content matches. Skipped for a `regex:` query,
      // where a pipe may be pattern text (round 52: everything_grep has no `regex` parameter, the in-query
      // function is the reachable spelling here).
      if (!queryAsksRegex(esQuery)) {
        const scopeNote = orScopeNote(esQuery, -1);
        const PRE = "\n[everything_search: ";
        if (scopeNote.startsWith(PRE) && scopeNote.endsWith("]")) {
          // Some of the note variants end their last sentence without a full stop before their `]`, so the
          // joined sentence would run on ("...or delete the "|" For this tool..."). Normalise the seam.
          const body = scopeNote.slice(PRE.length, -1).replace(/[.\s]+$/, "");
          // Round 120: this note quotes the caller's query through orScopeNote, and grep's assembly trim
          // spends the budget on ROWS while keeping every note - so a note of its own size decides the
          // answer. Measured with a 20,052-byte query: the single 20.4 KB note tripped the byte guard
          // below, truncateHead then dropped the note WHOLE (it never emits a partial line), and what the
          // caller read was "[0 matches in 0 files]" plus a false "internal accounting bug" blame.
          // What gets bounded here is the QUOTED text, not the finished note: the borrowed sentence carries
          // the caller's text in its MIDDLE and this tool's own clarification at its tail, so cutting the
          // note would delete the half that makes the note belong to this tool. The margin below the note
          // cap is the wrapper plus this clause; the bound is MAX_ECHO_BYTES - the same line the note's
          // own insertions use since F-120-6 - so the finished note (boilerplate + one bounded quote) stays
          // far below MAX_NOTE_BYTES and never takes a cut of its own, which is the point of bounding the
          // quote rather than the note.
          const QUOTE_BUDGET_BYTES = MAX_ECHO_BYTES;
          const quoted =
            byteLen(body) <= QUOTE_BUDGET_BYTES
              ? body
              : `${headBytes(body, QUOTE_BUDGET_BYTES)} (this note quotes a ${byteLen(body).toLocaleString("en-US")}-byte query; the rest is not repeated)`;
          suffixes.push(
            `[everything_grep: ${quoted}. For this tool those claims are about the CANDIDATE FILES the query ` +
            `selected and opened, not only about matches.]`,
          );
        }
      }
      // The notes ride OUTSIDE the row budget, so GREP_MARKER_RESERVE (320 B) covers a TYPICAL note set
      // only. Measured 2026-11-04 on a 325-file fixture (4 oversized, 1 binary, 320 small): the guard below
      // FIRED, so the finished answer had passed 20,480 B - and what reached the agent was 20,315 B with 17
      // of 18 groups printed, its skip note DELETED (decision 9 exists to name every file it could not
      // read) and a message blaming an "internal accounting bug" when nothing had been miscounted. So cut
      // WHOLE TRAILING GROUPS here, where the notes' bytes are already known, keep every note, and say what
      // went unprinted.
      // When the scan-side budget marker is in the same answer, this is its SECOND byte-cut account and
      // the numbers differ because the stages differ. Measured 2026-11-04 at grouped limit:112: the marker
      // named "1 file with matches not printed at all" and this note named "6 rendered lines from 3
      // files", with nothing saying the 6 are additional rather than the same loss recounted - so say
      // "a further". Only the scan-side budget stop sets budgetStopped (summary rows never reach
      // renderFile, and the final accounting-bug guard below does not set it either), so the qualifier
      // can never point at a marker that is not there.
      const dropNote = (lines: number, files: number) =>
        `[everything_grep: answer cap (${formatSize(GREP_OUTPUT_MAX_BYTES)}) reached — ` +
        `${budgetStopped ? "a further " : ""}${lines} rendered line${lines === 1 ? "" : "s"} from ${files} ` +
        `file${files === 1 ? "" : "s"} not printed; the counts above are what was FOUND. Narrow the ` +
        `pattern or query.]`;
      const joinBytes = (arr: string[]) => arr.reduce((a, s) => a + byteLen(s) + 1, 0);
      let trimmedLines = 0;
      let trimmedFiles = 0;
      // joinBytes over-counts each array by one separator, so this is never optimistic.
      const answerFits = () =>
        joinBytes(rowLines) +
          joinBytes(suffixes) +
          (trimmedFiles ? byteLen(dropNote(trimmedLines, trimmedFiles)) + 2 : 0) <=
          // Round 156 F-1: the escape/aged-build warning is prepended after this loop, so its
          // bytes must be reserved HERE - otherwise a warning-only overflow trips the final
          // "internal accounting bug" guard and the trim below undercounts by the warning's size.
          (candidateList.escapeWarning ? byteLen(candidateList.escapeWarning) + 1 : 0) +
        GREP_OUTPUT_MAX_BYTES;
      while (!answerFits() && (summaryMode ? rowLines.length > 1 : groupBlocks.length > 0)) {
        if (summaryMode) {
          rowLines.pop();
          trimmedLines++;
          trimmedFiles++;
        } else {
          trimmedLines += groupBlocks.pop()!.length;
          trimmedFiles++;
          rowLines = [rowLines[0], ...groupBlocks.flat()];
        }
      }
      if (trimmedFiles > 0) suffixes.push(dropNote(trimmedLines, trimmedFiles));

      text = rowLines.join("\n");
      // Round 152 F-13: the escape-operator guard runs in the SHARED list pipeline - a grep `query`
      // holding `\ext:ts` gets the same false zero as a search query, so its warning rides along.
      // After the header line: pi parity keeps the FIRST line (the suite pins it).
      if (candidateList.escapeWarning) text = rowLines[0] + "\n" + candidateList.escapeWarning + text.slice(rowLines[0].length);
      if (suffixes.length > 0) text += "\n\n" + suffixes.join("\n");

      // Final guard: the header + marker reserves above make text ≤ cap by
      // construction, so this must never fire in practice. If it does, a
      // reserve was miscalculated — cut head-first and say so plainly
      // (instead of silently overflowing the response cap).
      if (Buffer.byteLength(text, "utf8") > GREP_OUTPUT_MAX_BYTES) {
        const clamped = truncateHead(text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: GREP_OUTPUT_MAX_BYTES - 200,
        });
        text = `${clamped.content}\n\n[everything_grep: output exceeded ${formatSize(GREP_OUTPUT_MAX_BYTES)} after rendering — internal accounting bug; narrow the pattern or query.]`;
        // budgetStopped is deliberately NOT set here: this arm is not the scan-side budget stop, the
        // answer-cap note above was already rendered, and setting it would only make
        // details.budgetStopped claim a marker this answer never printed.
      }

      return {
        content: [{ type: "text", text }],
        details: {
          pattern,
          query: userQuery === "" ? null : userQuery,
          esQuery: candidateList.esQuery,
          candidatesTotal: candidateList.total,
          candidatesScanned: files.filter((f) => f.status === "ok").length,
          candidatesNotScanned: files.filter((f) => f.status === "unscanned").length,
          matches: totalMatches,
          files: fileCount,
          skippedBinary,
          skippedMissing,
          skippedUnreadable: files.filter((f) => f.status === "unreadable").length,
          skippedDir: files.filter((f) => f.status === "dir").length,
          skippedBig,
          perFileCapApplied,
          budgetStopped,
          // What the answer-cap trim removed, so a trimmed answer is diagnosable without re-running it.
          answerCapTrimmedFiles: trimmedFiles,
          answerCapTrimmedLines: trimmedLines,
          // Bytes-of-output accounting, so a truncated answer reconciles without re-running it:
          // lines cut inside a group that IS printed, and whole groups dropped for lack of room.
          budgetCutLines,
          budgetDroppedGroups,
        },
      };
    },
  });
  // ---- everything_folder_size ---------------------------------------------

  pi.registerTool({
    name: "everything_folder_size",
    label: "Everything Folder Size",
    description:
      "Recursive total size of a folder from the Everything index (instant, read off the index, with " +
      "no recursive walk of the tree). Pass an ABSOLUTE folder path - a bare folder name is refused " +
      "with its own message (es.exe itself answers 'Error 9: No results found.', which explains " +
      "nothing). " +
      "Returns human-readable + raw bytes. A junction or symlink covers the link entry " +
      "only (Everything never traverses links), so the answer names the target and sizes " +
      "it in the same reply; a link whose target is gone says the target is NOT on disk and claims no size " +
      "for it.",
    promptSnippet:
      "Recursive folder size from the Everything index.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Folder to size recursively; must be an absolute path (a bare name is refused with its own message, not with es.exe's Error 9). A trailing \\ or / is stripped for you - Everything renders folder paths with one, and es.exe rejects a spaced path that ends with a backslash. Forward slashes are rewritten to backslashes, because Everything stores backslashes and the forward-slash form makes es.exe answer 0 for a folder it has not indexed yet, where the backslash form answers Error 9 (which this tool can explain).",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      // A spaced path ending in a separator is rejected before it ever reaches the index. The
      // command-line quoter wraps the argument in quotes BECAUSE of the space, and the trailing
      // backslash then escapes that closing quote, so es.exe receives a mangled path and answers
      // "Error 9: No results found." Reproduced from both bash and Node with a clean single argv
      // element, so it is Windows argument quoting, not this spawn: "C:\Program Files\" and
      // "C:\Program Files\Git\" -> Error 9, the same paths without the trailing "\" -> sizes
      // (271.5 GB / 404 MB), and unspaced paths are never quoted so they answer fine
      // ("C:\Windows\System32\"). Everything's own UI prints folders WITH a trailing "\", which
      // is the shape an agent copies into this tool, so normalise it away here.
      // Leading whitespace is never part of a path; trailing whitespace may be (see the block below), so
      // this strips only the front. The trailing separator is still normalised away - see above.
      const pathSent = stringParam("path", params.path, "path");
      const rawPath = pathSent.replace(/^\s+/, "");
      let target = rawPath.replace(/[\\/]+$/, "");
      if (target === "") target = rawPath; // a bare "/" or "\" keeps what it sent
      else if (/^[A-Za-z]:$/.test(target)) target += "\\"; // drive root needs its separator
      // Everything stores backslashes, and the SEPARATOR changes what es.exe admits. For an INDEXED folder the
      // two forms agree (measured 2026-11-05: "C:/Windows/System32/drivers/etc" and the backslash form both
      // answer 26,208 bytes). For a folder the index does not know yet they do not: the backslash form answers
      // Error 9 - which the classifier below turns into "not on disk" / "created seconds ago" / "outside the
      // indexed volumes" - while the forward-slash form answers 0 with exit 0, and the tool printed "0 B (0
      // bytes, recursive, from index)" for a folder holding 4,096 bytes (made 100 ms before the call; es.exe
      // itself flipped to 4096 at +1.5 s). A forward slash cannot appear in a Windows name, so the rewrite is
      // 1:1 and a mixed "//server/share" becomes the UNC lead-in it means: this turns a silent wrong zero
      // into a path the handler can explain.
      target = target.replace(/\//g, "\\");
      // A name that ends in a SPACE is legal on Windows and NTFS stores it there, so the trailing space
      // belongs to the name being looked up - it is not whitespace to clean. Measured 2026-11-04:
      // `-get-folder-size` answers 2 for `…\round42space ` and Error 9 for the same path with the space
      // removed, and statSync is the discriminator (verbatim ok, trimmed ENOENT - no Win32 stripping of
      // the trailing space happens on this path form). So look the sent name up verbatim, and only when
      // it is NOT on disk while the same name minus ONE trailing space - then minus the next, and the
      // next - IS a directory, size that one and say so. That keeps a mistyped trailing space working, which is what the params.path.trim() this
      // handler used to start with did - without letting it erase a real name. The old trim made the tool
      // tell the caller that a folder which exists, is indexed, and had just been listed by
      // everything_search "is not on disk … may have been deleted or renamed".
      let trimmedNameNote = "";
      if (/ $/.test(target)) {
        let verbatimExists = true;
        try { statSync(target); } catch { verbatimExists = false; }
        if (!verbatimExists) {
          // Drop ONE trailing space at a time and stop at the first name that is a directory (round 174
          // F-4). Stripping the whole run at once - the old replace(/ +$/,"") - stepped OVER the folder
          // whose own name ends in a space: a caller's extra space onto the real folder `round42space `
          // trimmed all the way down to `round42space`, which is no folder at all, and the tool refused a
          // path that was missing from disk only because of the space the caller did not mean to type
          // (driven live this round). One space at a time also keeps the note's own wording true: the name
          // it prints is the sent path with its trailing space dropped.
          let spaced: string | null = null;
          let cand = target;
          while (cand.endsWith(" ")) {
            cand = cand.slice(0, -1);
            let candIsDir = false;
            try { candIsDir = statSync(cand).isDirectory(); } catch { candIsDir = false; }
            if (candIsDir) { spaced = cand; break; }
          }
          if (spaced !== null) {
            trimmedNameNote =
              `\n\n[everything_folder_size: no folder named "${target}" is on disk; the total above is for ` +
              `"${spaced}", the same path with its trailing space dropped. A Windows name may legally end ` +
              `in a space or a dot, so spell such a folder exactly to size that one.]`;
            target = spaced;
          }
        }
      }
      // A directory LINK (NTFS junction or symlink) is a reparse point, and Everything indexes files
      // under their REAL path: it never traverses the link. Measured 2026-11-04 - a junction over a
      // folder of three 1,024-byte files is indexed as an EMPTY folder: ancestor:"...\junction"
      // returns ZERO rows and -get-folder-size answers 0, while `dir` lists 3,072 bytes. Printing
      // that 0 as "recursive, from index" tells the caller the folder is empty, so the link is named
      // and its target sized alongside.
      let linkTarget: string | null = null;
      let linkTargetMissing: string | null = null;
      try {
        if (lstatSync(target).isSymbolicLink()) {
          try {
            linkTarget = realpathSync(target);
          } catch {
            // A failed realpathSync is NOT evidence that the target is gone. It throws EISDIR when the
            // LINK's own path carries a Windows-only device prefix (the extended-length or device form)
            // while lstatSync, statSync and readlinkSync all answer normally for that same link (measured
            // round 123 probe p3, one junction three spellings: plain answers the target, both device
            // throw EISDIR). The one-line catch below read that as a dead link and told the caller to
            // re-point or remove a WORKING junction, naming its target and then denying it existed
            // (F-123-3, round 123). Ask the disk about the stored target instead, and call the link dead
            // only when THAT stat fails too - a target that exists means this is a spelling question,
            // which the plainFormOf branch answers with the path to retry.
            let stored: string | null = null;
            try { stored = readlinkSync(target); } catch { stored = null; }
            if (stored !== null) {
              // A junction can store its substitute name in the NT object-namespace form, which statSync
              // cannot open; strip that prefix before asking. A SHARE target is then still in the
              // substitute `UNC\server\share` spelling statSync cannot open either - rebuilt to
              // `\\server\share` first, or a live link to a sleeping server reads as a DEAD one
              // (round 153 F-4). A relative stored value is relative to the link's own folder.
              const storedPlain = stored.startsWith("\\??\\") ? stored.slice(4) : stored;
              const uncFixed = /^UNC[\\/]/i.test(storedPlain)
                ? "\\\\" + storedPlain.replace(/^UNC[\\/]+/i, "")
                : storedPlain;
              const probe = /^[A-Za-z]:[\\/]/.test(uncFixed) || /^\\\\/.test(uncFixed)
                ? uncFixed
                : dirname(target) + "\\" + uncFixed;
              try {
                statSync(probe);
                linkTarget = probe;
              } catch {
                linkTargetMissing = uncFixed; // round 153 F-4: echo the path the stat actually asked
              }
            }
          }
        }
      } catch {
        // Nothing to lstat at all: the classifier below decides from statSync.
      }
      const r = await runEs(["-get-folder-size", target], signal, ES_TIMEOUT_MS);
      if (r.spawnError || r.timedOut) throw new Error(esFailureMessage(r, target, -1, "path"));
      if (r.code !== 0) {
        // es.exe answers "Error 9: No results found." for THREE unrelated causes - a FILE path, a
        // path that does not exist, a relative name - and the generic message sent all three off to
        // everything_status, which is the one thing that cannot be wrong here (measured 2026-11-04:
        // identical text for all three, pointing at index health while the caller's own path was the
        // problem). Classified from disk instead: one statSync, no second es.exe call. Only the
        // directory-that-is-not-indexed case keeps the status pointer, because only it is an index
        // question.
        const looksAbsolute = /^[A-Za-z]:[\\/]/.test(target) || /^[\\/]{2}/.test(target);
        if (!looksAbsolute) {
          throw new Error(
            `everything_folder_size needs an ABSOLUTE path - ${showParamValue(pathSent)} is relative and Everything does not resolve relative names. Pass the full path, e.g. "C:\\Users\\you\\project".`,
          );
        }
        let st: ReturnType<typeof statSync> | null = null;
        try {
          st = statSync(target);
        } catch {
          st = null;
        }
        if (linkTargetMissing) {
          throw new Error(
            `"${target}" is a directory LINK (junction or symlink) to "${linkTargetMissing}", and ` +
              `that target is not on disk - there is nothing to size. Everything indexes the link ` +
              `itself (as an empty folder) and never traverses it, so this is a dead link, not an ` +
              `index question: re-point or remove it.`,
          );
        }
        if (!st) {
          // A leading pair of backslashes is NOT one shape. A share - \\server\share and its extended
          // \\?\UNC\ form - really does make es.exe wait for the server. \\?\C:\ and \\.\C:\ name a
          // LOCAL volume in a Windows-only spelling, so the wait sentence is false for those and the
          // plain path is the thing to re-check (F-122-1, round 122: the test before this one claimed
          // this tool had waited 7.4 s for a share in an answer it had produced in 41 ms).
          const extUnc = target.startsWith("\\\\?\\UNC\\");
          const deviceLocal = (target.startsWith("\\\\?\\") && !extUnc) || target.startsWith("\\\\.\\");
          const isShareRoot = /^\\\\/.test(target) && !deviceLocal;
          const devicePlain = deviceLocal ? target.slice(4) : "";
          throw new Error(
            `"${target}" is not on disk, and Everything found nothing matching it. Check the spelling with everything_search, or the folder may have been deleted or renamed.` +
            (isShareRoot
              ? ` It is a UNC path, so es.exe waits for the share to resolve before it answers (7.4 s ` +
                `measured 2026-11-05 for a server name that does not exist): an unreachable or misspelled ` +
                `server replies exactly like a missing folder from here.`
              : "") +
            (deviceLocal
              ? ` Its "${target.slice(0, 4)}" prefix is a Windows-only spelling of a LOCAL path, so there ` +
                `is no share to wait for here; the plain form to check is "${devicePlain}". This is a ` +
                `spelling question, not an index one, so everything_status cannot help here.`
              : ""),
          );
        }
        if (!st.isDirectory()) {
          throw new Error(
            `"${target}" is a FILE (${st.size.toLocaleString("en-US")} bytes on disk); everything_folder_size sizes a directory recursively. Pass "${plainFormOf(dirname(target))}" to size its folder, or use everything_search with details to read this file's own size.`,
          );
        }
        // Three spellings Windows accepts, the index does not: the extended-length prefix (\\?\C:\x), the
        // device prefix (\\.\C:\x), and a trailing "." (C:\x\.). All three statSync as the directory they
        // name, so left alone they reach the branch below and the caller is told C:\Program Files is
        // "outside the indexed volumes" with "Index folder size" off - both false on the indexed C: volume
        // (measured 2026-11-04, all three spellings of that folder). Name the plain form instead; string
        // work only, no second es.exe call (round 24's rule: one statSync, classify from disk).
        const plainForm = plainFormOf(target);
        const retyped = plainForm !== target &&
          (/^[A-Za-z]:[\\/]/.test(plainForm) || plainForm.startsWith("\\\\"));
        if (st !== null && st.isDirectory() && retyped) {
          throw new Error(
            `"${target}" is a directory on disk, but Everything does not index paths written that way - ` +
              `"\\\\?\\" (extended length), "\\\\.\\" (device) and a trailing '.' SEGMENT are Windows-only forms. ` +
              `Retry with the plain path "${plainForm}". This is a spelling question, not an index one, so ` +
              `everything_status cannot help here.`,
          );
        }
        // A folder created seconds ago is not in the index yet, and Nothing Found is the same reply
        // it gives for a share it will never cover. Measured 2026-11-04: a folder made 100 ms before
        // the call was answered as "outside the indexed volumes ... or Index folder size is off" -
        // both false; 22 s later the same path returned 12,345 bytes. Say the timing thing first.
        throw new Error(folderNotIndexedText(target, Date.now() - st.birthtimeMs));
      }
      const out = r.stdout.toString("utf-8").trim();
      const n = Number(out);
      if (!Number.isFinite(n) || n < 0 || String(n) !== out) {
        throw new Error(folderParseFailureText(target, out));
      }
      // The LINK case: print the index's number, then say what it is not, and size the target in the
      // same answer (one extra -get-folder-size; ~50 ms measured).
      let linkNote = "";
      let zeroLinkNote = ""; // set inside the 0-total block below (round 181 F-1)
      let linkTargetSizeBytes: number | null = null;
      if (linkTargetMissing) {
        // Measured 2026-11-04: Everything ANSWERS 0 for a junction whose target was deleted (the link
        // is an indexed folder with nothing under it), so the Error-9 classifier above never sees a
        // dead link and the tool printed a bare "0 B" for one.
        linkNote =
          `\n\n[everything_folder_size: "${target}" is a directory LINK (junction or symlink) to ` +
          `"${linkTargetMissing}", and that target is NOT on disk - the number above is the index's ` +
          `entry for the dead link itself. Re-point or remove the link; nothing here is an index question.]`;
      } else if (linkTarget) {
        let targetPart: string;
        let tStat: ReturnType<typeof statSync> | null = null;
        try {
          tStat = statSync(linkTarget);
        } catch {
          tStat = null; // raced away between realpath and stat
        }
        if (tStat && !tStat.isDirectory()) {
          // A FILE target gets its size in prose only; `linkTargetSizeBytes` stays null.
          targetPart = linkTargetLeg(linkTarget, null, tStat).part;
        } else {
          const rt = await runEs(["-get-folder-size", linkTarget], signal, ES_TIMEOUT_MS);
          const leg174 = linkTargetLeg(linkTarget, rt, null);
          linkTargetSizeBytes = leg174.bytes;
          targetPart = leg174.part;
        }
        linkNote =
          `\n\n[everything_folder_size: "${target}" is a directory LINK (junction or symlink) to ` +
          `"${linkTarget}". Everything indexes files under their real path and never traverses the ` +
          `link, so the total above describes the link entry itself - it is NOT the folder's ` +
          `contents. To size those, pass the target path.${targetPart}]`;
      }
      // A zero needs a witness. es.exe answers 0 for an empty folder AND for content it has not indexed yet,
      // and it does not separate them: a folder made 100 ms before the call printed "0 B (0 bytes, recursive,
      // from index)" while holding 4,096 bytes (measured 2026-11-05; es.exe answered Error 9 at +0.15 s, 0 in
      // the forward-slash form at +0.03 s, and 4,096 at +1.5 s - neither its exit code nor its number tells
      // them apart). Three witnesses, cheapest first, none of them a walk:
      //   1. the folder's own children (one readdir, then stat at most 256 names): ONE file carrying bytes
      //      makes a recursive total of 0 false whatever the index says. The index alone cannot witness
      //      this - a second run of the same probe had already recorded the fresh file at size 0 and fixed
      //      the size later, so "size:>0" answered 0 rows and the lie printed (case 113 caught that run).
      //   2. ancestor:"<folder>" answering 0 rows while children exist: the index has not caught up at all.
      //   3. rows under the folder that do carry bytes while the folder total is 0: the index disagrees
      //      with itself (a lagging folder-size entry, or "Index folder size" switched off).
      // Residual, accepted: every direct child is a DIRECTORY the index already knows while the bytes sit
      // one level deeper - either a fresh subfolder holding fresh files, or a LINK child (measured
      // 2026-11-06 on C:\tmp\esq181\resid: 5,000 bytes behind a junction, and the index will answer 0 for
      // the parent forever, because Everything never traverses links). None of the three witnesses sees
      // that shape. The fresh case self-heals on retry; the LINK case never does, so the link shape now
      // gets its own note instead of a bare 0 (round 181 F-1).
      if (n === 0 && linkTarget === null && linkTargetMissing === null) {
        let entries: string[] | null = null;
        try {
          entries = readdirSync(target);
        } catch {
          entries = null;
        }
        if (entries !== null && entries.length > 0) {
          const sep = target.endsWith("\\") ? "" : "\\";
          let childBytes = 0;
          const linkKids: string[] = [];
          for (const name of entries.slice(0, 256)) {
            try {
              // lstat BEFORE stat (round 181 F-1): a link child is a blind spot of the index itself -
              // Everything stores the link as an empty entry and never traverses it - so the bytes a
              // FOLLOWED stat reports behind it are not evidence that the index is wrong. Measured on
              // this Node (v24): lstatSync of a junction reports isSymbolicLink() true, and a plain
              // folder or file reports it false, so nothing else takes this branch.
              const ls = lstatSync(target + sep + name);
              if (ls.isSymbolicLink()) {
                linkKids.push(name);
                continue;
              }
              const cs = statSync(target + sep + name);
              if (cs.isFile()) childBytes += cs.size;
            } catch {
              // A child that vanished mid-call is not evidence either way.
            }
          }
          const under = await runEs(["-get-result-count", `ancestor:"${target}"`], signal, COUNT_TIMEOUT_MS);
          const underText = under.stdout.toString("utf-8").trim();
          const underN = /^\d+$/.test(underText) ? Number(underText) : NaN;
          // One predicate, asked twice (round 181 F-4 moved the arithmetic out of this if-chain so its
          // truth table has a seam): the first call carries witnesses 1 and 2, and only when that says
          // no does the handler spend a count call on size:>0 for the second. A null count is a count
          // call that was unusable - spawn error, timeout, or a reply that is not a bare integer.
          const underCount = !under.spawnError && !under.timedOut && under.code === 0 &&
            Number.isFinite(underN) ? underN : null;
          let contradicted = zeroWitness(childBytes, underCount, null);
          if (!contradicted && underCount !== null && underCount > 0) {
            const heavy = await runEs(
              ["-get-result-count", ...termArgs([], splitQueryTerms(`ancestor:"${target}" size:>0`))],
              signal,
              COUNT_TIMEOUT_MS,
            );
            const heavyText = heavy.stdout.toString("utf-8").trim();
            const heavyN = /^\d+$/.test(heavyText) ? Number(heavyText) : NaN;
            const heavyCount = !heavy.spawnError && !heavy.timedOut && heavy.code === 0 &&
              Number.isFinite(heavyN) ? heavyN : null;
            contradicted = zeroWitness(childBytes, underCount, heavyCount);
          }
          if (contradicted) {
            let zst: ReturnType<typeof statSync> | null = null;
            try {
              zst = statSync(target);
            } catch {
              zst = null;
            }
            throw new Error(
              folderNotIndexedText(target, zst !== null ? Date.now() - zst.birthtimeMs : -1, true),
            );
          }
          // No witness fired, so the index's 0 stands - but when a LINK child is why, the caller has to
          // be told that the total leaves out everything behind that link (round 181 F-1, measured on
          // C:\tmp\esq181\resid: 5,000 bytes behind a junction, answered "0 B" with no note at all).
          if (linkKids.length > 0) zeroLinkNote = linkChildZeroText(target, linkKids);
        }
        if (entries === null) {
          throw new Error(folderZeroUnbackedText(target));
        }
      }
      return {
        content: [
          {
            type: "text",
            text:
              `${target}: ${fmtBytes(n)} (${n.toLocaleString("en-US")} bytes, recursive, from index)` +
              zeroLinkNote +
              linkNote +
              trimmedNameNote,
          },
        ],
        details: {
          path: target,
          sizeBytes: n,
          linkTarget,
          linkTargetSizeBytes,
          linkDeadTarget: linkTargetMissing,
        },
      };
    },
  });

  // ---- everything_syntax ---------------------------------------------------

  pi.registerTool({
    name: "everything_syntax",
    label: "Everything Syntax",
    description:
      "Everything query syntax reference — machine-verified, including what is broken " +
      "on this 1.5 beta install. Call before building non-trivial queries.",
    promptSnippet:
      "Everything query syntax reference (machine-verified; what's broken on this 1.5 beta).",
    parameters: Type.Object({
      include_columns: Type.Optional(
        Type.Boolean({
          description:
            "Also append the full 55-name property-column allowlist (the reference " +
            "body omits it; request it only when you need column names beyond the examples).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const extra = flagParam("include_columns", params.include_columns)
        ? "\n\n## Property column allowlist (all 55, verified)\n" +
          COLUMN_ALLOWLIST.join(", ") +
          "\n\nMeasured here: a missing property returns an EMPTY field - the column stays, so counts " +
          "align. A FOLDER row carries no file-type property (`extension`, " +
          "`content-type`, `file-signature` and shell media/document columns are blank there; " +
          "filesystem-native ones are not), and an `ancestor:` listing returns subdirectories FIRST, so a " +
          "shell column probed that way reads all-blank: scope to the FILE KIND. Five names " +
          "render NOTHING for any file kind sampled: `date-run`, `date-recently-changed`, `date-acquired` " +
          "(ask `date-created` instead), `lens-model`, `people`. Four fill ONLY legacy OLE documents " +
          "(filled/fetched): `word-count` 6/12 `ext:doc`, 5/9 `ext:ppt`; `line-count` 6/12 " +
          "`ext:doc`; `last-author` 6/12 `ext:doc`, 8/14 `ext:xls`, 5/9 `ext:ppt`; `slide-count` " +
          "5/9 `ext:ppt`."
        : "";
      return {
        content: [{ type: "text", text: SYNTAX_REF + extra }],
        details: { length: SYNTAX_REF.length + extra.length },
      };
    },
  });

  // ---- everything_status ---------------------------------------------------

  pi.registerTool({
    name: "everything_status",
    label: "Everything Status",
    description:
      "Diagnose Everything: es.exe presence/version, whether the running Everything app answers es.exe, indexed " +
      "item count, index freshness (a stale index misses recently created files). " +
      "Use when everything_search errors, hangs, or misses files you know exist.",
    promptSnippet:
      "Everything setup health (es.exe reachability, indexed item count, index freshness).",
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description: "Re-probe now: the health result is cached for the whole process with no expiry, so a probe taken while Everything was starting is what you keep seeing until you force one.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      // `force` means "re-probe", so it has to clear BOTH caches. Clearing only `health` left the
      // in-flight probe as the answer: measured 2026-11-06 with a stub es.exe that hangs on
      // -get-result-count, call A (no force) and call B (force:true, 400 ms later) returned the SAME
      // bytes and B finished 415 ms before A, i.e. B never spawned anything - the parameter's own
      // description ("Re-probe now") was not true while a probe was running, which is exactly when a
      // caller who watched a status call sit there would reach for it. Superseded probes are made
      // harmless below, not awaited.
      // The -argv gate's memo (argvSupport) is deliberately NOT cleared here: it is a per-process answer
      // about the es.exe BUILD, and a forced status call re-asks the index, not the build. The report says
      // as much ("reads NO in this process"), and everything-search/README.md names /reload as the fix.
      if (flagParam("force", params.force)) { health = null; healthInFlight = null; }
      void signal; // health check uses its own short timeouts
      const h = await checkHealth();
      return {
        content: [{ type: "text", text: statusReport(h) }],
        details: h,
      };
    },
  });
}
