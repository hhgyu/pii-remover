import { PIIRemover, type PIIRemoverInitOptions } from "@pii-remover/core";

import {
  HookProtocolError,
  parseHookInput,
  serializeOutput,
  type HookExitCode,
  type UserPromptSubmitOutput,
} from "../protocol/user-prompt-submit.js";
import { detectProxy, type ProxyDetectionEnv } from "../protocol/proxy-detection.js";

export interface HookCommandIo {
  stdin: () => Promise<string>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  initPiiRemover?: (opts: PIIRemoverInitOptions) => Promise<PIIRemover>;
}

export interface HookCommandResult {
  exitCode: HookExitCode;
  decision: "allow_silent" | "allow_warn" | "block" | "block_error";
  detection_count: number;
  proxy_configured: boolean;
}

const MAX_REASON_PREVIEW = 64;

export async function runHookCommand(
  io: HookCommandIo
): Promise<HookCommandResult> {
  const env = io.env ?? process.env;
  const initFn =
    io.initPiiRemover ??
    ((opts: PIIRemoverInitOptions) => PIIRemover.init(opts));

  let raw: string;
  try {
    raw = await io.stdin();
  } catch (err) {
    return emitBlockError(
      io,
      `Failed to read hook stdin: ${(err as Error).message}`
    );
  }

  let input;
  try {
    input = parseHookInput(raw);
  } catch (err) {
    if (err instanceof HookProtocolError) {
      return emitBlockError(io, err.message);
    }
    return emitBlockError(io, `Unexpected stdin error: ${(err as Error).message}`);
  }

  const proxy = detectProxy(env as ProxyDetectionEnv);

  let remover: PIIRemover;
  try {
    remover = await initFn({ env, warn: (m) => io.stderr(`${m}\n`) });
  } catch (err) {
    return emitBlockError(
      io,
      `PII Remover initialisation failed (fail-closed): ${(err as Error).message}`
    );
  }

  try {
    const masked = await remover.mask(input.prompt, {
      request_id: `claude-hook:${input.session_id || "unknown"}`,
    });
    const count = masked.tokens.length;

    if (count === 0) {
      io.stdout("");
      remover.dispose();
      return {
        exitCode: 0,
        decision: "allow_silent",
        detection_count: 0,
        proxy_configured: proxy.configured,
      };
    }

    if (!proxy.configured) {
      const output: UserPromptSubmitOutput = {
        decision: "block",
        reason: buildBlockReason(count, masked.tokens.map((t) => t.token), proxy.reason),
      };
      io.stdout(serializeOutput(output));
      remover.dispose();
      return {
        exitCode: 0,
        decision: "block",
        detection_count: count,
        proxy_configured: false,
      };
    }

    const output: UserPromptSubmitOutput = {
      hookSpecificOutput: {
        additionalContext: buildAllowContext(masked.tokens, masked.text),
      },
    };
    io.stdout(serializeOutput(output));
    remover.dispose();
    return {
      exitCode: 0,
      decision: "allow_warn",
      detection_count: count,
      proxy_configured: true,
    };
  } catch (err) {
    try {
      remover.dispose();
    } catch {
      /* dispose best-effort */
    }
    const reason = err instanceof Error ? err.message : String(err);
    return emitBlockError(io, `PII detection failed (fail-closed): ${reason}`);
  }
}

function emitBlockError(
  io: HookCommandIo,
  reason: string
): HookCommandResult {
  io.stderr(`pii-remover hook: ${reason}\n`);
  const output: UserPromptSubmitOutput = {
    decision: "block",
    reason: `pii-remover (fail-closed): ${truncate(reason, 240)}`,
  };
  try {
    io.stdout(serializeOutput(output));
  } catch {
    /* stdout write best-effort; exit 2 still blocks */
  }
  return {
    exitCode: 2,
    decision: "block_error",
    detection_count: 0,
    proxy_configured: false,
  };
}

function buildBlockReason(
  count: number,
  tokens: readonly string[],
  proxyReason: string
): string {
  const preview = tokens
    .slice(0, 4)
    .map((t) => truncate(t, MAX_REASON_PREVIEW))
    .join(", ");
  const more = tokens.length > 4 ? ` (+${tokens.length - 4} more)` : "";
  return [
    `pii-remover detected ${count} PII span(s) but no proxy is configured.`,
    `Proxy check: ${proxyReason}.`,
    `Detected tokens: ${preview}${more}.`,
    "",
    "To unblock, either:",
    "  1) Start the proxy and set ANTHROPIC_BASE_URL:",
    "     pii-remover-proxy start",
    "     export ANTHROPIC_BASE_URL=http://localhost:8765/anthropic/v1",
    "  2) Or remove the PII from your prompt and try again.",
    "  3) Or set PII_REMOVER_PROXY_TRUST=1 if a proxy is already running elsewhere.",
    "  4) Or set PII_REMOVER_BYPASS=1 to disable masking entirely (NOT recommended).",
  ].join("\n");
}

function buildAllowContext(
  tokens: readonly { token: string; category: string }[],
  masked: string
): string {
  const summary = tokens
    .map((t) => `${t.token} (${t.category})`)
    .join(", ");
  return [
    "[pii-remover] Detected PII in this prompt. The masked version below is what",
    "the local proxy will forward to Anthropic upstream:",
    "",
    masked,
    "",
    `Tokens: ${summary}`,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export async function readStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  const stream = (
    process.stdin as unknown as {
      [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | string>;
    }
  )[Symbol.asyncIterator]();
  while (true) {
    const r = await stream.next();
    if (r.done) break;
    out += typeof r.value === "string" ? r.value : decoder.decode(r.value);
  }
  return out;
}
