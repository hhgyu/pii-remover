import type { ThinkingCache } from "../stream/thinking-cache.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicResponseContentBlock,
  AnthropicThinkingBlock,
} from "./types.js";

/**
 * The signed-thinking round trip: cache what Anthropic signed on the way out,
 * put those exact bytes back on the way in.
 *
 * Anthropic verifies a replayed `thinking` block against its opaque signature
 * and rejects the request unless the bytes are identical to what it emitted.
 * The proxy, meanwhile, shows the user *restored* thinking, so the bytes the
 * client replays are not the bytes that were signed. Re-masking is not a way
 * back either: detection is a model, and one span it fails to re-detect on the
 * second pass would put plaintext PII on the wire.
 *
 * Hence the rules this module encodes:
 * - Restore for display **only** when the signed bytes were cached first.
 * - **Never forward** a block that cannot be resolved.
 * - An empty `thinking` was never restored, so it bypasses the cache.
 * - Dropping an unresolvable block beats refusing the turn where upstream
 *   allows it — see {@link thinkingDropAllowed}.
 */

export function isAnthropicThinkingBlock(
  block: AnthropicContentBlock
): block is AnthropicThinkingBlock {
  if (block.type !== "thinking") return false;
  return typeof block.thinking === "string" && typeof block.signature === "string";
}

/**
 * Local refusal for a turn whose thinking cannot be replayed byte-identically.
 *
 * `400` on purpose: the Anthropic SDKs retry `408`/`409`/`429`/`5xx`, and this
 * condition never heals on its own — a retry loop would just repeat it. The
 * message names the condition and nothing else: no signature, no thinking text,
 * no restored PII.
 */
export const THINKING_REPLAY_REJECTION = {
  status: 400,
  body: {
    error: "thinking_replay_unavailable",
    message:
      "An extended-thinking block in this request could not be matched to the signed bytes this proxy holds for it. Forwarding it would either fail Anthropic's signature check or send restored text upstream, so the request was refused locally. Retry the turn without the stale thinking blocks, or start a new conversation.",
  },
} as const;

/** Outcome of resolving every replayed thinking block in one request. */
export type ThinkingReplay =
  | { readonly kind: "replayed"; readonly messages: AnthropicMessage[] }
  | { readonly kind: "unresolvable" };

/** Outcome for a single content block on the request path. */
type BlockReplay =
  | { readonly kind: "forward"; readonly block: AnthropicContentBlock }
  | { readonly kind: "unresolvable" };

/**
 * Swap every replayed thinking block back to the bytes Anthropic signed.
 *
 * With no cache nothing was ever restored, so there is nothing to undo and the
 * messages pass through untouched. With a cache, a block that cannot be
 * resolved fails the whole request: dropping it would draw an opaque 400 from
 * upstream, and forwarding it would put the user's plaintext PII on the wire.
 */
export function replayThinking(
  msgs: AnthropicMessage[] | undefined,
  cache: ThinkingCache | undefined,
  allowDrop = false
): ThinkingReplay {
  const messages = Array.isArray(msgs) ? msgs : [];
  if (cache === undefined) return { kind: "replayed", messages };

  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    const blocks: AnthropicContentBlock[] = [];
    for (const block of message.content) {
      const replay = resolveThinkingBlock(block, cache);
      if (replay.kind === "unresolvable") {
        if (!allowDrop) return { kind: "unresolvable" };
        continue;
      }
      blocks.push(replay.block);
    }
    out.push({ ...message, content: blocks });
  }
  return { kind: "replayed", messages: out };
}

/**
 * Verified against the live API for `adaptive`: an assistant turn with its
 * thinking blocks removed is accepted. Manual mode still requires the final
 * assistant turn to begin with a thinking block, so dropping stays off there.
 */
export function thinkingDropAllowed(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const thinking = (body as { thinking?: unknown }).thinking;
  if (typeof thinking !== "object" || thinking === null) return false;
  return (thinking as { type?: unknown }).type === "adaptive";
}

/**
 * `redacted_thinking` and every non-thinking block are forwarded verbatim —
 * they carry no plaintext and Anthropic expects them back unchanged.
 */
function resolveThinkingBlock(
  block: AnthropicContentBlock,
  cache: ThinkingCache
): BlockReplay {
  if (!block || typeof block !== "object" || block.type !== "thinking") {
    return { kind: "forward", block };
  }
  if (!isAnthropicThinkingBlock(block)) return { kind: "unresolvable" };
  // Safe because `restore` only swaps a token for its original and never
  // empties a string: "" on the way in proves "" is what upstream signed, so
  // there is no plaintext to leak. Adaptive-thinking models return this shape
  // for *every* block, which makes a cache miss here fatal for nothing.
  if (block.thinking === "") return { kind: "forward", block };
  const signed = cache.get(block.signature);
  if (signed === undefined) return { kind: "unresolvable" };
  return { kind: "forward", block: { ...block, thinking: signed } };
}

/**
 * Restore a response thinking block for the user's eyes only after its signed
 * bytes are safely cached — the cache is what lets the next request replay them
 * byte-identically. With no cache there is no way back, so the block is left
 * masked instead.
 *
 * A `display: "omitted"` block arrives signed with an empty `thinking`; caching
 * that empty string is what makes its replay resolvable next turn.
 */
export function restoreThinkingBlock(
  block: AnthropicResponseContentBlock,
  cache: ThinkingCache | undefined,
  restore: (text: string) => string
): AnthropicResponseContentBlock {
  const thinking = block.thinking;
  const signature = block.signature;
  if (
    cache === undefined ||
    typeof thinking !== "string" ||
    typeof signature !== "string" ||
    signature.length === 0
  ) {
    return block;
  }
  cache.set(signature, thinking);
  return { ...block, thinking: restore(thinking) };
}
