/**
 * UserPromptSubmit hook stdin/stdout protocol (ADR-0012).
 *
 * Verified against docs.anthropic.com/en/docs/claude-code/hooks on 2026-05-12.
 * Do not add fields that have no upstream proof — see ADR-0011 for the cost
 * of guessing about hook surfaces.
 */

/** stdin JSON payload Claude Code sends to a UserPromptSubmit hook. */
export interface UserPromptSubmitInput {
  /** Required: session UUID. */
  session_id: string;
  /** Required: path to the session JSONL transcript file. */
  transcript_path: string;
  /** Required: current working directory at prompt-submit time. */
  cwd: string;
  /** Required: permission mode active for this turn (e.g., "default"). */
  permission_mode: string;
  /** Required: literal string `"UserPromptSubmit"`. */
  hook_event_name: "UserPromptSubmit";
  /** Required: raw user-typed prompt. */
  prompt: string;
}

/**
 * stdout JSON the hook is allowed to emit. All fields optional, but exactly
 * one of `decision` / `hookSpecificOutput.additionalContext` should be set;
 * see ADR-0012 for the decision matrix.
 */
export interface UserPromptSubmitOutput {
  /** "block" stops the prompt and erases it from the context. */
  decision?: "block";
  /** Human-readable rationale shown to the user (block path). */
  reason?: string;
  /** Optional renamed session title (recorded by Claude Code). */
  sessionTitle?: string;
  /** Container for non-blocking outputs (allowed path). */
  hookSpecificOutput?: {
    /** Extra context appended next to the original prompt. */
    additionalContext?: string;
  };
}

/**
 * Allowed exit codes (ADR-0012 §Decision):
 *   0  -> success; Claude Code parses stdout JSON.
 *   1  -> non-blocking error; "hook error" shown, prompt continues.
 *   2  -> blocking error; stderr shown to the user as the block reason.
 *   64 -> non-blocking error (alias for 1, conventional EX_USAGE).
 */
export type HookExitCode = 0 | 1 | 2 | 64;

/**
 * Parse the stdin JSON safely. Throws a typed error so the caller can
 * decide whether to emit `decision: "block"` or `exit 2`.
 */
export function parseHookInput(raw: string): UserPromptSubmitInput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new HookProtocolError(
      `UserPromptSubmit hook stdin is not valid JSON: ${reason}`,
      { stage: "json_parse" }
    );
  }
  if (json === null || typeof json !== "object") {
    throw new HookProtocolError(
      "UserPromptSubmit hook stdin must be a JSON object",
      { stage: "shape" }
    );
  }
  const obj = json as Record<string, unknown>;
  const event = obj["hook_event_name"];
  if (event !== "UserPromptSubmit") {
    throw new HookProtocolError(
      `UserPromptSubmit hook saw hook_event_name=${JSON.stringify(event)}`,
      { stage: "event_name" }
    );
  }
  const prompt = obj["prompt"];
  if (typeof prompt !== "string") {
    throw new HookProtocolError(
      "UserPromptSubmit hook stdin is missing 'prompt' (string)",
      { stage: "prompt" }
    );
  }
  return {
    session_id: stringOr(obj["session_id"], ""),
    transcript_path: stringOr(obj["transcript_path"], ""),
    cwd: stringOr(obj["cwd"], ""),
    permission_mode: stringOr(obj["permission_mode"], "default"),
    hook_event_name: "UserPromptSubmit",
    prompt,
  };
}

function stringOr(v: unknown, dflt: string): string {
  return typeof v === "string" ? v : dflt;
}

export interface HookProtocolErrorMeta {
  stage:
    | "json_parse"
    | "shape"
    | "event_name"
    | "prompt"
    | "stdin_read";
}

export class HookProtocolError extends Error {
  readonly stage: HookProtocolErrorMeta["stage"];
  constructor(message: string, meta: HookProtocolErrorMeta) {
    super(message);
    this.name = "HookProtocolError";
    this.stage = meta.stage;
  }
}

/** Serialize a `UserPromptSubmitOutput` to the exact bytes printed on stdout. */
export function serializeOutput(out: UserPromptSubmitOutput): string {
  return `${JSON.stringify(out)}\n`;
}
