import { HarnessError } from "../errors.js";

/**
 * Minimal OpenAI-compatible chat client used by the control plane (intent
 * parsing, problem analysis). It is deliberately transport-only: no prompt,
 * no retry policy, no Harness vocabulary.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  /** Ask an OpenAI-compatible provider for a JSON object response. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatClient {
  readonly model: string;
  complete(request: ChatCompletionRequest): Promise<string>;
}

export interface ChatFetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type ChatFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ChatFetchResponseLike>;

export interface HttpChatClientOptions {
  /** Provider base url, e.g. `https://api.deepseek.com` or `.../v1`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  fetchImpl?: ChatFetchLike;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0;

/** `https://host`, `https://host/v1` and `.../v1/chat/completions` all work. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new HarnessError("chat client base url is empty");
  }
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

export class HttpChatClient implements ChatClient {
  readonly model: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly fetchImpl: ChatFetchLike;

  constructor(options: HttpChatClientOptions) {
    if (!options.apiKey?.trim()) {
      throw new HarnessError("chat client api key is required");
    }
    this.model = options.model;
    this.url = chatCompletionsUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = options.defaultTemperature ?? DEFAULT_TEMPERATURE;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as ChatFetchLike);
    if (!this.fetchImpl) {
      throw new HarnessError("no fetch implementation available for the chat client");
    }
  }

  async complete(request: ChatCompletionRequest): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      temperature: request.temperature ?? this.temperature,
      max_tokens: request.maxTokens ?? this.maxTokens,
    };
    if (request.json) {
      body.response_format = { type: "json_object" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: ChatFetchResponseLike;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HarnessError(`chat completion request failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new HarnessError(
        `chat completion failed with status ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return extractContent(text);
  }
}

/** Reads `choices[0].message.content`; tolerant of provider-specific extras. */
export function extractContent(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HarnessError(
      `chat completion returned no JSON: ${raw.slice(0, 300)}`,
    );
  }
  const choices = asRecord(parsed)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new HarnessError("chat completion returned no choices");
  }
  const content = asRecord(asRecord(choices[0])?.message)?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new HarnessError("chat completion returned empty content");
  }
  return content;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
