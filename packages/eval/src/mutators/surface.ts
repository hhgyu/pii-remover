import { TOKEN_SUFFIX } from "@pii-remover/core";

import type { Mutator } from "../types.js";
import { rewriteTokens } from "./rewrite.js";

/**
 * Surface mutations (plan §5 catalog 1, 2, 5, 6, 8, 9, 10, 15, 16).
 *
 * Each of these leaves token identity intact — category and hash still name
 * the same vault entry — so a correct restorer must return the original value.
 * The single exception is markdown escaping, which destroys the grammar itself.
 */

/** 1 — the model echoes the token in the opposite case. */
export const caseFlip: Mutator = (text) => ({
  text: rewriteTokens(text, (match) => flipCase(match.token)),
  expectedRecoverable: true,
});

/** 2 — the model drops the trailing delimiter. */
export const dropTrailingSuffix: Mutator = (text) => ({
  text: rewriteTokens(text, (match) =>
    match.token.endsWith(TOKEN_SUFFIX)
      ? match.token.slice(0, -TOKEN_SUFFIX.length)
      : match.token,
  ),
  expectedRecoverable: true,
});

/** 5 — a markdown renderer escapes every underscore. */
export const markdownEscape: Mutator = (text) => ({
  text: rewriteTokens(text, (match) => match.token.replaceAll("_", "\\_")),
  expectedRecoverable: true,
  note: "backslash-escaped underscores hide the token from both matchers; the candidate scan tolerates the escapes and the normalized form is an exact vault key",
});

/** 6 — the model quotes the token as inline code. */
export const backtickWrap: Mutator = (text) => ({
  text: rewriteTokens(text, (match) => `\`${match.token}\``),
  expectedRecoverable: true,
});

/** 8 — the token travels inside a JSON string (tool-call arguments). */
export const jsonStringEscape: Mutator = (text) => ({
  text: JSON.stringify(text),
  expectedRecoverable: true,
});

/** 9 — the model rebuilds a Windows path around the token. Vault hits inside
 *  a path are restored normally; `pathSkipCount` only suppresses vault MISSES
 *  (plan §0), and this class is what keeps that guarantee honest. */
export const windowsPathEmbed: Mutator = (text) => ({
  text: rewriteTokens(text, (match) => `D:\\Git\\${match.token}\\file.ts`),
  expectedRecoverable: true,
});

const KOREAN_PARTICLES = ["님이", "씨는", "님께", "씨가"] as const;

/** 10 — Korean particle agglutination glues a suffix onto the token. */
export const koreanParticle: Mutator = (text) => ({
  text: rewriteTokens(
    text,
    (match, index) =>
      `${match.token}${KOREAN_PARTICLES[index % KOREAN_PARTICLES.length]}`,
  ),
  expectedRecoverable: true,
});

/** 15 — the whole reply lands inside a fenced code block. */
export const codeFence: Mutator = (text) => ({
  text: `\`\`\`txt\n${text}\n\`\`\``,
  expectedRecoverable: true,
});

/** 16 — the model repeats the same token three times. */
export const tripleRepeat: Mutator = (text) => ({
  text: rewriteTokens(
    text,
    (match) => `${match.token} ${match.token} ${match.token}`,
  ),
  expectedRecoverable: true,
});

function flipCase(value: string): string {
  let out = "";
  for (const ch of value) {
    const upper = ch.toUpperCase();
    out += ch === upper ? ch.toLowerCase() : upper;
  }
  return out;
}
