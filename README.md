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
| `everything_search` | Machine-wide instant file search (name/path/extension/size/date/content). Params: `query`, `limit`, `offset`, `sort`, `order`, `details`, `count_only`, `total_size`, `columns`, `regex`, `case_sensitive`, `whole_word`, `match_path`, `diacritics`. |
| `everything_grep` | Content search without the directory walk: `query` selects candidate files from the index (same syntax as `everything_search`; defaults to the current project, excluding node_modules/.git), then an in-process scan. Params: `pattern`, `query`, `ignoreCase`, `literal`, `context`, `limit`, `summary`. Output is hashline-anchored (`LINE:HASH|content`) — byte-compatible with the grep tool, feeds the edit tool. |
| `everything_folder_size` | Recursive folder size from the index (instant, no disk scan). Param: `path`. |
| `everything_syntax` | Returns the bundled full query-syntax reference (`syntax.md`) — agents call it when they need syntax beyond basics. Optional `include_columns: true` also returns the full 55-name property-column allowlist. |
| `everything_status` | Diagnostics: es.exe presence/version/path, service reachability, indexed item count, index freshness (stale-index warning). |

**`everything_grep` output budget.** Output is capped at 20 KB and the scan stops as soon as the budget (or `limit`) is full — candidate files after that are not read, and the marker says so: `[everything_grep: output budget (20 KB) reached after N matches in M files. K candidate files not scanned. …]`. Match lines over 500 chars render as first 500 + `... [truncated]` (parity with the builtin grep tool, plus a footer when any line was cut); the anchor hash is always of the full line, so edits still operate on complete content. Per-file cap: once the running match total passes 50, each file renders at most 10 matches + a `... +K more matches` note. `summary: true` returns per-file counts only (the scan always completes; the budget bounds the file list).

## How agents learn the syntax

Three layers, so the agent never has to guess:

1. **Always visible** — the `query` parameter description carries a compact syntax cheat sheet (operators, wildcards, `size:`/`dm:`/`parent:`/`content:`, type macros, examples) in every tool schema.
2. **On demand** — `everything_syntax` returns the full reference (bundled `syntax.md`); pass `include_columns: true` and it also appends the 55-name property-column list.
3. **Self-diagnosis** — `everything_status` + error messages tell the agent exactly what to do when something is off (es missing, service down, stale index).

## How agents are steered to prefer it

- Tool description opens with an explicit "PREFER THIS OVER find/ls/glob OR bash directory scans".
- `promptSnippet` puts a one-liner in the system prompt's Available-tools section.
- `promptGuidelines` adds a persistent Guidelines bullet to the system prompt of **every** session (including subagent sessions) that has the tool active: use `everything_search` first for any file discovery; grep only for contents.

## Prerequisites (Windows)

- [Everything](https://www.voidtools.com/) — [installer](https://www.voidtools.com/downloads/#everything)
- `es.exe` (Everything CLI) in PATH — [CLI download](https://www.voidtools.com/downloads/#cli)
- Everything service running (start `Everything.exe`)
- Recommended Everything options (index folder size, USN journal, IPC enabled) — reference screenshots in `docs/options-screenshots/`
- Tested against the Everything 1.5.0.1423 beta + es.exe 1.1.0.37; 1.4-era es.exe also works (automatic CSV fallback in details mode)

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

## Implementation notes (verified against es 1.1.0.37 + Everything 1.5.0.1423, 2026-09-10 UTC)

- **UTF-8 via export files**: `es.exe` stdout uses the environment OEM codepage (é→0x8A in cp850, CJK→`?` — lossy). Results are always captured with `-export-txt` / `-export-tsv` (verified UTF-8), read as UTF-8, temp file deleted after.
- **Sort quirk**: direction must be hyphen-joined (`-sort size-descending`); space-separated (`-sort size descending`) silently treats the direction as a second search term and returns nothing. The extension always passes an explicit hyphen-joined direction.
- **Pagination**: `-n N` fetches N; `-viewport-offset` only skips within that fetch. The extension fetches `offset+limit` (capped at 2000) and slices locally.
- **Counts**: total matches come from `-get-result-count` (parallel with the results call, both ~50 ms).
- **Details**: `-full-path-and-name -size -date-modified -date-format 1 -no-header -export-tsv` gives `path<TAB>size-bytes<TAB>ISO-date`.
- **1.4 fallback**: `-export-tsv` is unknown to es.exe from the Everything 1.4 era (exit code 6). Details mode then retries with `-export-csv` (also UTF-8) and converts quoted CSV lines to tab shape, so the extension works with both 1.4-era and 1.5-era es.exe.
- **Total size**: `-get-total-size` (parallel, ~50 ms). The 1.5 beta returns 2⁶⁴−1 for zero-result queries; `totalSizeOf()` maps that sentinel to 0.
- **Property columns**: `-add-columns` accepts 55 verified property names (allow-listed in `index.ts`; es.exe rejects unknown names with `Error 4: Unknown column`). The full list is in the "Property column names" section below; the curated schema/`syntax.md` text deliberately omits it so agents don't request useless columns — `everything_syntax` with `include_columns: true` returns it on demand. Extra columns imply details mode.
- **Broken 1.5 search functions**: `depth:`, `child-count:`, `count:`, `max-threads:`, `unique:`, `distinct:`, `dupe-min/max/count:`, `len:`, `to-number:`, `hex:`, `size-on-disk:`, `si:`, and `&sp:` entities parse but return 0 via es.exe on this build. `syntax.md` documents them under "Do NOT use with this es.exe build" so agents never try them.
- **Multi-term AND contract**: space-separated terms are ANDed — but only as SEPARATE es.exe command-line arguments; ONE argument containing spaces is a phrase (literal substring). `splitQueryTerms()` in index.ts passes query terms as separate arguments (double quotes group a term, e.g. a phrase). No query rewriting is performed.
- **Index freshness**: `everything_status` checks the newest file `date-modified` present in the index (not `date-recently-changed`, which is unreliable post-rebuild). If nothing has been modified in 24h it warns the index *may* be stale (USN monitoring off) — on the reference install USN live updates were verified working (2026-09-09) after a forced rebuild (new files indexed within seconds).

## Property column names (all 55, verified)

`-add-columns` accepts exactly these names (es.exe rejects anything else with `Error 4: Unknown column`). The tool's `columns` parameter description lists only nine common examples by design; this list is the complete reference. Media/document columns (width, height, length, date-taken, artist, ...) are empty for items that lack the property.

`attributes`, `audio-bitrate`, `audio-bits-per-sample`, `audio-channels`, `audio-sample-rate`, `aspect-ratio`, `author`, `last-author`, `album`, `artist`, `bit-depth`, `camera-maker`, `camera-model`, `comment`, `company`, `content-type`, `date-acquired`, `date-accessed`, `date-changed`, `date-created`, `date-run`, `date-recently-changed`, `date-taken`, `extension`, `file-signature`, `f-stop`, `frame-rate`, `genre`, `hard-link-count`, `height`, `iso-speed`, `kind`, `latitude`, `length`, `line-count`, `lens-model`, `longitude`, `page-count`, `parent-name`, `people`, `product-name`, `product-version`, `run-count`, `slide-count`, `software`, `tags`, `title`, `track`, `total-bitrate`, `video-bitrate`, `version`, `volume-label`, `width`, `word-count`, `year`

## Source attribution

Query syntax reference adapted from CodingRookie98/everything-search (MIT License). Not affiliated with voidtools.
