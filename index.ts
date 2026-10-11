/**
 * everything-search — pi extension wrapping the Everything search engine (es.exe).
 *
 * Recreates the CodingRookie98/everything-search skill (MIT) as native pi tools:
 *   - everything_search      : machine-wide instant file search (name/path/ext/size/date)
 *   - everything_grep        : content search over an Everything-index file list (grep-compatible output)
 *   - everything_folder_size : recursive folder size from the index (instant)
 *   - everything_syntax      : full Everything query syntax reference (bundled syntax.md)
 *   - everything_status      : es.exe + service + index freshness diagnostics
 *
 * Deploy: copy this folder to ~/.pi/agent/extensions/everything-search/
 * Requires (Windows): es.exe in PATH and the Everything service running.
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
 *   - Several 1.5 search functions (depth:, count:, unique:, distinct:,
 *     dupe-min:, dupe-count:, len:, to-number:, hex:, size-on-disk:,
 *     child-count:, si:, &sp: entities) return 0 via es.exe in this
 *     build — documented in syntax.md under "Do NOT use with this es.exe build".
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  escapeForRegex,
  formatAnchoredLine,
  looksLikeBinary,
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
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
// Hard cap on response text: ~110 paths at typical average path length,
// just above the default limit of 100.
const MAX_OUTPUT_BYTES = 15 * 1024;
// Upper bound on the length of the "[truncated at …]" marker; reserved from
// the byte budget so content + marker never exceeds MAX_OUTPUT_BYTES.
const TRUNCATION_MARKER_RESERVE = 200;

// everything_grep — content scan over an Everything-index-selected file list;
// output shapes are byte-compatible with the grep tool's hashline rendering.
const MAX_CANDIDATE_FILES = 2000; // refuse above: caller must narrow the query
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than this
const GREP_MAX_MATCHES_PER_FILE = 10; // per-file cap (applied when total > 50)
const GREP_TRUNCATION_THRESHOLD = 50; // per-file cap activates above this total
const GREP_DEFAULT_LIMIT = 100;
// 20 KB (not the pi-core default 500 KB): a single tool response stays small
// and the scan stops as soon as this budget is full — no post-hoc cut of a
// larger result.
const GREP_OUTPUT_MAX_BYTES = Math.min(DEFAULT_MAX_BYTES, 20 * 1024);
// Footer appended when any displayed line hit the 500-char cap (parity text
// with pi's builtin grep). 500 = pi's builtin grep per-line threshold
// (GREP_MAX_LINE_LENGTH in pi-core's truncate module; not re-exported from
// the package root, so it is stated literally here).
const LINE_TRUNC_FOOTER = "[Some lines truncated to 500 chars. Use read tool to see full lines]";
// Worst-case suffix block (limit marker + line-cap footer + budget marker,
// incl. the blank line before it) reserved from the scan budget so the
// FINAL text never exceeds the cap.
const GREP_MARKER_RESERVE = 320;

// es 1.5 returns this from -get-total-size when the result set is empty.
// Compared as a string: 2^64-1 exceeds Number.MAX_SAFE_INTEGER, so a numeric
// literal would silently round to 2^64.
const UINT64_MAX_STR = "18446744073709551615";
// `\` before an operator = escape in Everything (the operator becomes literal
// text); warn on it — a common LLM JSON-escape mistake (`\ext:ts` -> 0 results).
const ESCAPED_OPERATOR_RE =
  /\\(ext|path|size|dm|dc|da|parent-name|parent|stem|file|folder|regex|type|attrib|zone|resulttype)\b/i;

// Property columns verified live with -add-columns (es 1.1.0.37, 2026-09-10).
// es.exe rejects unknown names with "Error 4: Unknown column".
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
      });
      return;
    }
    let child;
    try {
      child = spawn("es.exe", args, { windowsHide: true });
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
      });
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      finish({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errBuf),
        code: null,
        spawnError: new Error("aborted"),
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

function esFailureMessage(o: EsOutcome, query: string): string {
  if (o.spawnError) {
    const code = (o.spawnError as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return (
        "es.exe not found in PATH. Install the Everything CLI from " +
        "https://www.voidtools.com/downloads/#cli and add its folder to PATH, " +
        "then retry. (Fallback until then: use find/grep.)"
      );
    }
    return `Could not start es.exe: ${o.spawnError.message}. Run everything_status to diagnose.`;
  }
  if (o.timedOut) {
    return (
      `es.exe timed out after ${ES_TIMEOUT_MS / 1000}s. content: searches scan ` +
      "file contents and can be slow — narrow the query (add parent:, ext:, or " +
      `size: constraints) or drop the content: term. Query was: ${query}`
    );
  }
  const stderr = o.stderr.toString("utf-8").trim();
  if (o.code !== 0) {
    return (
      `es.exe exited with code ${o.code}. ` +
      (stderr ? `stderr: ${stderr}. ` : "") +
      "Run everything_status to check the Everything service and index state."
    );
  }
  return `es.exe failed unexpectedly for query: ${query}`;
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// es 1.5 returns 2^64-1 from -get-total-size for zero-result queries.
function totalSizeOf(res: EsOutcome | null): number | null {
  if (!res || res.spawnError || res.code !== 0) return null;
  const raw = res.stdout.toString("utf-8").trim();
  if (raw === UINT64_MAX_STR) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// Minimal CSV line parser for the es.exe -export-csv fallback (paths with commas
// are double-quoted, "" = literal quote). Joins fields with tabs so downstream
// TSV-shaped handling is unchanged.
function csvLineToTabs(line: string): string {
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
// ES list fetch — shared by everything_search and everything_grep
// ---------------------------------------------------------------------------

interface EsQueryPrep {
  esQuery: string;
  escapeWarning: string;
}

function prepareEsQuery(query: string): EsQueryPrep {
  const esQuery = query;

  // LLM JSON-escape guard: `\ext:ts` parses in Everything as the literal
  // text "ext:ts" (backslash = escape char) and silently matches nothing.
  // Warn instead of failing silently (verified 2026-09-10: ext:ts -> 228,755;
  // \ext:ts -> 0).
  const escMatch = ESCAPED_OPERATOR_RE.exec(query);
  const escapeWarning = escMatch
    ? `Warning: query contains '\\${escMatch[1]}:' — in Everything a backslash escapes the next character, so '${escMatch[1]}:…' was searched as plain text. Remove the backslash to use the operator.\n`
    : "";

  return { esQuery, escapeWarning };
}

// es.exe treats each command-line argument as ONE search; separate
// arguments are ANDed server-side. A single argument containing spaces is
// evaluated as a phrase (literal substring) — verified 2026-09-12.
// Queries are therefore split into terms before spawning. Double quotes
// group a term (e.g. a phrase) exactly like the shell does.
function splitQueryTerms(q: string): string[] {
  const terms: string[] = [];
  let cur = "";
  let inQuotes = false;
  let has = false;
  for (const ch of q) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      has = true;
      continue;
    }
    if (ch.trim() === "" && !inQuotes) {
      if (has && cur !== "") terms.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has && cur !== "") terms.push(cur);
  return terms;
}

function matchFlagArgs(o: {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  matchPath?: boolean;
  diacritics?: boolean;
}): string[] {
  const flags: string[] = [];
  if (o.regex) flags.push("-regex");
  if (o.caseSensitive) flags.push("-case");
  if (o.wholeWord) flags.push("-whole-word");
  if (o.matchPath) flags.push("-match-path");
  if (o.diacritics) flags.push("-a");
  return flags;
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
  const sortArgs = o.sort ? ["-sort", `${o.sort}-${o.order ?? "ascending"}`] : [];

  const tmpFile = join(
    tmpdir(),
    `pi-es-${process.pid}-${randomBytes(4).toString("hex")}.${o.detailsMode ? "tsv" : "txt"}`,
  );
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
    "-n", String(o.fetchCount),
    ...sortArgs,
    ...matchFlags,
    ...splitQueryTerms(esQuery),
  ];

  const totalSizeP = o.totalSize
    ? runEs(["-get-total-size", ...matchFlags, ...splitQueryTerms(esQuery)], o.signal, 15_000)
    : null;
  const [countRes, resFirst, tsRes] = await Promise.all([
    runEs(["-get-result-count", ...matchFlags, ...splitQueryTerms(esQuery)], o.signal, 15_000),
    runEs(resultArgs, o.signal),
    totalSizeP ?? Promise.resolve(null),
  ]);

  // -export-tsv is unknown to es.exe from the Everything 1.4 era (exit 6).
  // Fall back to CSV (UTF-8) and convert lines to tab shape.
  let res = resFirst;
  let outFile = tmpFile;
  let csvMode = false;
  if (res.spawnError || res.code !== 0) {
    if (!(o.detailsMode && res.code === 6 && !res.spawnError)) {
      throw new Error(esFailureMessage(res, esQuery));
    }
    csvMode = true;
    outFile = tmpFile.replace(/\.tsv$/, ".csv");
    const csvArgs = resultArgs.flatMap((a) =>
      a === "-export-tsv" ? ["-export-csv", outFile] : [a],
    );
    res = await runEs(csvArgs, o.signal);
    if (res.spawnError || res.code !== 0) {
      throw new Error(esFailureMessage(res, esQuery));
    }
  }

  try {
    if (!existsSync(outFile)) {
      throw new Error(
        "es.exe produced no output file. Run everything_status to check the " +
          "Everything service and index state.",
      );
    }
    const raw = readFileSync(outFile, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => (csvMode ? csvLineToTabs(l) : l))
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0);
    const total = (() => {
      if (countRes.spawnError || countRes.code !== 0) return null;
      const n = parseInt(countRes.stdout.toString("utf-8").trim(), 10);
      return Number.isNaN(n) ? null : n;
    })();
    return {
      esQuery,      escapeWarning,
      total,
      totalSizeBytes: totalSizeOf(tsRes),
      lines,
      csvFallback: csvMode,
    };
  } finally {
    try {
      rmSync(tmpFile, { force: true });
      if (csvMode) rmSync(tmpFile.replace(/\.tsv$/, ".csv"), { force: true });
    } catch {
      // best-effort cleanup
    }
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
    out.push(
      `${group.displayPath}:${marker}${formatAnchoredLine(e.ln, content, display)}`,
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
  esPath?: string;
  indexCount?: number;
  lastChange?: string;
  stale: boolean;
  detail?: string;
  checkedAt: number;
}

let health: Health | null = null;
let healthInFlight: Promise<Health> | null = null;

async function checkHealth(): Promise<Health> {
  if (health) return health;
  if (healthInFlight) return healthInFlight;
  healthInFlight = (async () => {
    const h: Health = { ok: false, stale: false, checkedAt: Date.now() };
    const v = await runEs(["-version"], undefined, 5000);
    if (v.spawnError) {
      h.detail =
        `es.exe not found in PATH (or not startable): ${v.spawnError.message}. ` +
        "Install the Everything CLI from https://www.voidtools.com/downloads/#cli " +
        "and add its folder to PATH.";
      return h;
    }
    h.esVersion = v.stdout.toString("utf-8").trim().split(/\r?\n/)[0] || undefined;
    try {
      const where = spawnSync("where", ["es.exe"], { encoding: "utf-8" });
      if (where.status === 0) {
        h.esPath = where.stdout.trim().split(/\r?\n/)[0];
      }
    } catch {
      // non-fatal
    }
    const c = await runEs(["-get-result-count", "*"], undefined, 10_000);
    if (c.spawnError || c.code !== 0) {
      const stderr = c.stderr.toString("utf-8").trim();
      h.detail =
        `es.exe exists${h.esVersion ? ` (v${h.esVersion})` : ""} but the ` +
        "Everything service is not responding. Start the Everything app " +
        "(Everything.exe) — its background service serves the index to es.exe. " +
        (stderr ? `Details: ${stderr}` : `exit code ${c.code}`);
      return h;
    }
    h.indexCount = parseInt(c.stdout.toString("utf-8").trim(), 10);
    const m = await runEs(
      [
        "-n", "1",
        "-date-modified", "-date-format", "1",
        "-sort", "date-modified-descending",
        "*",
      ],
      undefined,
      10_000,
    );
    if (!m.spawnError && m.code === 0) {
      const firstLine = m.stdout
        .toString("utf-8")
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0);
      if (firstLine) {
        const t = Date.parse(firstLine.split(/\s+/)[0]);
        if (!Number.isNaN(t)) {
          h.lastChange = firstLine.split(/\s+/)[0];
          h.stale = Date.now() - t > STALE_AFTER_MS;
        }
      }
    }
    h.ok = true;
    return h;
  })();
  const h = await healthInFlight;
  healthInFlight = null;
  health = h;
  return h;
}

function statusReport(h: Health): string {
  const lines: string[] = [];
  lines.push(`es.exe: ${h.esVersion ?? "not found"}${h.esPath ? ` at ${h.esPath}` : ""}`);
  if (h.ok) {
    lines.push("Everything service: OK");
    if (h.indexCount != null && !Number.isNaN(h.indexCount)) {
      lines.push(`Indexed items: ${h.indexCount.toLocaleString("en-US")}`);
    }
    if (h.lastChange) {
      const days = Math.max(
        0,
        Math.round((Date.now() - Date.parse(h.lastChange)) / 86_400_000),
      );
      lines.push(`Index most recent file change: ${h.lastChange} (${days} day(s) ago)`);
      if (h.stale) {
        lines.push(
          "WARNING: index may be stale — no file changes visible in the index in " +
            "the last 24h (either the machine has been idle, or USN journal " +
            "monitoring is off in Everything options: Options → Indexing → drive → " +
            "'Watch USN journal'). Files created or renamed after the date above " +
            "may NOT be found — verify by searching a file you know is recent, or " +
            "reindex Everything.",
        );
      }
    }
    lines.push(
      "Everything search is operational: prefer everything_search over " +
        "find/glob/ls for local file discovery.",
    );
  } else {
    lines.push("Everything service: NOT AVAILABLE");
    lines.push(h.detail ?? "Unknown failure — re-run everything_status.");
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
): string {
  const off = offset > 0 ? ` after offset ${offset}` : "";
  const head =
    total != null
      ? `${total.toLocaleString("en-US")} matching (showing ${shown}${off})`
      : `showing ${shown}${off}`;
  return `${head}\nquery: ${query}\n${bodyLines.join("\n")}`;
}

function noResultsText(query: string): string {
  return (
    `No results found for: ${query}\n` +
    "Tips: check query syntax with everything_syntax. If you expected results, " +
    "run everything_status to verify the service and index freshness " +
    "(files created after a stale index snapshot will be missing)."
  );
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
  "Call everything_syntax for the full verified reference (including terms broken " +
  "on this 1.5 beta).";

const SEARCH_DESCRIPTION =
  "Search the local Windows filesystem with the Everything index — instant, " +
  "machine-wide (typically <100 ms). PREFER this over find/ls/glob or bash directory " +
  "scans for file-by-name/path/extension/size/date questions; use everything_grep " +
  "for file CONTENTS (it reuses this index to pick the files, so the scan skips " +
  "the directory walk). count_only=true returns just the count; output capped at " +
  "15KB / 2000 lines. Windows only.";

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
          description: "Skip the first N matches (paginate with limit).",
        }),
      ),
      sort: Type.Optional(
        StringEnum(
          [
            "name",
            "path",
            "size",
            "extension",
            "date-created",
            "date-modified",
            "date-accessed",
            "date-recently-changed",
            "attributes",
          ],
          {
            description:
              "Sort results by this field (default: index order, typically name).",
          },
        ),
      ),
      order: Type.Optional(
        StringEnum(["ascending", "descending"], {
          description: "Sort direction (default ascending; requires sort).",
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
          description: "Return only the total match count, no paths (limit is ignored). For any query that could match many files, run this FIRST to size the answer before fetching — combine with total_size for bytes.",
        }),
      ),
      regex: Type.Optional(
        Type.Boolean({ description: "Treat the query as a regular expression." }),
      ),
      case_sensitive: Type.Optional(
        Type.Boolean({ description: "Case-sensitive matching (default: case-insensitive)." }),
      ),
      whole_word: Type.Optional(
        Type.Boolean({ description: "Match whole words only." }),
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
            "Match diacritical marks exactly (é does not match e). Default: diacritics are ignored.",
        }),
      ),
      total_size: Type.Optional(
        Type.Boolean({
          description:
            "Also return the total size (bytes) of ALL matches for the query.",
        }),
      ),
      columns: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Extra property columns per result (implies details), e.g. width, height, " +
            "date-taken, artist, album, author, page-count, latitude. Invalid names " +
            "are rejected with the full 55-name allowlist.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      if (!query) throw new Error("query must be a non-empty string");
      const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
      const offset = Math.max(0, Math.floor(params.offset ?? 0));

      const prep = prepareEsQuery(query);

      const extraCols = params.columns ?? [];
      const badCols = extraCols.filter((c) => !COLUMN_ALLOWLIST.includes(c));
      if (badCols.length > 0) {
        throw new Error(
          `Unknown column(s) for everything_search: ${[...new Set(badCols)].join(", ")}. ` +
            `Allowed: ${COLUMN_ALLOWLIST.join(", ")}`,
        );
      }
      const detailsMode = params.details === true || extraCols.length > 0;

      // count_only / total_size: fast calls, no result fetch
      if (params.count_only) {
        const matchFlags = matchFlagArgs({
          regex: params.regex,
          caseSensitive: params.case_sensitive,
          wholeWord: params.whole_word,
          matchPath: params.match_path,
          diacritics: params.diacritics,
        });
        const totalSizeP = params.total_size
          ? runEs(["-get-total-size", ...matchFlags, ...splitQueryTerms(prep.esQuery)], signal, 15_000)
          : null;
        const [r, ts] = await Promise.all([
          runEs(["-get-result-count", ...matchFlags, ...splitQueryTerms(prep.esQuery)], signal, 15_000),
          totalSizeP ?? Promise.resolve(null),
        ]);
        if (r.spawnError || r.code !== 0) throw new Error(esFailureMessage(r, prep.esQuery));
        const total = parseInt(r.stdout.toString("utf-8").trim(), 10);
        const n = Number.isNaN(total) ? 0 : total;
        const totalBytes = totalSizeOf(ts);
        const sizeLine =
          totalBytes != null
            ? `\ntotal size: ${fmtBytes(totalBytes)} (${totalBytes.toLocaleString("en-US")} bytes)`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `${prep.escapeWarning}${n.toLocaleString("en-US")} file(s) match: ${query}${sizeLine}`,
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
            totalSizeBytes: totalBytes,
            csvFallback: false,
            truncated: false,
          },
        };
      }

      const fetchCount = Math.min(offset + limit, MAX_FETCH);
      const list = await fetchEsList({
        query,
        regex: params.regex,
        caseSensitive: params.case_sensitive,
        wholeWord: params.whole_word,
        matchPath: params.match_path,
        diacritics: params.diacritics,
        sort: params.sort,
        order: params.order,
        fetchCount,
        detailsMode,
        extraCols,
        totalSize: params.total_size,
        signal,
      });

      const lines = list.lines.slice(offset, offset + limit);
      const total = list.total;
      const totalBytes = list.totalSizeBytes;

      let text: string;
      if (lines.length === 0) {
        text =
          total != null && total > 0
            ? `${total.toLocaleString("en-US")} matching, but none in this window (offset ${offset}, limit ${limit}). Lower the offset or raise the limit.`
            : noResultsText(query);
      } else {
        const header =
          extraCols.length > 0
            ? `path\tsize-bytes\tdate-modified\t${extraCols.join("\t")}`
            : "path\tsize-bytes\tdate-modified";
        const body = detailsMode ? [header, ...lines] : lines;
        text = buildResultText(query, total, offset, lines.length, body);
      }
      if (totalBytes != null) {
        text += `\ntotal size: ${fmtBytes(totalBytes)} (${totalBytes.toLocaleString("en-US")} bytes)`;
      }
      if (prep.escapeWarning) text = prep.escapeWarning + text;

      // Reserve the marker's bytes in the budget so the FINAL response
      // (content + marker) never exceeds MAX_OUTPUT_BYTES. truncateHead
      // never emits partial lines, so rows stay fully intact.
      const trunc = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: MAX_OUTPUT_BYTES - TRUNCATION_MARKER_RESERVE,
      });
      const outText = trunc.truncated
        ? `${trunc.content}\n[truncated at ${trunc.truncatedBy === "bytes" ? "15KB" : `${trunc.maxLines} lines`}: showing ${trunc.outputLines} of ${trunc.totalLines} lines — refine the query, drop columns/details, or lower limit/offset]`
        : trunc.content;
      return {
        content: [{ type: "text", text: outText }],
        details: {
          query,
                    esQuery: prep.esQuery,
          total,
          shown: lines.length,
          offset,
          withDetails: detailsMode,
          columns: extraCols,
          totalSizeBytes: totalBytes,
          csvFallback: list.csvFallback,
          truncated: trunc.truncated,
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
      "(LINE:HASH anchors, same headers, summary mode, truncation markers), " +
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
          "Pattern to find in file contents. Regular expression by default; pass " +
          "literal=true to match exactly.",
      }),
      query: Type.Optional(
        Type.String({
          description:
            "Everything index query selecting the candidate files (same syntax as " +
            "everything_search). Omit to search the current project directory " +
            "(ancestor:<cwd>, excluding node_modules and .git). Examples: " +
            `"ext:ts ancestor:C:\\proj !path:node_modules", "size:>10mb dm:today".`,
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
            "merge; a line that is both match and context renders as a match).",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Max matches to return (default ${GREP_DEFAULT_LIMIT}).`,
        }),
      ),
      summary: Type.Optional(
        Type.Boolean({
          description:
            "Per-file match counts only (one line per file, count descending) — " +
            "no line content, no anchors.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pattern = params.pattern;
      if (!pattern) throw new Error("pattern must be a non-empty string");
      let re: RegExp;
      try {
        re = new RegExp(
          params.literal ? escapeForRegex(pattern) : pattern,
          params.ignoreCase ? "i" : "",
        );
      } catch (err) {
        throw new Error(
          `Invalid pattern: ${pattern} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const effectiveLimit = Math.max(1, params.limit ?? GREP_DEFAULT_LIMIT);
      const context = Math.max(0, Math.floor(params.context ?? 0));
      const cwd = ctx?.cwd ?? process.cwd();
      const userQuery = params.query?.trim();
      const esQuery = userQuery || `ancestor:${cwd} !path:node_modules !path:.git`;

      const list = await fetchEsList({
        query: esQuery,
        fetchCount: MAX_CANDIDATE_FILES + 1,
        detailsMode: false,
        extraCols: [],
        signal,
      });

      if (
        (list.total != null && list.total > MAX_CANDIDATE_FILES) ||
        list.lines.length > MAX_CANDIDATE_FILES
      ) {
        throw new Error(
          `Candidate cap: ${list.total != null ? list.total.toLocaleString("en-US") : "more than"} ` +
            `${MAX_CANDIDATE_FILES} files matched the query (cap ${MAX_CANDIDATE_FILES}). ` +
            "Narrow the query (ext:, ancestor:, size:, !path:).",
        );
      }
      const candidates = list.lines.slice(0, MAX_CANDIDATE_FILES);

      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: "[0 matches in 0 files]" }],
          details: {
            pattern,
            query: userQuery ?? null,
            esQuery: list.esQuery,
                        candidates: 0,
            matches: 0,
            files: 0,
            skippedBinary: 0,
            skippedMissing: 0,
            skippedBig: 0,
            perFileCapApplied: false,
            budgetStopped: false,
            candidatesNotScanned: 0,
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
        status: "unscanned" | "ok" | "binary" | "missing" | "big";
      }
      const files: GrepCandidate[] = candidates.map((abs) => ({
        abs,
        lines: null,
        matches: [],
        status: "unscanned" as const,
      }));
      let skippedBinary = 0;
      let skippedMissing = 0;
      let skippedBig = 0;
      let totalMatches = 0;
      let stop = false;
      let budgetStopped = false;
      let perFileCapApplied = false;
      let anyLineTruncated = false;

      const summaryMode = params.summary === true;
      const groupBlocks: string[][] = []; // rendered lines per matching file
      let renderedBytes = 0;
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
        for (let i = 0; i < groupLines.length; i++) {
          const nb = b + byteLen(groupLines[i]) + 1;
          if (renderedBytes + nb > budget) {
            hitBudget = true;
            break;
          }
          kept.push(groupLines[i]);
          b += byteLen(groupLines[i]) + 1;
          if (lineFlags[i]) anyLineTruncated = true;
        }
        if (kept.length > 0) groupBlocks.push(kept);
        renderedBytes += b;
        return hitBudget;
      };

      // runningMatches = matches found in files BEFORE the current one. The
      // per-file cap (10/file) applies to a file when the total INCLUDING its
      // own matches exceeds 50 — reference behavior in every case except the
      // boundary where a file of >10 matches still leaves the total ≤ 50
      // (that file renders in full, bounded by 50 lines).
      let runningMatches = 0;
      for (let i = 0; i < files.length && !stop; i++) {
        const f = files[i];
        let buf: Buffer;
        try {
          buf = readFileSync(f.abs);
        } catch {
          f.status = "missing";
          skippedMissing++;
          continue;
        }
        if (looksLikeBinary(buf)) {
          f.status = "binary";
          skippedBinary++;
          continue;
        }
        if (buf.length > MAX_GREP_FILE_BYTES) {
          f.status = "big";
          skippedBig++;
          continue;
        }
        const lines = buf
          .toString("utf-8")
          .replace(/^\uFEFF/, "")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .split("\n");
        f.lines = lines;
        f.status = "ok";
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
          if (applyCap) perFileCapApplied = true;
          if (renderFile(f, applyCap)) {
            stop = true;
            budgetStopped = true;
          }
          runningMatches += f.matches.length;
        }
      }

      // Single binary candidate → explain the silence (grep skips binaries).
      if (candidates.length === 1 && files[0].status === "binary") {
        return {
          content: [
            {
              type: "text",
              text: `[Warning: '${candidates[0]}' appears to be a binary file — grep skips binary files by default. Use a hex tool or the read tool to inspect it.]`,
            },
          ],
          details: {
            pattern,
            query: userQuery ?? null,
            esQuery: list.esQuery,
                        candidates: 1,
            matches: 0,
            files: 0,
            skippedBinary: 1,
            skippedMissing: 0,
            skippedBig: 0,
            perFileCapApplied: false,
            budgetStopped: false,
            candidatesNotScanned: 0,
          },
        };
      }

      const matchedFiles = files.filter((f) => f.matches.length > 0);
      const fileCount = matchedFiles.length;
      let text: string;
      if (summaryMode) {
        // Summary = count-only; the scan always completes (counts are the
        // point), the budget only bounds the file list (head-first).
        const fileLines = [...matchedFiles]
          .sort((a, b) => b.matches.length - a.matches.length)
          .map((f) => `${f.abs}: ${f.matches.length} matches`);
        const header = `[${totalMatches} matches in ${fileCount} files]`;
        const sumBudget = GREP_OUTPUT_MAX_BYTES - GREP_MARKER_RESERVE;
        const kept: string[] = [];
        let b = byteLen(header) + 1;
        for (const l of fileLines) {
          const nb = b + byteLen(l) + 1;
          if (nb > sumBudget) break;
          kept.push(l);
          b = nb;
        }
        text = [header, ...kept].join("\n");
        if (kept.length < fileLines.length) {
          text += `\n\n[everything_grep: output budget (${formatSize(GREP_OUTPUT_MAX_BYTES)}) reached — showing ${kept.length} of ${fileLines.length} file lines. Narrow the query.]`;
        }
      } else {
        const header = `[${totalMatches} matches in ${fileCount} files]`;
        text = [header, ...groupBlocks.flat()].join("\n");
        const suffixes: string[] = [];
        if (totalMatches >= effectiveLimit) {
          suffixes.push(
            `[Results truncated at ${effectiveLimit} matches — refine pattern or increase limit]`,
          );
        }
        if (anyLineTruncated) suffixes.push(LINE_TRUNC_FOOTER);
        if (budgetStopped) {
          const notScanned = files.filter((f) => f.status === "unscanned").length;
          suffixes.push(
            `[everything_grep: output budget (${formatSize(GREP_OUTPUT_MAX_BYTES)}) reached after ` +
              `${totalMatches} matches in ${fileCount} files. ${notScanned} candidate ` +
              `files not scanned. Narrow the pattern or query, or use summary mode.]`,
          );
        }
        if (suffixes.length > 0) text += "\n\n" + suffixes.join("\n");
      }

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
        budgetStopped = true;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          pattern,
          query: userQuery ?? null,
          esQuery: list.esQuery,
                    candidatesTotal: list.total,
          candidatesScanned: files.filter((f) => f.status === "ok").length,
          candidatesNotScanned: files.filter((f) => f.status === "unscanned").length,
          matches: totalMatches,
          files: fileCount,
          skippedBinary,
          skippedMissing,
          skippedBig,
          perFileCapApplied,
          budgetStopped,
        },
      };
    },
  });
  // ---- everything_folder_size ---------------------------------------------

  pi.registerTool({
    name: "everything_folder_size",
    label: "Everything Folder Size",
    description:
      "Recursive total size of a folder from the Everything index (instant, no disk " +
      "scan). Pass a folder path (absolute preferred) or a unique folder name. " +
      "Returns human-readable + raw bytes.",
    promptSnippet:
      "Recursive folder size from the Everything index.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Folder to size recursively (absolute path preferred, or a unique name).",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const target = params.path.trim();
      if (!target) throw new Error("path must be a non-empty string");
      const r = await runEs(["-get-folder-size", target], signal, 30_000);
      if (r.spawnError || r.code !== 0) throw new Error(esFailureMessage(r, target));
      const out = r.stdout.toString("utf-8").trim();
      const n = Number(out);
      if (!Number.isFinite(n) || n < 0 || String(n) !== out) {
        throw new Error(
          `Could not parse folder size for: ${target} (got: ${out || "empty output"}). ` +
            "Check the path exists in the index (everything_search can verify it).",
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `${target}: ${fmtBytes(n)} (${n.toLocaleString("en-US")} bytes, recursive, from index)`,
          },
        ],
        details: { path: target, sizeBytes: n },
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
      const extra = params.include_columns
        ? `\n\n## Property column allowlist (all 55, verified)\n${COLUMN_ALLOWLIST.join(", ")}`
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
      "Diagnose Everything: es.exe presence/version, service reachability, indexed " +
      "item count, index freshness (a stale index misses recently created files). " +
      "Use when everything_search errors, hangs, or misses files you know exist.",
    promptSnippet:
      "Everything setup health (es.exe, service, index size/freshness).",
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description: "Re-check even if a recent health result is cached.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (params.force) health = null;
      void signal; // health check uses its own short timeouts
      const h = await checkHealth();
      return {
        content: [{ type: "text", text: statusReport(h) }],
        details: h,
      };
    },
  });
}
