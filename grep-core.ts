/**
 * grep-core — content-scan and hashline-anchor helpers for `everything_grep`.
 *
 * Anchor output MUST be byte-identical to pi-hashline-readmap's computeLineHash
 * (xxh32 of the RAW line — whitespace significant, pi-hashline-readmap >= 0.15.0;
 * seed 0; 3-hex-char of value % 4096) — so these anchors feed the edit tool.
 * so these anchors feed straight into the hashline-anchored edit tool.
 *
 * xxhash-wasm is NOT importable from the extension directory (pi's jiti loader
 * only aliases pi's own packages), so xxh32 is implemented in pure JS here
 * (public-domain reference algorithm, cyan4973/xxHash) and verified by the
 * differential test in ../test/hash-parity.mjs against pi-hashline's
 * xxhash-wasm-based implementation. 100% match is required.
 */

// ─── xxHash32 (public domain reference implementation) ─────────────────────

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

const rotl = (x: number, r: number): number => ((x << r) | (x >>> (32 - r))) >>> 0;

// Exact 32x32 -> 32-bit mod-2^32 multiply. Plain JS `a * b` loses precision
// once the product exceeds 2^53, so split into 16-bit halves (largest
// intermediate: (2*0xffff^2) * 0x10000 + 0xffff^2 < 2^49, exact in float64).
const mul32 = (a: number, b: number): number => {
  const ah = a >>> 16,
    al = a & 0xffff,
    bh = b >>> 16,
    bl = b & 0xffff;
  return ((ah * bl + al * bh) * 0x10000 + al * bl) >>> 0;
};

const wordLE = (b: Uint8Array, i: number): number =>
  (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** xxHash32 over a byte array (seed defaults to 0). Returns an unsigned 32-bit value. */
export function xxh32(bytes: Uint8Array, seed = 0): number {
  const n = bytes.length;
  let i = 0;
  let h: number;

  if (n >= 16) {
    let v1 = (seed + P1 + P2) >>> 0;
    let v2 = (seed + P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - P1) >>> 0;

    while (i + 16 <= n) {
      v1 = mul32(rotl((v1 + mul32(wordLE(bytes, i), P2)) >>> 0, 13), P1);
      v2 = mul32(rotl((v2 + mul32(wordLE(bytes, i + 4), P2)) >>> 0, 13), P1);
      v3 = mul32(rotl((v3 + mul32(wordLE(bytes, i + 8), P2)) >>> 0, 13), P1);
      v4 = mul32(rotl((v4 + mul32(wordLE(bytes, i + 12), P2)) >>> 0, 13), P1);
      i += 16;
    }

    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    h = (seed + P5) >>> 0;
  }

  h = (h + n) >>> 0;

  while (i + 4 <= n) {
    h = (h + mul32(wordLE(bytes, i), P3)) >>> 0;
    h = mul32(rotl(h, 17), P4);
    i += 4;
  }

  while (i < n) {
    h = (h + mul32(bytes[i], P5)) >>> 0;
    h = mul32(rotl(h, 11), P1);
    i++;
  }

  h ^= h >>> 15;
  h = mul32(h, P2);
  h ^= h >>> 13;
  h = mul32(h, P3);
  h ^= h >>> 16;

  return h >>> 0;
}

// ─── Hashline anchors (byte-identical to pi-hashline-readmap) ───────────────

const HASH_LEN = 3;
const RADIX = 16;
const HASH_MOD = RADIX ** HASH_LEN;
const DICT: string[] = Array.from({ length: HASH_MOD }, (_, i) =>
  i.toString(RADIX).padStart(HASH_LEN, "0"),
);

const textEncoder = new TextEncoder();

/**
 * 3-char anchor for one source line: xxh32 (seed 0) of the RAW line — whitespace
 * is significant — modulo 4096, as zero-padded lowercase hex. One trailing CR is
 * stripped first. The line number does NOT enter the hash. This matches
 * pi-hashline-readmap >= 0.15.0 (src/hashline.ts `computeLineHash`); the
 * pre-0.15.0 oracle hashed the whitespace-stripped line, which silently produced
 * anchors the edit tool rejects for any indented line.
 */
export function computeLineHash(_lineNumber: number, line: string): string {
  if (line.endsWith("\r")) line = line.slice(0, -1);
  return DICT[xxh32(textEncoder.encode(line), 0) % HASH_MOD];
}

/**
 * Full hashline rendering `LINE:HASH|display` (as the read tool emits).
 */
export function formatHashlineDisplay(lineNumber: number, content: string): string {
  return `${lineNumber}:${computeLineHash(lineNumber, content)}|${escapeControlCharsForDisplay(content)}`;
}
/**
 * Hashline rendering `LINE:HASH|display` with the display string separated
 * from the hashed content: HASH is computed from `full` (the complete line,
 * so hashline-anchored edits still operate on full content) while `display`
 * is what gets rendered (typically a line capped at 500 chars by pi's
 * builtin grep). With display === full this equals formatHashlineDisplay.
 */
export function formatAnchoredLine(lineNumber: number, full: string, display: string): string {
  return `${lineNumber}:${computeLineHash(lineNumber, full)}|${escapeControlCharsForDisplay(display)}`;
}

const DISPLAY_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/** Escape non-printable control chars for safe display (\uXXXX, 4 hex digits). */
export function escapeControlCharsForDisplay(text: string): string {
  return text.replace(DISPLAY_CONTROL_CHAR_RE, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

// ─── Binary detection and decoding (scan path) ───────────────────────────
//
// pi's own rule (pi-hashline-readmap `binary-detect.ts`, which this file vendored verbatim
// as `looksLikeBinary` until 2026-11-04) is: a NUL byte, OR a U+FFFD the decoder introduced
// (invalid UTF-8 — a genuine EF BF BD survives the round-trip, so it is not flagged). pi
// applies THAT predicate to the single-target warning ("appears to be a binary file — grep
// skips", grep.ts:498-505) and to edit guards, and NOT to a directory scan: the scan goes
// through pi-core's native ripgrep engine, whose binary rule is NUL-based and whose reader
// transcodes a UTF-16 BOM.
//
// Measured on this box (2026-11-04, an 8-file corpus with one ASCII token in each): pi's
// scan matched utf8, utf8+BOM, utf16le+BOM, utf16be+BOM, latin1 and CP-125x-ANSI — 6 of 8 —
// and missed utf16-without-BOM plus the NUL-bearing file; pointed at latin1.txt ALONE, pi
// printed the binary warning instead. Our code applied the WARNING predicate to every
// scanned file, so we reported 2 matches where pi's scan reported 6: a silently short answer
// (round 9 R-1/R-2).
//
// `decodeForScan` below therefore follows the SCAN rule. The vendored predicate is
// deliberately deleted rather than kept for parity: reaching for it is how the wrong path
// got it, and we do not reproduce pi's lone-invalid-UTF-8-file warning (README decision
// list) — telling an agent a file it can search is "binary, use a hex tool" is worse than a
// documented divergence.

export type ScanDecode =
  | { kind: "text"; text: string; transcoded: boolean }
  | { kind: "binary"; reason: "nul" };

/**
 * Decode a candidate file for scanning, deciding text-vs-binary the way pi's scan
 * engine does. Order matters: a UTF-16 BOM is checked FIRST, because ASCII text in
 * UTF-16 is full of 0x00 bytes and would otherwise be classified binary by the NUL rule
 * (measured: pi's scan reads both BOM'd UTF-16 files fine, and only skips the file whose
 * NULs are genuine). Then a NUL anywhere means binary, and everything else decodes as
 * UTF-8 with replacement characters, so an ASCII/UTF-8 pattern still matches inside a
 * Latin-1 or CP-125x file instead of the file being skipped. Line numbers are computed
 * on this decoded text - the same text the reference renders.
 *
 * `transcoded` marks the UTF-16 paths, and it decides whether a rendered row may carry a
 * LINE:HASH anchor. pi's read tool does NOT transcode UTF-16: measured 2026-11-04 it shows the
 * raw NUL-interleaved text and hashes THAT (suite fixture utf16le.txt line 2 = 795, case 14), while the
 * decoded line we
 * search hashes 3fb. An anchor on a transcoded row is therefore a hash no other pi tool agrees
 * with, so those rows print anchor-less - which is also how pi's own grep renders them. Invalid
 * UTF-8 is NOT transcoded: pi's read decodes it to the same replacement-char string we do, so
 * those rows keep their anchors (suite fixtures latin1.txt line 2 = f14 and ansi-greek.txt line 2 = 1e6,
 * case 14, same
 * from our grep and from pi's read).
 */
export function decodeForScan(buf: Buffer): ScanDecode {
  const bomLe = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  const bomBe = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
  if (bomLe || bomBe) {
    // Node only decodes UTF-16LE, so BE is byte-swapped first. swap16() throws on an odd
    // length, so a truncated trailing byte is dropped rather than crashing the scan.
    const body = Buffer.from(buf.subarray(2));
    const view = body.subarray(0, body.length - (body.length % 2));
    return { kind: "text", text: (bomBe ? view.swap16() : view).toString("utf16le"), transcoded: true };
  }
  if (buf.includes(0)) return { kind: "binary", reason: "nul" };
  const s = buf.toString("utf8");
  return { kind: "text", text: s.charCodeAt(0) === 0xfeff ? s.slice(1) : s, transcoded: false };
}

// ─── Pattern helper ──────────────────────────────────────────────────────────

/** Escape special regex characters so a literal string matches literally. */
export function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
