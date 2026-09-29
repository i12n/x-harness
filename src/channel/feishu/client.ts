import { FeishuError, classifyHttpStatus, parseRetryAfterSeconds } from "./errors.js";
import type { FeishuReceiveIdType } from "./messages.js";

export interface SendMessageRequest {
  receiveId: string;
  receiveIdType?: FeishuReceiveIdType;
  msgType: "text" | "interactive";
  /** JSON string, as required by the Feishu open API. */
  content: string;
}

export interface SendCardRequest {
  receiveId: string;
  receiveIdType?: FeishuReceiveIdType;
  card: Record<string, unknown>;
}

export interface ReplyMessageRequest {
  /** The message id being replied to (the user's message). */
  messageId: string;
  msgType: "text" | "interactive";
  /** JSON string, as required by the Feishu open API. */
  content: string;
  /**
   * `true` puts the answer into a topic thread on the replied message instead
   * of the chat's main flow — what a group console wants.
   */
  replyInThread?: boolean;
}

export interface SendMessageResult {
  messageId: string;
  raw?: unknown;
}

/** Provider capability only: transport, no Harness business semantics. */
export interface FeishuClient {
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
  sendCard(request: SendCardRequest): Promise<SendMessageResult>;
  /** Reply to a specific message, optionally inside a new thread. */
  replyMessage(request: ReplyMessageRequest): Promise<SendMessageResult>;
  /** The bot's own identity — used to tell "mentioned me" from "mentioned someone". */
  getBotInfo(): Promise<BotInfo>;
}

export interface BotInfo {
  openId: string;
  name?: string;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface HttpFeishuClientOptions {
  credentials?: FeishuCredentials;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Injectable clock for token-expiry tests. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Real HTTP implementation of the Feishu provider. Credentials are optional at
 * construction: the client loads without them and only fails (structured
 * configuration error) when a real send is attempted.
 */
export class HttpFeishuClient implements FeishuClient {
  private readonly credentials: FeishuCredentials | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cachedToken: CachedToken | undefined;

  constructor(options: HttpFeishuClientOptions = {}) {
    this.credentials = options.credentials;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    if (!this.fetchImpl) {
      throw new FeishuError("configuration", "no fetch implementation available", {
        retryable: false,
      });
    }
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    return this.send(
      {
        receive_id: request.receiveId,
        msg_type: request.msgType,
        content: request.content,
      },
      request.receiveIdType ?? "chat_id",
    );
  }

  async sendCard(request: SendCardRequest): Promise<SendMessageResult> {
    return this.send(
      {
        receive_id: request.receiveId,
        msg_type: "interactive",
        content: JSON.stringify(request.card),
      },
      request.receiveIdType ?? "chat_id",
    );
  }

  async replyMessage(request: ReplyMessageRequest): Promise<SendMessageResult> {
    const token = await this.tenantAccessToken();
    const response = await this.request(
      `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(
        request.messageId,
      )}/reply`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: request.msgType,
          content: request.content,
          reply_in_thread: request.replyInThread === true,
        }),
      },
    );
    return parseMessageId(response.payload as ApiMessageResponse);
  }

  async getBotInfo(): Promise<BotInfo> {
    const token = await this.tenantAccessToken();
    const response = await this.request(`${this.baseUrl}/open-apis/bot/v3/info`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = response.payload as {
      code?: number;
      msg?: string;
      bot?: { open_id?: string; app_name?: string };
    };
    if (typeof payload.code === "number" && payload.code !== 0) {
      throw new FeishuError(
        "api_error",
        `feishu bot info failed ${payload.code}: ${payload.msg ?? "unknown"}`,
        { retryable: false, details: payload },
      );
    }
    const openId = payload.bot?.open_id;
    if (!openId) {
      throw new FeishuError("invalid_response", "feishu bot info has no open_id", {
        retryable: false,
        details: payload,
      });
    }
    return { openId, name: payload.bot?.app_name };
  }

  private async send(
    body: Record<string, unknown>,
    receiveIdType: FeishuReceiveIdType,
  ): Promise<SendMessageResult> {
    const token = await this.tenantAccessToken();
    const response = await this.request(
      `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(
        receiveIdType,
      )}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
    return parseMessageId(response.payload as ApiMessageResponse);
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now()) {
      return this.cachedToken.token;
    }
    if (!this.credentials?.appId || !this.credentials.appSecret) {
      throw new FeishuError(
        "configuration",
        "FEISHU_APP_ID / FEISHU_APP_SECRET are not configured",
        { retryable: false },
      );
    }
    const response = await this.request(
      `${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.credentials.appId,
          app_secret: this.credentials.appSecret,
        }),
      },
    );
    const payload = response.payload as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new FeishuError(
        "api_error",
        `feishu auth failed: ${payload.msg ?? payload.code ?? "unknown"}`,
        { retryable: false, details: payload },
      );
    }
    const expiresInSeconds = payload.expire ?? 3600;
    this.cachedToken = {
      token: payload.tenant_access_token,
      // Refresh one minute early.
      expiresAt: this.now() + Math.max(60, expiresInSeconds - 60) * 1000,
    };
    return this.cachedToken.token;
  }

  private async request(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; payload: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: FetchResponseLike;
    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("abort"));
      throw new FeishuError(
        "network_timeout",
        aborted ? "feishu request timed out" : `feishu request failed: ${String(error)}`,
        { retryable: true, details: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text().catch(() => "");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw classifyHttpStatus(response.status, {
          retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
          details: text,
        });
      }
      throw new FeishuError("invalid_response", "feishu response is not valid JSON", {
        retryable: false,
        status: response.status,
        details: text,
      });
    }
    if (!response.ok) {
      throw classifyHttpStatus(response.status, {
        retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
        details: payload,
      });
    }
    return { status: response.status, payload };
  }
}

interface ApiMessageResponse {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

/** Shared by send() and replyMessage(): both return the created message id. */
function parseMessageId(payload: ApiMessageResponse): SendMessageResult {
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new FeishuError(
      "api_error",
      `feishu api error ${payload.code}: ${payload.msg ?? "unknown"}`,
      { retryable: false, details: payload },
    );
  }
  const messageId = payload.data?.message_id;
  if (!messageId) {
    throw new FeishuError("invalid_response", "feishu response has no message_id", {
      retryable: false,
      details: payload,
    });
  }
  return { messageId, raw: payload };
}
