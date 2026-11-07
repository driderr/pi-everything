# Everything Query Syntax

Reference for `everything_search`. Machine-verified 2026-09-10, re-measured 2026-11-05 UTC;
where the official docs differ, this file is right.
The `Function support on this machine` section names the 1.5 features that are IGNORED or DEAD via
es.exe here — do not use them — and that section's last list is UNVERIFIED here, not broken.

## Operators
- `space` — AND: `a b` = a AND b, whether the clauses sit inside ONE es.exe argument or across two (measured under `-argv`; root README "es.exe invocation contract"). **This tool still sends one term per argument** (`splitQueryTerms`); quote inside an argument for a phrase.
- `|` — OR: `foo|bar`, and it binds TIGHTER than the implicit AND: the pipe joins the term on its left to
  the term on its right, and every other term applies to the whole result. Measured over a
  405-row scope (404 `.js`, 1 `.bin`): `ancestor:"…" | *.js` = 321,245 (the join's right side ran
  unscaled), while `ancestor:"…" *.js | *.bin` = 405 and `*.js | *.bin ancestor:"…"` = 405 — the scope sits
  outside the join there, so it limits both sides. A DUPLICATED term limits it the same way, because the copy
  is one of those outside terms: `ancestor:"…" ancestor:"…" | *.js` = 405 — the join
  still leaks and the second copy ANDs the union back down, so a small count is not proof the join was safe.
  A `<...>` group is ONE term on its side of the
  join: `ancestor:"…" <*.bin> | *.js` = 405. An orphan `|` degenerates the join and DROPS its neighbour — the
  term BEFORE a trailing pipe, the term AFTER a leading one: `ancestor:"…" *.js |` = 405 (the whole scope) where
  `ancestor:"…" *.js` = 404, while `| ancestor:"…" *.js` = 321,245 (every `.js` on the index) and the mirror
  `| *.js ancestor:"…"` = 405 (`-regex` takes a leading `|` as the pattern instead). If the drop removed the last term nothing limits the answer:
  `ancestor:"…" |`, `*.js |`, `| *.js`, a lone `|` and an empty query each answer the entire index.
  Orphan pipes CASCADE: `| ancestor:"…" | *.bin` lost BOTH terms and answered 3,777,897 where
  `ancestor:"…" | *.bin` = 4,250.
  `everything_search` notes the leaking shapes and stays quiet where the scope protects both sides; fix it by
  keeping the scope term out of the join, usually grouping the alternatives. A `|` can never be part of a
  Windows name (creating one fails with ENOENT).
- `!` — NOT: `!foo`. The exclusion covers the whole answer only when `!foo` stands OUTSIDE a `|` join:
  over a 2-file scope, `ancestor:"…" !a.r46j` = 1 row, but `ancestor:"…" !a.r46j | *.r46j` = 2 rows and the
  "excluded" file is one of them. The target is matched literally, parentheses included: in a folder holding
  a file named `(plain).txt`, `!(plain)` drops exactly that file (3 of 4 rows kept), while in a folder with
  no such name it drops nothing — the file set decides, not the grammar. It matches at ANY position, not just the
  front: in that folder `!plain` dropped TWO names (`plain.txt`, `(plain).txt`; 2 kept), `!(plain)` one. And a
  `|` inside the target splits the term anyway,
  because parentheses do not group: `!(plain|open)` dropped only `(plain).txt` (3 kept) - the exclusion covers
  the left branch of the join and the right branch is an OR that puts matches back.
- `<...>` — the ONLY grouping operator: `<abc|123> xyz`. It works:
  `<ext:exe | ext:txt>` = 49,889. Each BRANCH is its own search: a term inside one limits only that branch.
  `ancestor:"…" <*.js | *.bin>` = 405 (both scoped), but `<ancestor:"…" | *.bin>` = 4,250 = 405 +
  3,846 - 1 (the shared row) — there `*.bin` ran unscoped; `!` is not a scope (`<!plain | *.bin>` = 3,777,598).
  A `!` on one BRANCH is neutralised by its siblings (the group answers the union): in `paren49`
  `<plain | !(plain)>` = 4 where `!(plain)` alone = 3 and `<!(plain) | open>` = 3.
  **An alternative with NOTHING in it matches EVERY file**: `<>`, `<A |>`, `<A||B>` and a whitespace-only branch
  each answer the whole index, so `<*.bin |>` limits nothing (an unclosed `<` closes at the query end, and a
  nested group inside one is still grammar). A `<` after a function name is its ARGUMENT: `ext:<bin |>` = 0
  (`ext:<bin>` = 3,537), an empty branch THERE matches NOTHING, and a SPACE ends the argument — `ext:<bin|txt>`
  = 38,457 but `ext:<bin| txt>` = 0.
  A `>` glued to a function name is its COMPARATOR, not the group's end (`<ancestor:"…" | child-count:>1>` =
  one group, two branches; `size:>1kb` likewise). A `>` NOT glued that way is itself a TERM, and it matches
  0 rows: `ancestor:"…" >` = 0 where the scope alone = 40, and `<ancestor:"…" |>x>` = 0.
  **There is no `(...)` grouping — `(` and `)` are ordinary characters matched INSIDE a name.** Measured on a
  folder built for it: `plain` = 2 files, `(plain)` = the one named `(plain).txt`, `((plain))` = 0, `plain)` =
  1, and `<(plain)|open>` = 2 (grouping through `<...>` over literal-paren alternatives). Where no name has
  parentheses these answer nothing — `(ancestor:"…")` = 0 (405 unwrapped), `ancestor:"…" (aaa-oversized)` = 0
  (4 unwrapped), `(aaa-oversized | *.bin)` = 0 (3,854
  unwrapped) — and a `|` join loses only that branch: `(ancestor:"A") | ancestor:"D"` = 4 rows vs 409
  unparenthesised. So keep parentheses out of a group: `<(readme|license)>` = 0 — its alternatives are the
  literal texts `(readme` and `license)`. `everything_search` notes these shapes and names parentheses as the
  suspect, but never claims rows were lost (`Q3 (draft).pdf` is a real name); `everything_grep` says when its
  query selected no candidates. Under `regex:` parentheses are REGEX GROUPS and these shapes change meaning
  (es.exe handed the pattern exactly as the tool does, same folder): `(plain)` = 1 row as a term, 2 as a
  pattern; `plain)` = 1 row normal, 0 as a pattern (unbalanced — exit
  0, no stderr, so silence is not "no such file"); `\(plain\)` = 0 normal, 1 as a pattern; `!(plain)` keeps 3
  rows unregexed against 2 regexed, because the group changes what the NOT excludes.
- `"..."` — exact phrase: `"program files"`
- Precedence (official, and measured here): OR binds TIGHTER than AND — `a b|c` = `a AND (b|c)`.
  The corollary that matters for scopes: a scope term limits every branch EXCEPT when it is itself one of
  the two terms a `|` touches (see the `|` bullet above).

## Wildcards (apply to the whole filename)
- `*` — any characters except `\`; it DOES cross `.` (`clip93*` finds `clip93.mp3`)
- `?` — exactly one character, does NOT cross `\`
- `**` — any characters INCLUDING `\` (1.5); `*` stops at `\`: `C:\Windows\Web\**\*.jpg` 36 vs `C:\Windows\Web\*\*.jpg` 14
- A plain term without wildcards is a substring match on the filename.

## Type macros
`audio:` `video:` `image:` (aliases `pic:`, `photo:`) `doc:` `zip:` `exe:` — SHORTHAND for a fixed `ext:`
list, always WIDER than the name, so never the `ext:` filter: `exe:` also takes `.bat .cmd
.ps1 .vbs .msi .scr`; `doc:` is text AND SOURCE (`.js .py .json .xml .css .md .txt`) but NOT `.ts`;
`video:` means MPEG-TS, so it claims every `.ts` and `.mts`; `image:` also takes `.cur .psd`; `zip:` takes `.jar .tgz`; `audio:` takes `.m3u`.
`media:` is NOT a macro here — it answers 0 rows, like any unknown `word:`. The lists follow the
Everything version: use a macro for a coarse sweep, `ext:` when the set matters.

## Modifiers (each one GLUES to the term it modifies — a SPACED `ww:` is an EMPTY-argument modifier and
  matches EVERY row, so the modifier silently does nothing; stackable; disable with `no-` prefix)
- `file:` / `folder:` — files or folders only; the value is a case-insensitive SUBSTRING of the name, so `file:NTUSER.DAT` matched 6 under the home dir — pair it with `whole:` for exactly one file.
- `path:` — match the full path (alias `\:`)
- `case:` / `no-case:` — case-sensitive / case-insensitive
- `whole:` / `wfn:` — whole filename
- `ww:` — whole words only
- `start-with:` / `^:` — start of name; `end-with:` / `$:` — end of name. **The colon is part of the operator:** `^:readme` finds files, `^readme` nothing, silently.
- `prefix:` / `suffix:` — start/end of words
- `wildcards:` — extended wildcard syntax (`#` digit, `[a-m]`, `[!x]`, `\` escape); WITHOUT it `#`, `[` and
  `\` are LITERAL name characters. `no-wildcards:` makes `*`/`?` literal.
- `soundex:` — phonetic match (A–Z) on the name: `soundex:downloads` found `Downloads`, but
  `smith93.txt` answered neither `soundex:smith` nor `soundex:smith93`.
- `regex:` — PCRE on the term that follows it: `regex:(plain)` = 2 rows where the same
  term written plainly = 1. The tool's `regex: true` flag is NOT equivalent: es.exe's `-regex` consumes ONE
  argument, so only the FIRST term is a pattern and the rest stay ordinary searches (`-regex plain` with a
  second term `(plain)` = 1 row, the intersection, where the group alone = 2). A `|` among those later terms
  is still Everything's OR and still leaks an unscoped side: `-regex "." -- ancestor:"…answertrim" | *.js`
  counted 310,464, the same query with no regex at all (read 2026-11-04), while the same terms without the `|` counted
  404. `everything_grep` has no `regex` parameter at all, so for that tool the in-query form is the only way
  to ask for regex grammar: a grep call that passed `regex: true` had it ignored, and
  the query reached the engine unchanged. A pattern argument that LOOKS like a function is parsed as that
  function instead, with no pattern applied at all: `-regex ancestor:"…answertrim" -- ancestor:"…answertrim"
  | *.js` = 405 and `-regex ancestor:"…answertrim" -- ancestor:"…answertrim" *.js` = 404, where the same two
  shapes with `-regex ".*"` gave 310,464 and 404. Put a real pattern in that slot, never a scope term.
  Where a `!` stands decides what it excludes, because only the pattern slot gets regex grammar: in a folder
  of 4 files (`(plain).txt`, `plain.txt`, `open(.txt`, `close).txt`) `-regex !(plain) -- ancestor:"…paren49"`
  kept 2 rows - the pattern is a regex GROUP, so both plain-named files dropped - while the same term written
  as a LATER term kept 3 (only the file literally containing `(plain)` dropped), and `-regex plain --
  ancestor:"…paren49" !(plain)` kept 1: the pattern matched both plain names, the literal bang then removed
  the parenthesised one. A pipe TYPED AFTER the pattern term is ordinary Everything OR, not pattern text —
  es.exe gives the pattern exactly ONE argv term, so only pipes inside the pattern term's OWN text are
  alternation. Inside the pattern a leading `!` is STILL Everything's NOT, over the WHOLE pattern, and
  parentheses group without confining it.
- `diacritics:` — exact accent match (default: `é` matches `e`)
- `ignore-punctuation:` / `ignore-whitespace:` — `spiderman` matches `spider-man` / `spider man`

## Size
`size:` — bytes, or with kb/mb/gb/tb suffix (1 kb = 1024 bytes). FOLDER rows have a size too — the
sum of their contents (`C:\tmp\esq-e2e-fixtures\mod93` reads 4,949 B = `es.exe -get-folder-size` =
its files on disk) — so `size:` matches folders as well as files, and `-get-total-size`
(this tool's `total_size`) sums FILE rows only.
- Operators: `size:>100mb`, `size:<1kb`, `size:1mb..10mb`, `size:==1kb`, `size:!=1kb`, `size:1mb-10mb`
- Constants: `size:empty|tiny|small|medium|large|huge|gigantic` — DISJOINT bands, measured in ONE run
  (2026-11-05, whose whole index was 3,778,577 rows). Each starts exactly where an explicit comparison
  starts: `size:empty` = `size:==0` (350,248) — every row of size 0, files and folder rows both;
  `size:tiny` 2,351,772 (that index less the six below); from `small` = `size:>10kb`; from
  `medium` = `size:>100kb`; from `large` = `size:>1mb`; from `huge` = `size:>16mb`;
  `size:gigantic` = `size:>128mb` — byte for byte, so the ladder is 10 KB, 100 KB,
  1 MB, 16 MB, 128 MB, so `size:large` is the 1-16 MB band. The seven bands sum to that run's index (re-driven live).

## Dates
`dm:` (modified) · `dc:` (created) · `da:` (accessed) · `date-changed:` (the entry-change stamp, its own column)

- **On this box `Index date created`, `Index date accessed` and `Index attributes` are OFF**
  (Everything ▸ Options ▸ Indexes; screenshots in the project README). `dc:`, `da:`,
  `attrib:`/`attribute:`/`attributes:` (all three accepted, identical) and the
  `date-created`/`date-accessed`/`attributes` sorts still RETURN
  results: `dc:2026-11-01 ext:exe` = 97, `attributes:h size:>10mb` = 103 (2026-11-06) —
  but the property is not in the index, so a zero or a short list is NOT proof of absence.
  **One value of the attribute family IS indexed: the DIRECTORY flag alone** — `attributes:d` counted
  738,526 and `!attributes:d` (bang in FRONT) 3,020,538 in 45-46 ms each; its count IS asked. Every other
  value scans (`attributes:x` never answered inside 35 s), and a letter Everything IGNORES adds NO
  requirement and answers a whole-index figure (`attributes:q` = `attributes:zz` = 3,759,064):
  an unfiltered count (2026-11-07).
- **The cost of an un-indexed property is a full scan; the tool refuses that count**
  (`dc:today` with `count_only:true` answers `No count asked for: …` at once — no `-get-result-count`
  is sent; leashes are 15 s count/total-size, 30 s list, and the message names whichever fired). A LIST
  still pays the scan: `dc:today` at `limit:5` took 5.1 s, header `showing N (total unknown …)` not
  `N matching`. A LIST is priced at ONE rate per column, and that rate drifts inside an hour: the same 0-match
  `dimensions:` LIST over `ext:css` cost 2,098 µs an entry at 08:00 on 2026-11-07, 4,400 ten minutes later. That
  column is priced above the worst rate measured (5,000 µs, a 6,000-entry lease); a LIST the guard ADMITS can burn
  the whole 30 s. The refusal fires when NOTHING indexed narrows a scan term; a partner
  leaving FEW entries makes the COUNT answer (`ext:exe`, a folder, an absolute `path:`) — the entries left decide,
  not the name: `dc:2026-11-01 size:>1kb` spent the full 15 s (2026-11-06). Nothing
  rescues a `da:` / `dateaccessed:` COUNT: refused whatever is ANDed onto them. A `da:` LIST is refused only
  beside a place term; a bare one is allowed, and a sparse date can spend the whole 30 s list leash. No offered partner rescues it: dense, mid and rare `ext:`
  values, `size:>`, `attributes:d`, `!path:` and a non-path `path:` value each walked past 35 s at `-n 5`
  (2026-11-07). Prefer
  `dm:` (19,909 counted in 411 ms).
- **The missing index costs FILTERING, not sorting or reading.** On a 15,035-row `ext:exe` scope
  `sort=date-created` took 236 ms against `date-modified`'s 132 ms and its column came out monotone:
  sorting and reading them answer
  (59-350 ms, below) — only unscoped FILTERING is off the table.
- **Sorting stays cheap; reading a property COLUMN costs per row.** Measured on the same
  15,035-row `ext:exe` scope at `-n 2000`, every sort name `everything_search` accepts: six cost 73-98 ms
  (`name` `path` `size` `extension` `date-modified` `date-recently-changed`) and the three un-indexed ones
  348-350 ms (`date-created`, `date-accessed`, `attributes`). Property columns are another matter:
  `version` 3,295 ms, `author` 3,396, `width` 6,249 — ~1.7 ms per row read (3 ms for `width`), which is
  why the same column costs ~50 ms at `-n 1`. Those rates are the `-n 2000` FETCH — the `limit`
  parameter maxes at 500, so that fetch is `offset:1500` with `limit:500`.
  A SHELL-property SORT (the schema exposes none) is the worst case and is unreachable here: `-n 1`
  with `sort=author` still took 4.3 s — sorting reads the property of EVERY match, so `-n` cannot
  save it. The three un-indexed sorts it DOES expose are measured above.
- **Sorting on an un-indexed date column IS honored, and a blank value sorts as the oldest.**
  `sort=date-accessed` over `C:\Windows\System32 *.dll` and `C:\Program Files *.exe`, both directions,
  40 rows each: zero out-of-order rows, and the ascending `System32` run STARTED on an empty
  `date-accessed` — a blank is the minimum, not a broken sort.
- **`date-acquired` is not `date-created`: it is always empty here** (120 rows sampled — 60
  `C:\Windows\System32\*.dll` + 60 `C:\Program Files\*.exe`, re-driven live:
  `date-created` and `date-accessed` 120/120, `date-acquired` 0/120). A valid `columns=` name that
  renders blank; the blank is
  not "no creation date" — ask `date-created`.
- Constants: `today`, `yesterday`, `thisweek` (the week since SUNDAY), `lastweek` (= `dm:7days`: ROLLING,
  not the calendar week), `thismonth`, `lastmonth`, `thisyear`, a year (`2024`), a month name (`january`,
  this year), a date (`2024-01-15`). A weekday name is a WINDOW INSIDE its most recent such day, not that
  date: whole-index 2026-11-05, `friday` 5,717 against `2026-10-30` 26,323. Prefer a date.
- Durations (1.5) roll back from NOW, not the calendar: `dm:2days` = `dm:48hours` = `dm:2d`,
  `dm:3weeks` = `dm:21days`, `dm:1year` = `dm:365days`, but `dm:1month` ≠ `dm:30days` (a month steps the
  calendar). Units `s m h d w y` or words; `m` is MINUTES (`dm:1m` = `dm:1minute`) — months are `mon`.
- Ranges/comparisons: `dm:2024..2025`, `dm:>2023`, `dm:<today`, `dm:>monday` (a name works either side).
- `date-run:` / `run-count:` — items you opened through Everything (FOLDERS count too), valued by openings

## Content (SLOW — unindexed, scanned on demand)
- `content:password`, `content:"exact phrase"`
- Always narrow first with `parent:`, `ext:`, or `size:`.

## Path & hierarchy (all verified)
- `parent:<path>` — items DIRECTLY in that folder (absolute path)
- `ancestor:<path>` — items at any depth under that folder. A path containing a space MUST be
  quoted — `ancestor:"C:\Program Files"` — because the function's value otherwise ends at the
  space. Needs es.exe ≥ 1.1.0.37 (see `-argv` in README.md).
  The failure is NOT always a zero, and the silent kind is the dangerous one:
  - **Path-valued** (`ancestor:`, `parent:`, `path:`) → **0 results**. `ancestor:C:\Program Files ext:exe` = 0.
  - **Name-valued** (`file:`, `folder:`, `stem:`, `parent-name:`, `childname:`, `name:`, `child:`,
    `descendant:`, `sibling:`, `volume-label:`) → the value
    splits and the rest becomes an independent AND term, so you get a **plausible WRONG non-zero
    count**: `file:"Program Files"` = 0 but `file:Program Files` = 330; `stem:"Program Files"` = 10
    vs `stem:Program Files` = 356. Same rule
    applies to every one of those functions: **quote the value whenever it contains a space.**
- A quoted path value **with** a trailing `\` is a DIFFERENT query. `path:` is a substring
  test on the full path, so a trailing separator anchors where the value can match and the
  result is exactly the `ancestor:` set of that folder. Measured WITH `ext:exe`:
  `path:"C:\Program Files" ext:exe` = 3,181, the same value delivered with the trailing `\`
  = 1,961 = `ancestor:"C:\Program Files" ext:exe`.
  This tool drops exactly ONE `\` sitting before a closing quote, so `"…\"` behaves as `"…"`
  and `"…\\"` is a third thing. Write quoted paths with no trailing backslash.
- `parent-name:<text>` — parent folder NAME contains text
- `location:<text>` — parent path contains text
- `stem:<text>` — name without extension; `name:<text>` — name
- `full-path:<text>` — full path contains text
- `root:` — drive roots: `root:` alone answers one row per indexed volume root (4 here), `root:C` narrows
  to that one drive, and a value that is not a drive letter matches nothing (`root:1` answered 0 — the
  value is a drive, never a count)
- `empty:` — empty folders
- **`child:`, `childname:` and `descendant:` are FOLDER-side: they return folders, never the row you named.**
  `child:<text>` = the folders directly containing a name match, and `childname:<text>` is that same
  function. `descendant:<text>` = the same at any depth (`child:attr99` = 1 row, `descendant:attr99` = 3 —
  the folder and every ancestor).
  Neither means "things under X". `sibling:<text>` = rows sharing a folder with a name match, except that a
  match is only left out of its OWN list: two matches in one folder return both. To select ONE file by name
  use the quoted name or `file:<name>`.
- Exclude a drive: `!e:`; multiple drives: `c:|d:`; folder shortcut: `\downloads`
- **A path that starts with `\\` never matches here.** A UNC share (`\\server\share`), the Win32
  device namespace (`\\?\E:\docker`) and a drive letter no volume backs (`Z:\nowhere`) all return 0.
  Zero indexed entries start with a backslash
  (`es.exe -get-result-count -r "^\\"` = 0). The index is the USN index of local volumes, so this is
  not staleness — `everything_status` will look healthy. Query the volume path (`E:\docker`) instead.
  `everything_search` prints this note for the two `\`-rooted spellings only; an unmapped drive letter
  answers 0 with no note, so check coverage first — `everything_search` with `root:` lists the volumes.

## Duplicates
- `dupe:` — same name IGNORING PUNCTUATION (`one-Two93.txt` paired with `oneTwo93.txt`), in the same
  folder or different ones; the extension is part of the name.
- `sizedupe:` — same size; `dmdupe:` — same modified date
- `dupe:size;name` — combined (1.5 form); `dupe:name;size` answers identically.
- Hash functions (SLOW): `md5:<hash>` `sha1:` `sha256:` `crc32:`

## Attributes & system
- `attributes:<letters>` — R read-only, H hidden, S system, D directory, A archive, V device, N normal, T temp, L reparse point, C compressed, O offline, I not-content-indexed, E encrypted (e.g. `!attributes:h`). Several letters AND (`attributes:hs` = both, order free). `D` is the one value this box indexes; every other value scans — see Dates (2026-11-07).
- `volume-label:<text>` — ROWS (folders included) on every volume whose label CONTAINS text,
  case-insensitive; two volumes may share one label, so it is not a drive. Quote a spaced value.
- `is-running:` — executables currently running
- `hard-link-count:>1` — the disk link count: every plain file is `1` (folder rows too), so scope it;
  unscoped it never answers inside 15 s.
- `ext:` alone = files with NO extension; wildcards allowed: `ext:mp*`

## Tool parameter mapping
| Need | Parameter |
|---|---|
(the rest are in the tool list)
| Extra property columns | `columns: ["width","height",...]` (55-name list: everything_syntax `include_columns=true`) |
| Recursive folder size | `everything_folder_size` tool |
| Sort | `sort` + `order` — name, path, size, extension, the four dates, attributes |
| Regex query | `regex: true` (or `regex:` term) |
| Case-sensitive | `case_sensitive: true` (or `case:` term) |
| Whole words | `whole_word: true` (or `ww:` term) |
| Match full path | `match_path: true` (or `path:` term) |
| Exact diacritics | `diacritics: true` |

## Function support on this machine (re-measured 2026-11-04)

Measured through this extension (es.exe 1.1.0.37 `-argv`, Everything 1.5.0.1423), `count_only`.

**Silently IGNORED — the term removes nothing, you get a plausible wrong answer.** Most
dangerous class, because the result is non-zero. `dupe-min:2` returned the WHOLE index;
`dupe-max:2`, `dupe-count:>1`, `dupe-from:1` and `max-threads:2` each returned exactly `ext:exe`.
Never build a query that relies on any of them.

**Returns 0 (confirmed dead).** `to-number:5`, `to-integer:5`, `hex:ff`, `si:test` (each
with `ext:exe`). Entity OR `exe&vert:txt` answers 0 where `ext:exe|ext:txt` does not.
`size-on-disk:` is NOT this class: unscoped it never answered inside the 30 s LIST budget (a list
measurement, not `count_only`: that leash is 15 s); scoped to one Git folder it answered.

**The `child-count:` family values FOLDER ROWS only (cheap).** `child-count:` = DIRECT children,
`descendant-count:` = everything below; `-file-`/`-folder-` split that by type. No file row has a value, so a
files-only partner (`ext:`, `file:`, `!attributes:d`) answers 0 — an empty intersection, not a dead term;
`ancestor:`, `path:`, `folder:`, `size:` and `dm:` all work. `:0` = `empty:` only for
`child-count:`/`descendant-count:`; `-file-:0` and `-folder-:0` are SUPERSETS of it - they also match folders
whose children are all of the other kind. Junctions count as folders; an EMPTY argument means ≥1.

**Works.** `depth:3`, `parent-count:2`, `count:5` (in-query limit
honoured), `unique:ext`, `distinct:ext`, `len:>5` (NAME length, not the full path), `to-string:1` non-zero, and
`&sp:` — `program&sp:files` answers the same rows as `"program files"`, while `programfiles` answers a WIDER set.

**Nested negation is not a parse bug:** `!<!A|<!B|!C>>` evaluates to `A AND B AND NOT C`.

Unverified on this install (documented for 1.5; unproven here): `length:`, `owner:`, `shortcut-target:`, `url:`, `binary:`, `each-line:`, `all-strings:`, `$property:` substitution, regex tuning (`dotall:` etc.), `pinyin:`, `date-deleted:`. `duration:` (media duration) IS verified: real, refused unscoped.
