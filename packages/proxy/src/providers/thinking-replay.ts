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
 * - **Never forward** a block that cannot be resolved — drop it instead.
 * - An empty `thinking` was never restored, so it bypasses the cache.
 */

export function isAnthropicThinkingBlock(
  block: AnthropicContentBlock
): block is AnthropicThinkingBlock {
  if (block.type !== "thinking") return false;
  return typeof block.thinking === "string" && typeof block.signature === "string";
}

/**
 * Swap every replayed thinking block back to the bytes Anthropic signed.
 *
 * With no cache nothing was ever restored, so there is nothing to undo and the
 * messages pass through untouched.
 *
 * A block that cannot be resolved is dropped, never forwarded: forwarding it
 * would put the user's plaintext PII on the wire. Dropping is verified against
 * the live API across manual, adaptive and thinking-disabled requests, and for
 * tool-use turns — upstream accepts an assistant turn with no thinking block.
 */
export function replayThinking(
  msgs: AnthropicMessage[] | undefined,
  cache: ThinkingCache | undefined
): AnthropicMessage[] {
  const messages = Array.isArray(msgs) ? msgs : [];
  if (cache === undefined) return messages;

  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    const blocks: AnthropicContentBlock[] = [];
    for (const block of message.content) {
      const resolved = resolveThinkingBlock(block, cache);
      if (resolved !== undefined) blocks.push(resolved);
    }
    out.push({ ...message, content: blocks });
  }
  return out;
}

/**
 * `redacted_thinking` and every non-thinking block are forwarded verbatim —
 * they carry no plaintext and Anthropic expects them back unchanged.
 * `undefined` means the block cannot be resolved and must be dropped.
 */
function resolveThinkingBlock(
  block: AnthropicContentBlock,
  cache: ThinkingCache
): AnthropicContentBlock | undefined {
  if (!block || typeof block !== "object" || block.type !== "thinking") {
    return block;
  }
  if (!isAnthropicThinkingBlock(block)) return undefined;
  // Safe because `restore` only swaps a token for its original and never
  // empties a string: "" on the way in proves "" is what upstream signed, so
  // there is no plaintext to leak. Adaptive-thinking models return this shape
  // for *every* block, which would make a cache miss here fatal for nothing.
  if (block.thinking === "") return block;
  const signed = cache.get(block.signature);
  if (signed === undefined) return undefined;
  return { ...block, thinking: signed };
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
