/**
 * grep-core — content-scan and hashline-anchor helpers for `everything_grep`.
 *
 * Anchor output MUST be byte-identical to pi-hashline-readmap's computeLineHash
 * (xxh32 of the whitespace-stripped line, seed 0; 3-hex-char of value % 4096),
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
 * 3-char anchor for one source line: xxh32 (seed 0) of the line with ALL
 * whitespace removed, modulo 4096, as zero-padded lowercase hex. A trailing
 * CR is stripped first. The line number does NOT enter the hash.
 */
export function computeLineHash(_lineNumber: number, line: string): string {
  if (line.endsWith("\r")) line = line.slice(0, -1);
  const stripped = line.replace(/\s+/g, "");
  return DICT[xxh32(textEncoder.encode(stripped), 0) % HASH_MOD];
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

// ─── Binary detection (same strategy as pi-hashline-readmap) ────────────────

/**
 * True if the buffer appears to contain binary (non-text) content:
 *   1. NUL byte (0x00) — universally indicates binary
 *   2. U+FFFD that did not exist in the original bytes (decoder-introduced,
 *      i.e. invalid UTF-8 sequences — a valid EF BF BD in the file survives
 *      the round-trip and is not treated as binary)
 */
export function looksLikeBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (buf.includes(0)) return true;
  const decoded = buf.toString("utf8");
  if (!decoded.includes("\uFFFD")) return false;
  return !Buffer.from(decoded, "utf8").equals(buf);
}

// ─── Pattern helper ──────────────────────────────────────────────────────────

/** Escape special regex characters so a literal string matches literally. */
export function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
