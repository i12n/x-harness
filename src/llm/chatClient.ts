import { HarnessError } from "../errors.js";

/**
 * Minimal OpenAI-compatible chat client used by the control plane (intent
 * parsing, problem analysis). It is deliberately transport-only: no prompt,
 * no Harness vocabulary. The one policy it owns is the token-budget escalation
 * below, because that failure is a transport-level artefact of reasoning
 * models — callers cannot tell it apart from "the model had nothing to say".
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

/**
 * Reasoning providers (DeepSeek's reasoning models) charge their hidden
 * `reasoning_content` against `max_tokens`. When the reasoning alone exhausts
 * the budget, the API still answers HTTP 200 — with `content: ""` and
 * `finish_reason: "length"` — which is indistinguishable from a model that
 * deliberately said nothing. One escalation to this ceiling yields the answer
 * in practice, so `complete()` spends a single extra call instead of handing an
 * empty answer to a caller whose only option is to report failure.
 */
const MAX_ESCALATED_TOKENS = 8192;

/** The parts of `choices[0]` the client cares about. */
export interface CompletionParse {
  content: string;
  finishReason?: string;
  /** Output tokens the provider spent on hidden reasoning (reasoning models). */
  reasoningTokens?: number;
}

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
    // TASK-1251: a reasoning model can burn *several* budgets in a row on hidden
    // reasoning before writing anything, so escalate until the ceiling instead of
    // giving up after one doubling (2048 → 4096 → 8192).
    let maxTokens = request.maxTokens ?? this.maxTokens;
    for (;;) {
      const parsed = await this.sendOnce(request, maxTokens);
      // TASK-1261: JSON mode truncates silently — a partial object still counts
      // as "content", and the caller only sees `Unexpected end of JSON input`.
      // `finish_reason=length` means the model ran out of room, so buy more and
      // ask again instead of handing over a half-written object.
      const truncatedJson = Boolean(request.json) && parsed.finishReason === "length";
      if (parsed.content.trim() && !truncatedJson) {
        return parsed.content;
      }
      const next = escalateBudget(maxTokens);
      if (next === undefined) {
        if (parsed.content.trim()) {
          return parsed.content;
        }
        throw emptyContentError(parsed, maxTokens);
      }
      maxTokens = next;
    }
  }

  private async sendOnce(
    request: ChatCompletionRequest,
    maxTokens: number,
  ): Promise<CompletionParse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      temperature: request.temperature ?? this.temperature,
      max_tokens: maxTokens,
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
    return parseCompletion(text);
  }
}

/**
 * Doubles the output budget until {@link MAX_ESCALATED_TOKENS}; `undefined`
 * means the request already asked for the ceiling, so a retry cannot help.
 */
function escalateBudget(current: number): number | undefined {
  if (!Number.isFinite(current) || current >= MAX_ESCALATED_TOKENS) {
    return undefined;
  }
  return Math.min(current * 2, MAX_ESCALATED_TOKENS);
}

function emptyContentError(parse: CompletionParse, budget?: number): HarnessError {
  if (parse.finishReason === "length") {
    const spent =
      budget !== undefined ? `the whole ${budget}-token output budget` : "its output budget";
    const reasoning =
      parse.reasoningTokens !== undefined
        ? ` (${parse.reasoningTokens} of them reasoning)`
        : "";
    return new HarnessError(
      "chat completion returned empty content: finish_reason=length — " +
        `the model spent ${spent}${reasoning} before writing an answer; ` +
        "raise the token budget or use a non-reasoning model",
    );
  }
  return new HarnessError("chat completion returned empty content");
}

/**
 * Reads `choices[0]`; tolerant of provider-specific extras like
 * `reasoning_content`, which reasoning models emit alongside `content`.
 */
export function parseCompletion(raw: string): CompletionParse {
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
  const choice = asRecord(choices[0]);
  const content = asRecord(choice?.message)?.content;
  const details = asRecord(
    asRecord(asRecord(parsed)?.usage)?.completion_tokens_details,
  );
  const reasoningTokens = details?.reasoning_tokens;
  return {
    content: typeof content === "string" ? content : "",
    finishReason:
      typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    reasoningTokens:
      typeof reasoningTokens === "number" ? reasoningTokens : undefined,
  };
}

/** Reads `choices[0].message.content`, rejecting an empty answer. */
export function extractContent(raw: string): string {
  const parsed = parseCompletion(raw);
  if (!parsed.content.trim()) {
    throw emptyContentError(parsed);
  }
  return parsed.content;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
