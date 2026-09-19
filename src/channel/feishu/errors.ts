export type FeishuErrorCode =
  | "configuration"
  | "network_timeout"
  | "rate_limited"
  | "client_error"
  | "server_error"
  | "api_error"
  | "invalid_response";

export interface FeishuErrorOptions {
  retryable: boolean;
  status?: number;
  retryAfterSeconds?: number;
  details?: unknown;
}

/**
 * Structured provider error. TASK-1103 only classifies failures; retry loops
 * belong to the caller (webhook/worker), never to the adapter.
 */
export class FeishuError extends Error {
  readonly code: FeishuErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly details?: unknown;

  constructor(code: FeishuErrorCode, message: string, options: FeishuErrorOptions) {
    super(message);
    this.name = "FeishuError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}

/** 4xx is permanent (except 429); 5xx and 429 are retryable. */
export function classifyHttpStatus(
  status: number,
  options: { retryAfterSeconds?: number; details?: unknown } = {},
): FeishuError {
  if (status === 429) {
    return new FeishuError("rate_limited", "feishu rate limited (429)", {
      retryable: true,
      status,
      retryAfterSeconds: options.retryAfterSeconds,
      details: options.details,
    });
  }
  if (status >= 500) {
    return new FeishuError("server_error", `feishu server error (${status})`, {
      retryable: true,
      status,
      details: options.details,
    });
  }
  return new FeishuError("client_error", `feishu client error (${status})`, {
    retryable: false,
    status,
    details: options.details,
  });
}

export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
