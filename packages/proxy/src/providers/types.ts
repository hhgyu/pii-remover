export type ProviderName = "anthropic" | "openai" | "codex";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: unknown;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
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

export interface AnthropicResponseBody {
  id?: string;
  type?: "message";
  role?: "assistant";
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
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
