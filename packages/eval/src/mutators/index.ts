import type { MutationClass } from "../types.js";
import { hashCharSubstitution, hashLengthChange } from "./corruption.js";
import {
  categoryRename,
  categorySwap,
  hashSwap,
  inventedToken,
} from "./probes.js";
import { sseDeltaSplit } from "./streaming.js";
import {
  backtickWrap,
  caseFlip,
  codeFence,
  dropTrailingSuffix,
  jsonStringEscape,
  koreanParticle,
  markdownEscape,
  tripleRepeat,
  windowsPathEmbed,
} from "./surface.js";

export {
  backtickWrap,
  caseFlip,
  categoryRename,
  categorySwap,
  codeFence,
  dropTrailingSuffix,
  hashCharSubstitution,
  hashLengthChange,
  hashSwap,
  inventedToken,
  jsonStringEscape,
  koreanParticle,
  markdownEscape,
  sseDeltaSplit,
  tripleRepeat,
  windowsPathEmbed,
};
export { HALLUCINATED_HASH } from "./probes.js";
export {
  firstStraddlingToken,
  heldBackTail,
  reassemble,
  streamChunks,
} from "./streaming.js";
export {
  BASE36,
  buildToken,
  deterministicHash,
  midpoint,
  nextBase36Char,
  rewriteTokens,
} from "./rewrite.js";

/**
 * The 16 Tier-1 mutation classes, in plan §5 catalog order.
 *
 * Order and numbering are part of the published baseline: renumbering breaks
 * comparability with every baseline.md already recorded.
 */
export const MUTATION_CLASSES: readonly MutationClass[] = [
  {
    id: 1,
    name: "case-flip",
    kind: "surface",
    minTokens: 1,
    description: "token echoed in the opposite case",
    mutate: caseFlip,
  },
  {
    id: 2,
    name: "drop-trailing-suffix",
    kind: "surface",
    minTokens: 1,
    description: "trailing delimiter dropped",
    mutate: dropTrailingSuffix,
  },
  {
    id: 3,
    name: "hash-char-substitution",
    kind: "corruption",
    minTokens: 1,
    description: "one hash character substituted, length preserved",
    mutate: hashCharSubstitution,
  },
  {
    id: 4,
    name: "hash-length-change",
    kind: "corruption",
    minTokens: 1,
    description: "one hash character inserted or deleted",
    mutate: hashLengthChange,
  },
  {
    id: 5,
    name: "markdown-escape",
    kind: "surface",
    minTokens: 1,
    description: "every underscore backslash-escaped",
    mutate: markdownEscape,
  },
  {
    id: 6,
    name: "backtick-wrap",
    kind: "surface",
    minTokens: 1,
    description: "token quoted as inline code",
    mutate: backtickWrap,
  },
  {
    id: 7,
    name: "sse-delta-split",
    kind: "surface",
    minTokens: 1,
    description: "split across simulated SSE deltas at every offset",
    mutate: sseDeltaSplit,
  },
  {
    id: 8,
    name: "json-string-escape",
    kind: "surface",
    minTokens: 1,
    description: "token carried inside a JSON string",
    mutate: jsonStringEscape,
  },
  {
    id: 9,
    name: "windows-path-embed",
    kind: "surface",
    minTokens: 1,
    description: "token rebuilt into a Windows path",
    mutate: windowsPathEmbed,
  },
  {
    id: 10,
    name: "korean-particle",
    kind: "surface",
    minTokens: 1,
    description: "Korean particle agglutinated onto the token",
    mutate: koreanParticle,
  },
  {
    id: 11,
    name: "category-rename",
    kind: "probe",
    minTokens: 1,
    description: "category renamed to a synonym that was never minted",
    mutate: categoryRename,
  },
  {
    id: 12,
    name: "category-swap",
    kind: "probe",
    minTokens: 1,
    description: "category replaced by another live one, hash kept",
    mutate: categorySwap,
  },
  {
    id: 13,
    name: "hash-swap",
    kind: "probe",
    minTokens: 2,
    description: "hashes of two live tokens exchanged (false-restoration probe)",
    mutate: hashSwap,
  },
  {
    id: 14,
    name: "invented-token",
    kind: "probe",
    minTokens: 1,
    description: "wholly invented token appended (hallucination probe)",
    mutate: inventedToken,
  },
  {
    id: 15,
    name: "code-fence",
    kind: "surface",
    minTokens: 1,
    description: "reply wrapped in a fenced code block",
    mutate: codeFence,
  },
  {
    id: 16,
    name: "triple-repeat",
    kind: "surface",
    minTokens: 1,
    description: "same token repeated three times",
    mutate: tripleRepeat,
  },
];
