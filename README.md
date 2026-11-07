# pi-everything (pi extension)

Instant, machine-wide file search for the pi coding agent on Windows, backed by
the [Everything](https://www.voidtools.com/) index.

**Everything** is a Windows desktop search utility that indexes file and folder
names in real time — a filename search across the whole computer returns results
in milliseconds, with no directory walk and no waiting on a disk scan. This
extension recreates the
[CodingRookie98/everything-search](https://github.com/CodingRookie98/everything-search) skill (MIT) as
native pi tools wired directly to the index via `es.exe`.

## Tools

| Tool | Purpose |
|---|---|
| `everything_search` | Machine-wide instant file search by name, path, extension, size or date. Content search is `everything_grep` — the `content:` query function is un-indexed on a typical Everything install and is refused as a candidate scope here. Params: `query`, `limit`, `offset`, `sort`, `order`, `details`, `count_only`, `total_size`, `columns`, `regex`, `case_sensitive`, `whole_word`, `match_path`, `diacritics`. |
| `everything_grep` | Content search without the directory walk: `query` selects candidate files from the index (same syntax as `everything_search`; defaults to the current project, excluding node_modules/.git), then an in-process scan. Params: `pattern`, `query`, `ignoreCase`, `literal`, `context`, `limit`, `summary`. Output is hashline-anchored (`LINE:HASH|content`) — byte-compatible with the grep tool, feeds the edit tool. |
| `everything_folder_size` | Recursive folder size from the index (instant, no disk scan). Param: `path`. |
| `everything_syntax` | Returns the bundled full query-syntax reference (`syntax.md`) — agents call it when they need syntax beyond basics. Optional `include_columns: true` also returns the full 55-name property-column allowlist. |
| `everything_status` | Diagnostics: es.exe presence, version and path, whether the running Everything **app** answers es.exe (there is no Windows service to start or query), indexed item count, and index freshness (stale-index warning). |

**`everything_grep` output budget.** Output is capped at 20 KB and the scan stops as soon as the budget (or `limit`) is full — candidate files after that are not read, and the marker says so: `[everything_grep: output budget (20.0KB) reached after N matches in M files. K of C candidate files not scanned. …]`, where `C` is the whole candidate list so the count carries its own denominator, and folder candidates get a clause of their own.
Lines over 500 chars render as their first 500 plus `... [truncated]` (a match row or a context row — the display cap and the anchor run through one path for both), with a footer when any line was cut; the anchor hash is always of the FULL line, so edits still operate on complete content.
Per-file cap: once the running match total passes 50, a file renders at most 10 matches plus a `... +K more matches` note, and only when its own match count also exceeds 10 — a small file past that line prints in full, because nothing was dropped from it.
`summary: true` returns per-file counts only; it is count-only, not exhaustive, so it stops at `limit` as well and names the candidate files it never read.

## How agents learn the syntax

Three layers, so the agent never has to guess:

1. **Always visible** — `everything_search`'s `query` description carries a compact cheat sheet in the tool schema (operators, wildcards, `ext:`, `size:` and its seven constants, `dm:`/`dc:`/`da:`, `parent:`/`ancestor:`/`parent-name:`/`stem:`, `file:`/`folder:`, `regex:x`, the spaced-value rule, the 32,000-byte ceiling). It deliberately
  omits `content:`, the type macros and the property columns — those live in `everything_syntax`.
  `everything_grep`'s `query` names `everything_search` as the syntax owner and carries no cheat sheet of its own.
2. **On demand** — `everything_syntax` returns the full reference (bundled `syntax.md`); pass `include_columns: true` and it also appends the 55-name property-column list.
3. **Self-diagnosis** — `everything_status` plus the error messages name the narrowing to apply when something is off: es.exe missing from `PATH`, the Everything app not answering es.exe, a stale index. A reply starting `Error N: Unknown|Invalid|Unrecognized|Unsupported` is an ARGUMENT problem and says so, so it never sends a caller to look at index health.
  A value outside a declared parameter set is stopped by pi's own call boundary before the tool runs; a key that belongs to no parameter is ignored.

## How agents are steered to prefer it

- Tool description opens with an explicit "PREFER THIS OVER find/ls/glob OR bash directory scans".
- `promptSnippet` puts a one-liner in the system prompt's Available-tools section.
- `promptGuidelines` adds a persistent Guidelines bullet to the system prompt of **every** session (including subagent sessions) that has the tool active: use `everything_search` first for any file discovery; grep only for contents.

## Prerequisites (Windows)

- [Everything](https://www.voidtools.com/) — [installer](https://www.voidtools.com/downloads/#everything)
- `es.exe` (Everything CLI) in PATH — [CLI download](https://www.voidtools.com/downloads/#cli)
- The **Everything app running** (`Everything.exe`; on this project's box it starts from the user's Run key). There is no Windows service to start or query, and none is needed.
- Recommended Everything options: **index folder size** (which `everything_folder_size` and the `size:` figures depend on) and the **USN journal with change monitoring** on each volume you want searched. Which volumes Everything watches and which properties it indexes decide what these tools can answer — those are your Everything options, not extension settings. Reference screenshots in `docs/options-screenshots/`.
- es.exe **1.1.0.37 or newer** if you need a search-function value that contains a space (`ancestor:"C:\Program Files"`): that release added `-argv`, which is what carries the quoted value. Older builds keep the old argument shape, and the tools warn where such a query would otherwise answer a false zero or a plausible WRONG non-zero.
- Tested against Everything 1.5.0.1423 + es.exe 1.1.0.37; 1.4-era es.exe also works (automatic CSV fallback in details mode)

## Install

The easiest way — from npm (pi.dev gallery):

```
pi install npm:pi-everything
```

(Windows only — Everything is a Windows file index. See Prerequisites below.)

The manual deploy below still works if you prefer clone-and-copy.
## Deploy

Copy the extension files into pi's global extensions directory as its own
folder:

```
~/.pi/agent/extensions/everything-search/
├── index.ts
├── grep-core.ts
├── syntax.md
└── README.md
```

Auto-discovered (`~/.pi/agent/extensions/*/index.ts`); hot-reloadable with `/reload`. No `package.json`/`node_modules` needed — `typebox`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` resolve from pi's own install via jiti.

## Implementation notes (measured against es.exe 1.1.0.37 + Everything 1.5.0.1423; behaviour re-derived 2026-11-07)

- **UTF-8 via export files**: `es.exe` stdout uses the environment OEM codepage (é→0x8A in cp850, CJK→`?` — lossy). Results are always captured with `-export-txt` / `-export-tsv` (verified UTF-8), read as UTF-8, temp file deleted after.
- **Sort quirk**: direction must be hyphen-joined (`-sort size-descending`); space-separated (`-sort size descending`) silently treats the direction as a second search term and returns nothing. The extension always passes an explicit hyphen-joined direction.
- **Pagination**: `-n N` fetches N; `-viewport-offset` only skips within that fetch. The extension fetches `offset+limit` (capped at 2000) and slices locally.
- **Counts**: total matches come from `-get-result-count` (parallel with the results call, both ~50 ms).
- **Details**: `-full-path-and-name -size -date-modified -date-format 1 -no-header -export-tsv` gives `path<TAB>size-bytes<TAB>ISO-date`.
- **1.4 fallback**: `-export-tsv` is unknown to es.exe from the Everything 1.4 era (exit code 6). Details mode then retries with `-export-csv` (also UTF-8) and converts quoted CSV lines to tab shape, so the extension works with both 1.4-era and 1.5-era es.exe.
- **Total size**: `-get-total-size` is summed from the index and cheap at every scale measured here (39-48 ms, up to a whole index). It covers FILE rows only and the answer's own line names that population, because a folder row is a row that contributes no bytes. The 1.5 beta returns 2⁶⁴−1 for zero-result queries; that sentinel means 0 bytes only when the count is 0 or unknown.
- **Property columns**: `-add-columns` accepts 55 verified property names, allow-listed in `index.ts` — an unknown name is refused before es.exe is spawned (es.exe itself answers `Error 4: Unknown column`). The `columns` parameter description names all 55 with the measured claims (which file kind fills one, how densely, what a blank means); the section below is the same contract written for a reader, and the two move together.
  `syntax.md` omits the list so agents do not request useless columns, and `everything_syntax` with `include_columns: true` returns it on demand.
  Extra columns imply details mode, and a shell-property column costs about 0.7-1.3 ms per row FETCHED, so ask for few on a large `limit`.
- **Inert and dead 1.5 search functions**: `dupe-min:`, `dupe-max:`, `dupe-count:`, `dupe-from:` and `max-threads:` parse but remove NOTHING, so the answer comes back unfiltered. `to-number:`, `to-integer:`, `hex:`, `si:`, `size-on-disk:` and entity-OR return 0.
  `child-count:`, `child-file-count:` and `descendant-count:` are FOLDER-valued: a files-only partner is an empty intersection, not a dead term. `depth:`, `parent-count:`, `count:`, `unique:`, `distinct:`, `len:`, `to-string:` and `&sp:` all WORK. `syntax.md` carries the class table.
- **Multi-term AND contract**: `es.exe` treats each command-line argument as ONE search, and separate terms are ANDed whether they arrive as separate arguments or inside one argument — everything inside one argument still reaches Everything's own query parser, and its clauses AND just like separate arguments. A literal phrase needs quotes INSIDE the argument.
  `splitQueryTerms()` in index.ts splits terms one per argument (double quotes group a term and are kept in it) and rewrites nothing. Every query term sits behind `--`, because es.exe parses an argument starting with `-` as a switch.
- **`-argv` and quoted values**: a search function reads its value up to the next space, so `ancestor:C:\Program Files` scopes to a folder named `Program` — that zero is real. Quoting is the only way to carry the space, and es.exe's own parser mishandles a caller-supplied escaped quote ([voidtools/ES issue #7](https://github.com/voidtools/ES/issues/7)); `-argv` switches it to native command-line parsing. `runEs` prepends it to every call except the version probe, gated on a memoized probe.
  Write a quoted path with NO trailing backslash: exactly one `\` before a closing quote is dropped.
- **Index freshness**: `everything_status` checks the newest file `date-modified` present in the index (not `date-recently-changed`, which is unreliable post-rebuild). If nothing has been modified in 24h it warns the index *may* be stale (USN monitoring off) — on the reference install USN live updates were verified working (2026-09-09) after a forced rebuild (new files indexed within seconds).

## What the tools refuse, and why

The tools price a query before spending it, and they say what they refused instead of answering slowly or answering
nothing. Every refusal names the narrowing that would make the query cheap.

- **`sort`** — six of the nine accepted names are free at every scale measured. `attributes`, `date-created` and
  `date-accessed` order EVERY match before they can return a page, so they are refused past 1,500,000 matches rather
  than spending the list budget to order every match and return nothing. That refusal is priced on a pre-count, so a
  query whose count is never asked runs anyway — and its answer says it may have ordered every match.
- **Un-indexed terms** — `dc:`, `da:` and `attrib:` have no index unless you turn those options on, and then their
  count walks the whole index. A `da:` (date-accessed) ask ANDed onto a place term is refused outright: no narrowing
  measured here brings it inside a leash, and how dense the conjunction is cannot be read off the query.
- **Per-entry value functions** — `width:>100`, `latitude:47`, `hard-link-count:>1` and the like test every entry their
  partners leave, so a walk that cannot fit its leash is refused in milliseconds, naming the term and the indexed
  partner (`ext:`, `path:`, `parent:`, `ancestor:`, a `size:` bound) that would make the query countable. Two or more
  such functions in one query are priced at the SUM of their rates, which over-refuses by design.
- **A count that will not answer** is reported, not hidden: the header prints `total unknown` and names the term, and a
  zero-row page carries a note that 0 rows is NOT proof nothing matches when no total answered.
- **Candidate selection is priced differently from a listing** — `everything_grep` selects candidates by fetching 2,001
  rows, so a scope with no indexed narrowing is refused there while `everything_search` with a small `limit` still
  answers the same query: a small fetch can stop early.
- **The 2,000-candidate cap is charged on FILE rows only**, because grep never opens a folder row. A scope whose
  surplus rows are folders gets its candidate list re-fetched with `!attributes:d` and carries a note naming the rows it
  dropped; when the files alone exceed the cap it refuses and quotes the file count.
- **Refused switches** — `-exit`, `-quit`, `-restart`, `-save-settings` and `-save-db` are refused by name, because
  `es -exit` terminates the Everything app and nothing else serves the index. The refusal names the switches it refused
  and says the call was never started, so nobody goes looking for a broken installation.

## Property column names (all 55, verified)

`-add-columns` accepts exactly these names (es.exe rejects anything else with `Error 4: Unknown column`, and through
this tool an unknown name is refused before the spawn). The `columns` parameter description names every one of them
too, beside the measured claims. Whether a column carries a value depends on the FILE KIND, so probe it over the kind
you care about: the filesystem-native columns (`attributes`, `date-created`, `date-accessed`, `hard-link-count`,
`kind`, `parent-name`, `volume-label`, `run-count`) fill folder rows as well, while `extension`, `content-type`,
`file-signature` and every shell media/document column are blank on a folder row — and an `ancestor:` listing returns
subdirectories FIRST, so a property probe over a folder reads as all-blank. Dense names (image, audio and video
technical properties) fill every row of the kind they describe; SPARSE names (photo GPS, camera, audio tags, document
authorship) fill only the files that carry them, which is not dead either — a Word-document corpus, though, is the
wrong scope for the document columns. Five names populated NOTHING for any file kind sampled here (`date-run`,
`date-recently-changed`, `date-acquired` — ask for `date-created` instead — `lens-model`, `people`), and four fill only
legacy OLE documents (`word-count`, `line-count`, `last-author`, `slide-count`). Three spellings mislead:
`attributes` is the NUMERIC Win32 attribute bitfield, not the letters the `attributes:` query takes; `file-signature`
is the MIME type read from the file's BYTES while `content-type` is read from its EXTENSION, so the column that catches
a renamed file is the first; `software` names an installed product and needs an installer. `kind` renders a coarse word
(`document`, `program`, `picture`, `video`, `music`, `folder`) and never filters folders — every `ext:zip` FILE row
reads `folder` beside the folder rows.

`attributes`, `audio-bitrate`, `audio-bits-per-sample`, `audio-channels`, `audio-sample-rate`, `aspect-ratio`, `author`, `last-author`, `album`, `artist`, `bit-depth`, `camera-maker`, `camera-model`, `comment`, `company`, `content-type`, `date-acquired`, `date-accessed`, `date-changed`, `date-created`, `date-run`, `date-recently-changed`, `date-taken`, `extension`, `file-signature`, `f-stop`, `frame-rate`, `genre`, `hard-link-count`, `height`, `iso-speed`, `kind`, `latitude`, `length`, `line-count`, `lens-model`, `longitude`, `page-count`, `parent-name`, `people`, `product-name`, `product-version`, `run-count`, `slide-count`, `software`, `tags`, `title`, `track`, `total-bitrate`, `video-bitrate`, `version`, `volume-label`, `width`, `word-count`, `year`

## Source attribution

Query syntax reference adapted from CodingRookie98/everything-search (MIT License). Not affiliated with voidtools.
