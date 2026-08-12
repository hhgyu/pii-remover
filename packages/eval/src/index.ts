export type {
  CorpusEntry,
  CorpusLang,
  CorpusSpan,
  MaskedEntry,
  MutationClass,
  MutationCorpus,
  MutationKind,
  MutationResult,
  Mutator,
  SurfaceForm,
  TokenInfo,
} from "./types.js";

export {
  CORPUS_PATH,
  EVAL_SESSION_ID,
  FIXTURES_DIR,
  PACKAGE_ROOT,
  loadCorpus,
  locateSpans,
  maskCorpus,
  vaultValues,
  type MaskedCorpus,
} from "./corpus/index.js";

export {
  HALLUCINATED_HASH,
  MUTATION_CLASSES,
  firstStraddlingToken,
  heldBackTail,
  reassemble,
  streamChunks,
} from "./mutators/index.js";

export {
  classifyTokenResolution,
  falseRestorationRate,
  roundtripRate,
  scoreRoundtrip,
  type IdentityTotals,
  type ResolutionOutcome,
  type RoundtripInput,
  type RoundtripScore,
  type TokenResolutionProbe,
  type TokenVerdict,
} from "./scoring/index.js";

export {
  addIdentity,
  classStatus,
  emptyIdentity,
  isFailure,
  type ClassStatus,
  type IdentityResult,
  type MutationClassResult,
  type Tier1Report,
} from "./report/types.js";

export {
  formatBaselineMarkdown,
  formatIdentityTable,
  formatPercent,
  formatTier1Table,
} from "./report/table.js";

export {
  BASELINE_PATH,
  failingClasses,
  runTier1,
  writeBaseline,
  type Tier1Options,
} from "./runners/tier1-mutation.js";
