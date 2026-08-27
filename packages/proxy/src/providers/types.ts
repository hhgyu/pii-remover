export type ProviderName = "anthropic" | "openai" | "codex";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: unknown;
}

/** Extended-thinking block. `signature` is opaque: Anthropic verifies it against
 *  the exact `thinking` bytes it emitted and rejects any edit with a 400. */
export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

/** Thinking Anthropic itself withheld. Always replayed verbatim — there is no
 *  plaintext to restore and nothing to cache. */
export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text?: string }>;
  stream?: boolean;
  [key: string]: unknown;
}

export interface AnthropicResponseContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AnthropicResponseBody {
  id?: string;
  type?: "message";
  role?: "assistant";
  content?: AnthropicResponseContentBlock[];
  model?: string;
  stop_reason?: string;
  usage?: unknown;
  [key: string]: unknown;
}

export interface OpenAITextPart {
  type: "text";
  text: string;
}

export interface OpenAIImagePart {
  type: "image_url";
  image_url: unknown;
}

export type OpenAIContentPart =
  | OpenAITextPart
  | OpenAIImagePart
  | { type: string; [key: string]: unknown };

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  [key: string]: unknown;
}

export interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAIResponseBody {
  id?: string;
  object?: string;
  choices?: Array<{
    index?: number;
    message?: OpenAIMessage;
    finish_reason?: string;
    [key: string]: unknown;
  }>;
  usage?: unknown;
  [key: string]: unknown;
}

export interface CodexInputContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface CodexInputItem {
  type?: string;
  role?: string;
  content?: CodexInputContentPart[];
  arguments?: string;
  [key: string]: unknown;
}

export interface CodexResponsesRequestBody {
  model?: string;
  instructions?: string;
  input?: string | CodexInputItem[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface CodexOutputContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface CodexOutputItem {
  type?: string;
  role?: string;
  content?: CodexOutputContentPart[];
  arguments?: string;
  [key: string]: unknown;
}

export interface CodexResponsesResponseBody {
  id?: string;
  object?: string;
  output?: CodexOutputItem[];
  output_text?: string;
  status?: string;
  [key: string]: unknown;
}
