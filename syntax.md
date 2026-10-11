# Everything Query Syntax

Reference for the `everything_search` tool. Verified against a live install (2026-09-10 UTC); where the official docs differ, this file is right.
Everything below was verified live against Everything 1.5.0.1423 + es.exe 1.1.0.37 on the reference install (2026-09-10 UTC). The final section lists 1.5 features that are BROKEN via es.exe on this build — do not use them.

## Operators
- `space` — AND: `a b` = a AND b. **Each term must be a separate es.exe command-line argument** (this tool does that automatically — `splitQueryTerms` in index.ts); ONE argument containing spaces is a phrase (literal substring).
- `|` — OR: `foo|bar`
- `!` — NOT: `!foo`
- `<...>` — grouping: `<abc|123> xyz`
- `"..."` — exact phrase: `"program files"`
- Precedence (official): OR binds TIGHTER than AND — `a b|c` = `a AND (b|c)`.`

## Wildcards (apply to the whole filename)
- `*` — any characters, does NOT cross `\`
- `?` — exactly one character, does NOT cross `\`
- `**` — any characters INCLUDING `\` (1.5): `D:\**\*.heic`
- A plain term without wildcards is a substring match on the filename.

## Type macros
`audio:` `video:` `image:` (alias `pic:`) `doc:` `zip:` `exe:`

## Modifiers (prefix a search term; stackable; disable with `no-` prefix)
- `file:` / `folder:` — files or folders only
- `path:` — match the full path (alias `\:`)
- `case:` / `no-case:` — case-sensitive / case-insensitive
- `whole:` / `wfn:` — whole filename
- `ww:` — whole words only
- `start-with:` / `^:` — start of name; `end-with:` / `$:` — end of name
- `prefix:` / `suffix:` — start/end of words
- `wildcards:` — extended wildcard syntax (`#` digit, `[a-m]`, `[!x]`, `\` escape); `no-wildcards:` disables `*`/`?`
- `soundex:` — phonetic match (A–Z)
- `regex:` — PCRE applied to the following term (or use the tool's `regex: true` flag)
- `diacritics:` — exact accent match (default: `é` matches `e`)
- `ignore-punctuation:` / `ignore-whitespace:` — `spiderman` matches `spider-man` / `spider man`

## Size
`size:` — bytes, or with kb/mb/gb/tb suffix (1 kb = 1024 bytes).
- Operators: `size:>100mb`, `size:<1kb`, `size:1mb..10mb`, `size:==1kb`, `size:!=1kb`, `size:1mb-10mb`
- Constants: `size:empty|tiny|small|medium|large|huge|gigantic` (coarse size buckets; verified working)

## Dates
`dm:` (modified) · `dc:` (created) · `da:` (accessed) · `date-changed:` (any FS entry change)
- Constants: `today`, `yesterday`, `thisweek`, `lastweek`, `thismonth`, `lastmonth`, a year (`2024`), a month name (`january`), a date (`2024-01-15`), day-of-week names
- Durations (1.5): `dm:10mins`, `dm:2days`, `dm:3weeks`, `dm:4months`
- Ranges/comparisons: `dm:2024..2025`, `dm:>2023`, `dm:<today`
- `date-run:` / `run-count:` — files opened via Everything

## Content (SLOW — unindexed, scanned on demand)
- `content:password`, `content:"exact phrase"`
- Always narrow first with `parent:`, `ext:`, or `size:`.

## Path & hierarchy (all verified)
- `parent:<path>` — items DIRECTLY in that folder (absolute path)
- `ancestor:<path>` — items at any depth under that folder
- `parent-name:<text>` — parent folder NAME contains text
- `location:<text>` — parent path contains text
- `stem:<text>` — name without extension; `name:<text>` — name
- `full-path:<text>` — full path contains text
- `root:` — drive roots
- `empty:` — empty folders
- `child:<text>` — folders directly containing a matching item; `descendant:<text>` — any depth; `sibling:<text>` — same folder
- Exclude a drive: `!e:`; multiple drives: `c:|d:`; folder shortcut: `\downloads`

## Duplicates
- `dupe:` — same name in different folders
- `sizedupe:` — same size; `dmdupe:` — same modified date
- `dupe:size;name` — combined (1.5 form)
- Hash functions (SLOW): `md5:<hash>` `sha1:` `sha256:` `crc32:`

## Attributes & system
- `attributes:<letters>` — R read-only, H hidden, S system, D directory, A archive, V device, N normal, T temp, L reparse point, C compressed, O offline, I not-content-indexed, E encrypted (e.g. `attributes:h`, `!attributes:h`). Slow when attribute indexing is off.
- `volume-label:<text>` — files on a volume whose label matches
- `is-running:` — executables currently running
- `hard-link-count:>1` — files with hard links (slow, gathered from disk)
- `ext:` alone = files with NO extension; wildcards allowed: `ext:mp*`

## Examples (all verified working)
- `*.pdf` — all PDFs
- `*.jpg | *.png` — JPG or PNG images (OR)
- `!*.tmp` — not .tmp files
- `size:>1gb` — files over 1 GB
- `dm:lastweek` — everything modified last week
- `doc:` — all documents
- `parent:C:\Users\me\Documents` — items directly under Documents
- `content:password` — files containing "password" (slow — unindexed scan)
- `D:\**\*.heic` — all HEICs under D:
- `whole:readme.txt` — exact filenames
- `empty:` — empty folders
- `is-running:` — what's running
- `C:\Users *.xlsx dm:lastweek` — multi-term AND (terms separated by spaces; this tool passes them as separate arguments)

## Tool parameter mapping
| Need | Parameter |
|---|---|
| Max results | `limit` (default 100, max 500) |
| Pagination | `offset` + `limit` |
| Total count only | `count_only: true` |
| Total size of all matches | `total_size: true` |
| Size + date per result | `details: true` |
| Extra property columns | `columns: ["width","height",...]` (9 example names in the tool schema; the full 55-name list comes from everything_syntax with include_columns=true; media/document columns are empty for items lacking the property) |
| Recursive folder size | `everything_folder_size` tool |
| Sort | `sort` + `order` — name / path / size / extension / date-created / date-modified / date-accessed / date-recently-changed / attributes |
| Regex query | `regex: true` (or `regex:` term) |
| Case-sensitive | `case_sensitive: true` (or `case:` term) |
| Whole words | `whole_word: true` (or `ww:` term) |
| Match full path | `match_path: true` (or `path:` term) |
| Exact diacritics | `diacritics: true` |

## Do NOT use with this es.exe build
Verified broken via es.exe on this 1.5.0.1423 install (they parse silently but return 0 results):
- **Multi-term negated group nested in a negated group** — e.g. `!<!A|<!B|!C>>` (NOT of (NOT A OR NOT(B AND C))) silently returns 0 (verified 2026-09-10 UTC — single-token form). Single-term nested negated groups (`!<!A|<!B>>`) work, and nested groups inside a NON-negated outer group work.
- `depth:` / `parent-count:`
- `child-count:` / `child-file-count:` / `descendant-count:`
- `count:` (in-query limit — use the `limit` parameter instead)
- `max-threads:`
- `unique:` / `distinct:`
- `dupe-min:` / `dupe-max:` / `dupe-count:` / `dupe-from:`
- `len:` / `to-number:` / `to-integer:` / `to-string:` / `hex:`
- `size-on-disk:`
- `si:` (Windows System Index)
- `&sp:` / `&vert:` / `&excl:` character entities

Unverified here (documented for 1.5 but not confirmed on this build — treat as unproven): `length:` / `duration:` (media duration), `owner:`, `shortcut-target:`, `url:`, `binary:`, `each-line:`, `all-strings:`, `$property:` substitution, `dotall:` / `global:` / `multiline:` / `ungreedy:` regex tuning, `pinyin:`, `date-deleted:`.
