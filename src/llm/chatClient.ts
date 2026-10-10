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
/**
 * TASK-1262: start where a reasoning model can actually finish — 8192 tokens.
 * 2048 was routinely eaten by hidden reasoning, which then surfaced as an empty
 * or half-written answer.
 */
const DEFAULT_MAX_TOKENS = 8192;
/** TASK-1262: at most three attempts per completion, doubling each time. */
export const MAX_COMPLETION_ATTEMPTS = 3;
const DEFAULT_TEMPERATURE = 0;

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
    // TASK-1262: at most three attempts, each with double the previous budget
    // (8192 → 16384 → 32768). A reasoning model can burn a whole budget on
    // hidden reasoning, and JSON mode can truncate a half-written object, so an
    // attempt only counts as success when it produced usable content.
    let maxTokens = request.maxTokens ?? this.maxTokens;
    let last: CompletionParse | undefined;
    let lastBudget = maxTokens;
    for (let attempt = 1; attempt <= MAX_COMPLETION_ATTEMPTS; attempt += 1) {
      const parsed = await this.sendOnce(request, maxTokens);
      const truncatedJson = Boolean(request.json) && parsed.finishReason === "length";
      if (parsed.content.trim() && !truncatedJson) {
        return parsed.content;
      }
      last = parsed;
      lastBudget = maxTokens;
      maxTokens = escalateBudget(maxTokens);
    }
    throw completionExhaustedError(last, lastBudget);
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

/** TASK-1262: the next attempt's budget — a plain doubling, no ceiling. */
function escalateBudget(current: number): number {
  return Number.isFinite(current) ? current * 2 : DEFAULT_MAX_TOKENS;
}

/**
 * TASK-1262: three attempts (8192 → 16384 → 32768) and then a real error, so a
 * caller never has to guess whether a half-written answer is worth parsing.
 */
function completionExhaustedError(
  parse: CompletionParse | undefined,
  budget: number,
): HarnessError {
  const spent =
    parse?.finishReason === "length"
      ? `the whole ${budget}-token budget of the last attempt`
      : "no usable content";
  const reasoning =
    parse?.reasoningTokens !== undefined ? ` (${parse.reasoningTokens} of them reasoning)` : "";
  return new HarnessError(
    `chat completion failed after ${MAX_COMPLETION_ATTEMPTS} attempts: the model spent ${spent}${reasoning}; ` +
      "raise the token budget or use a non-reasoning model",
  );
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
