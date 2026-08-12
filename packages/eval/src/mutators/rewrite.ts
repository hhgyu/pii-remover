import {
  scanTokens,
  TOKEN_DELIMITER,
  TOKEN_PREFIX,
  TOKEN_SUFFIX,
  type TokenMatch,
} from "@pii-remover/core";

/** Base36 alphabet the deterministic token hash is drawn from (ADR-0020). */
export const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Rebuild `text`, replacing every token occurrence with `transform(match, i)`.
 *
 * Token discovery goes through the restorer's own `scanTokens`, so a mutator
 * can only ever touch spans the production matcher agrees are tokens — an
 * inert lookalike in an adversarial fixture entry is left exactly as written.
 */
export function rewriteTokens(
  text: string,
  transform: (match: TokenMatch, index: number) => string,
): string {
  const matches = scanTokens(text);
  let out = "";
  let cursor = 0;
  matches.forEach((match, index) => {
    out += text.slice(cursor, match.start) + transform(match, index);
    cursor = match.end;
  });
  return out + text.slice(cursor);
}

/**
 * Assemble a token from parts WITHOUT the format guard.
 *
 * `formatToken()` rejects malformed input, which is precisely what several
 * mutation classes must emit (a hash one character too long, a category that
 * was never minted). The grammar constants still come from core, so a wire
 * format change reaches this file automatically.
 */
export function buildToken(category: string, hash: string): string {
  return `${TOKEN_PREFIX}${category}${TOKEN_DELIMITER}${hash}${TOKEN_SUFFIX}`;
}

/** Deterministic base36 string of `length` chars — FNV-1a, no crypto import,
 *  same output on every platform and every run. */
export function deterministicHash(seed: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    let acc = 0x811c9dc5;
    for (const ch of `${seed}#${i}`) {
      acc ^= ch.codePointAt(0) ?? 0;
      acc = Math.imul(acc, 0x01000193) >>> 0;
    }
    out += BASE36.charAt(acc % BASE36.length);
  }
  return out;
}

/** Next base36 character, wrapping — a one-character hash substitution that is
 *  guaranteed to change the value and stay inside the alphabet. */
export function nextBase36Char(ch: string): string {
  const index = BASE36.indexOf(ch);
  return BASE36.charAt((index + 1) % BASE36.length);
}

/** Deterministic midpoint index used by the hash-damage mutators. */
export function midpoint(value: string): number {
  return Math.floor(value.length / 2);
}
