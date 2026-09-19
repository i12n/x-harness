import { createHash, timingSafeEqual } from "node:crypto";

export interface FeishuVerifyOptions {
  /** Feishu app verification token (optional in dev/offline mode). */
  verificationToken?: string;
  /** Feishu encrypt key; when set, request signatures are verified. */
  encryptKey?: string;
  /** Max accepted clock skew for the request timestamp (default 300s). */
  maxSkewSeconds?: number;
  now?: () => number;
}

export interface FeishuVerifyInput {
  headers: Record<string, string | undefined>;
  body: string;
}

export type FeishuVerifyOutcome =
  | {
      ok: true;
      payload: Record<string, unknown>;
      /** True when a token/key was configured AND all checks passed. */
      verified: boolean;
      challenge?: string;
    }
  | { ok: false; status: number; reason: string };

/**
 * TASK-1104: verification happens BEFORE parsing or any Conversation side
 * effect. Conversation never sees Feishu signatures.
 */
export function verifyFeishuRequest(
  input: FeishuVerifyInput,
  options: FeishuVerifyOptions = {},
): FeishuVerifyOutcome {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.body) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, reason: "malformed JSON body" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, status: 400, reason: "event payload must be an object" };
  }

  const headers = normalizeHeaders(input.headers);
  const tokenConfigured = Boolean(options.verificationToken);
  const keyConfigured = Boolean(options.encryptKey);

  // URL verification handshake: respond with the challenge, no side effects.
  if (payload.type === "url_verification") {
    const challenge = typeof payload.challenge === "string" ? payload.challenge : undefined;
    if (tokenConfigured && payload.token !== options.verificationToken) {
      return { ok: false, status: 403, reason: "invalid verification token" };
    }
    if (!challenge) {
      return { ok: false, status: 400, reason: "missing challenge" };
    }
    return { ok: true, payload, verified: tokenConfigured, challenge };
  }

  if (tokenConfigured && payload.token !== undefined && payload.token !== options.verificationToken) {
    return { ok: false, status: 403, reason: "invalid verification token" };
  }

  if (keyConfigured) {
    const timestamp = headers["x-lark-request-timestamp"];
    const nonce = headers["x-lark-request-nonce"];
    const signature = headers["x-lark-signature"];
    if (!timestamp || !nonce || !signature) {
      return { ok: false, status: 403, reason: "missing signature headers" };
    }
    const expected = createHash("sha256")
      .update(`${timestamp}${nonce}${options.encryptKey}${input.body}`)
      .digest("hex");
    if (!safeEqual(expected, signature)) {
      return { ok: false, status: 403, reason: "invalid signature" };
    }
  }

  const timestampHeader = headers["x-lark-request-timestamp"];
  if (timestampHeader) {
    const timestamp = Number(timestampHeader);
    const now = options.now?.() ?? Date.now();
    const maxSkewMs = (options.maxSkewSeconds ?? 300) * 1000;
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp * 1000) > maxSkewMs) {
      return { ok: false, status: 403, reason: "stale request timestamp" };
    }
  }

  return { ok: true, payload, verified: tokenConfigured || keyConfigured };
}

/** Signature used by Feishu callbacks: sha256(timestamp + nonce + key + body). */
export function feishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
): string {
  return createHash("sha256")
    .update(`${timestamp}${nonce}${encryptKey}${body}`)
    .digest("hex");
}

function normalizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}
