/**
 * Recursive transformation of string fields inside arbitrary tool argument
 * trees. Used for both masking (replace raw PII with vault tokens) and
 * restoration (replace vault tokens with original PII).
 *
 * Walker contract (shared by `maskTextFields` and `restoreTextFields`):
 *  - Walks `args` depth-first, calling the `transform` function on every
 *    eligible string leaf.
 *  - For MASKING, path-shaped fields are never transformed (`file_path`,
 *    `path`, `cwd`, `uri`, `url` and their case-insensitive variants):
 *    they are tool plumbing and would yield false positives against the
 *    OPF/regex backends.
 *  - For RESTORATION, NO field is skipped. Vault tokens demonstrably end
 *    up inside path-shaped fields (the LLM echoes masked paths back in
 *    `filePath` / `workdir` args), and restoring is a no-op on strings
 *    without an `{{OPF:` substring, so skipping has no upside.
 *  - Strings whose trimmed length is <= `MIN_MASK_LENGTH` (8) are skipped
 *    during masking (statistically unlikely to carry PII). Restoration
 *    uses a 0-length minimum because vault tokens themselves can be
 *    short and any string containing `{{OPF:` is a candidate.
 *  - Cycles are tolerated via a `WeakSet`; revisited objects/arrays are
 *    returned unchanged.
 *
 * The walker mutates the input object **in place** — OpenCode's hook
 * contract reads back the same reference assigned to `output.args`.
 * Returning the mutated value is a convenience for chained pipelines.
 */

/** Conservative skip list — exact field names that must never be masked. */
export const DEFAULT_SKIP_FIELDS: ReadonlySet<string> = new Set([
  "file_path",
  "filepath",
  "path",
  "cwd",
  "workdir",
  "worktree",
  "uri",
  "url",
  "directory",
  "dir",
  "root",
  "pattern",
  "glob",
  "include",
  "exclude",
  "tool",
  "command",
  "action",
  "id",
  "session_id",
  "sessionid",
  "call_id",
  "callid",
  "request_id",
  "requestid",
]);

/** Strings whose trimmed length is <= this threshold are skipped. */
export const MIN_MASK_LENGTH = 8;

const EMPTY_SKIP_FIELDS: ReadonlySet<string> = new Set();

export type MaskFn = (text: string) => string | Promise<string>;
export type RestoreFn = (text: string) => string | Promise<string>;

export interface MaskOptions {
  /** Override or extend the default skip list. */
  skipFields?: ReadonlySet<string>;
  /** Minimum trimmed length for a string to be considered for masking. */
  minLength?: number;
}

export interface RestoreOptions {
  /** Override or extend the default skip list. */
  skipFields?: ReadonlySet<string>;
}

interface TransformContext {
  transform: MaskFn;
  skip: ReadonlySet<string>;
  minLength: number;
  visited: WeakSet<object>;
  skipHeuristic: boolean;
}

function shouldSkipField(
  fieldName: string,
  skip: ReadonlySet<string>,
  skipHeuristic: boolean
): boolean {
  const lower = fieldName.toLowerCase();
  if (skip.has(lower)) return true;
  if (!skipHeuristic) return false;
  // Heuristic: anything ending in `_path`, `_dir`, `_file`, `_id` is plumbing.
  if (/_(path|dir|file|id|uri|url|name)$/i.test(fieldName)) return true;
  return false;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== "object") return false;
  // Reject things like Date, Map, RegExp, etc. — they are not PII carriers
  // and re-assigning their string slots can corrupt them.
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

async function transformStringIfEligible(
  value: string,
  ctx: TransformContext
): Promise<string> {
  if (value.trim().length <= ctx.minLength) return value;
  const result = await ctx.transform(value);
  return typeof result === "string" ? result : value;
}

async function walkAndTransform(
  parentKey: string | null,
  value: unknown,
  ctx: TransformContext
): Promise<unknown> {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (parentKey !== null && shouldSkipField(parentKey, ctx.skip, ctx.skipHeuristic)) {
      return value;
    }
    return await transformStringIfEligible(value, ctx);
  }

  if (typeof value !== "object") return value;

  if (ctx.visited.has(value as object)) return value;
  ctx.visited.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const next = await walkAndTransform(parentKey, value[i], ctx);
      if (next !== value[i]) value[i] = next;
    }
    return value;
  }

  if (!isPlainObject(value)) return value;

  for (const key of Object.keys(value)) {
    const cur = value[key];
    const next = await walkAndTransform(key, cur, ctx);
    if (next !== cur) value[key] = next;
  }
  return value;
}

export async function maskTextFields(
  args: unknown,
  mask: MaskFn,
  options: MaskOptions = {}
): Promise<unknown> {
  if (args === null || args === undefined) return args;
  const ctx: TransformContext = {
    transform: mask,
    skip: options.skipFields ?? DEFAULT_SKIP_FIELDS,
    minLength: options.minLength ?? MIN_MASK_LENGTH,
    visited: new WeakSet<object>(),
    skipHeuristic: true,
  };

  if (typeof args === "string") {
    return await transformStringIfEligible(args, ctx);
  }
  if (typeof args !== "object") return args;
  return await walkAndTransform(null, args, ctx);
}

/**
 * Recursively restores vault tokens in every string leaf in `args`.
 * Unlike `maskTextFields`, NO field is skipped by default and no value
 * heuristic applies: vault tokens land inside path-shaped fields when the
 * LLM echoes masked paths back (`filePath: "D:\\{{OPF:PERSON_1:\\x"`),
 * and restoring a token-free string is a no-op (see `Restorer.restore`).
 * An explicit `options.skipFields` is still honored for callers that must
 * keep specific fields untouched.
 */
export async function restoreTextFields(
  args: unknown,
  restore: RestoreFn,
  options: RestoreOptions = {}
): Promise<unknown> {
  if (args === null || args === undefined) return args;
  const ctx: TransformContext = {
    transform: restore,
    skip: options.skipFields ?? EMPTY_SKIP_FIELDS,
    minLength: 0,
    visited: new WeakSet<object>(),
    skipHeuristic: false,
  };

  if (typeof args === "string") {
    return await transformStringIfEligible(args, ctx);
  }
  if (typeof args !== "object") return args;
  return await walkAndTransform(null, args, ctx);
}

/**
 * Strict variant for the LLM-boundary safety net: no path-name skip list and
 * no length threshold. Used for unknown/future part types in
 * `experimental.chat.messages.transform` so a forgotten field shape cannot
 * leak raw PII to the model.
 */
export async function maskTextFieldsStrict(
  args: unknown,
  mask: MaskFn
): Promise<unknown> {
  if (args === null || args === undefined) return args;
  const ctx: TransformContext = {
    transform: mask,
    skip: STRICT_SKIP_FIELDS,
    minLength: 0,
    visited: new WeakSet<object>(),
    skipHeuristic: false,
  };

  if (typeof args === "string") {
    return await transformStringIfEligible(args, ctx);
  }
  if (typeof args !== "object") return args;
  return await walkAndTransform(null, args, ctx);
}

const STRICT_SKIP_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "id",
  "callid",
  "tool",
  "sessionid",
  "messageid",
  "partid",
]);
