import { describe, expect, it } from "vitest";
import { FeishuAdapter } from "../src/channel/feishu/adapter.js";
import {
  HttpFeishuClient,
  type FetchLike,
  type FetchResponseLike,
  type SendCardRequest,
  type SendMessageRequest,
  type SendMessageResult,
  type FeishuClient,
} from "../src/channel/feishu/client.js";
import { FeishuError } from "../src/channel/feishu/errors.js";
import { buildFeishuPayload } from "../src/channel/feishu/messages.js";
import { renderFeishuCard } from "../src/channel/feishu/cards.js";
import type { IncomingMessage, OutgoingMessage } from "../src/channel/message.js";

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const CREDENTIALS = { appId: "app-1", appSecret: "secret-1" };
const AUTH_OK = { code: 0, tenant_access_token: "token-1", expire: 3600 };
const SEND_OK = { code: 0, data: { message_id: "om_1" } };

function fetchSequence(responses: (FetchResponseLike | Error)[]): {
  fetchImpl: FetchLike;
  calls: { url: string; body?: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; body?: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) {
      throw next;
    }
    return next!;
  };
  return { fetchImpl, calls };
}

class FakeClient implements FeishuClient {
  messages: SendMessageRequest[] = [];
  cards: SendCardRequest[] = [];
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.messages.push(request);
    return { messageId: `msg-${this.messages.length}` };
  }
  async sendCard(request: SendCardRequest): Promise<SendMessageResult> {
    this.cards.push(request);
    return { messageId: `card-${this.cards.length}` };
  }
}

describe("Feishu provider (TASK-1103)", () => {
  it("converts plain text into a Feishu text message", () => {
    const payload = buildFeishuPayload(
      { conversationId: "conv-1", text: "hello" },
      { receiveId: "chat-1" },
    );

    expect(payload).toMatchObject({
      receiveId: "chat-1",
      receiveIdType: "chat_id",
      msgType: "text",
    });
    expect(JSON.parse(payload.content)).toEqual({ text: "hello" });
  });

  it("converts structured blocks into a generic interactive card", () => {
    const outgoing: OutgoingMessage = {
      conversationId: "conv-1",
      text: "Run: run-001",
      blocks: [
        { type: "text", text: "Targets:" },
        { type: "code", text: "npm test", language: "sh" },
        { type: "divider" },
      ],
    };
    const payload = buildFeishuPayload(outgoing, { receiveId: "chat-1" });

    expect(payload.msgType).toBe("interactive");
    const card = JSON.parse(payload.content) as ReturnType<typeof renderFeishuCard>;
    expect(card.config).toEqual({ wide_screen_mode: true });
    expect(card.elements[0]).toMatchObject({
      tag: "div",
      text: { tag: "lark_md", content: "Run: run-001" },
    });
    expect(card.elements.some((element) => element.tag === "hr")).toBe(true);
    expect(JSON.stringify(card)).toContain("```sh\\nnpm test\\n```");
  });

  it("sends the correct request to the Feishu API and caches the token", async () => {
    const { fetchImpl, calls } = fetchSequence([
      response(200, AUTH_OK),
      response(200, SEND_OK),
      response(200, SEND_OK),
    ]);
    const client = new HttpFeishuClient({ credentials: CREDENTIALS, fetchImpl });

    await client.sendMessage({
      receiveId: "chat-1",
      receiveIdType: "chat_id",
      msgType: "text",
      content: JSON.stringify({ text: "hi" }),
    });
    await client.sendMessage({
      receiveId: "chat-1",
      msgType: "text",
      content: JSON.stringify({ text: "again" }),
    });

    expect(calls[0]?.url).toContain("/open-apis/auth/v3/tenant_access_token/internal");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      app_id: "app-1",
      app_secret: "secret-1",
    });
    expect(calls[1]?.url).toContain("/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(calls[1]?.headers.authorization).toBe("Bearer token-1");
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      receive_id: "chat-1",
      msg_type: "text",
      content: JSON.stringify({ text: "hi" }),
    });
    // Token is fetched once and reused.
    expect(calls.filter((call) => call.url.includes("tenant_access_token"))).toHaveLength(1);
  });

  it("classifies 4xx as non-retryable", async () => {
    const { fetchImpl } = fetchSequence([
      response(200, AUTH_OK),
      response(400, { code: 400, msg: "bad request" }),
    ]);
    const client = new HttpFeishuClient({ credentials: CREDENTIALS, fetchImpl });

    const error = await client
      .sendMessage({ receiveId: "chat-1", msgType: "text", content: "{}" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeishuError);
    expect(error).toMatchObject({ code: "client_error", retryable: false, status: 400 });
  });

  it("classifies 5xx as retryable", async () => {
    const { fetchImpl } = fetchSequence([response(200, AUTH_OK), response(503, {})]);
    const client = new HttpFeishuClient({ credentials: CREDENTIALS, fetchImpl });

    const error = await client
      .sendMessage({ receiveId: "chat-1", msgType: "text", content: "{}" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "server_error", retryable: true, status: 503 });
  });

  it("classifies 429 as retryable with Retry-After", async () => {
    const { fetchImpl } = fetchSequence([
      response(200, AUTH_OK),
      response(429, { code: 99991400 }, { "retry-after": "3" }),
    ]);
    const client = new HttpFeishuClient({ credentials: CREDENTIALS, fetchImpl });

    const error = await client
      .sendMessage({ receiveId: "chat-1", msgType: "text", content: "{}" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      status: 429,
      retryAfterSeconds: 3,
    });
  });

  it("classifies network timeouts as retryable", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const { fetchImpl } = fetchSequence([abortError]);
    const client = new HttpFeishuClient({ credentials: CREDENTIALS, fetchImpl });

    const error = await client
      .sendMessage({ receiveId: "chat-1", msgType: "text", content: "{}" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "network_timeout", retryable: true });
  });

  it("classifies malformed responses as invalid (not retryable)", async () => {
    const { fetchImpl } = fetchSequence([response(200, "<html>not json</html>")]);
    const client = new HttpFeishuClient({ credentials: CREDENTIALS, fetchImpl });

    const error = await client
      .sendMessage({ receiveId: "chat-1", msgType: "text", content: "{}" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_response", retryable: false });
  });

  it("loads without credentials and fails only when sending", async () => {
    const { fetchImpl } = fetchSequence([response(200, SEND_OK)]);
    const client = new HttpFeishuClient({ fetchImpl });

    const error = await client
      .sendMessage({ receiveId: "chat-1", msgType: "text", content: "{}" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeishuError);
    expect(error).toMatchObject({ code: "configuration", retryable: false });
  });

  it("adapter routes text to sendMessage and blocks to sendCard", async () => {
    const client = new FakeClient();
    const adapter = new FeishuAdapter({ client, defaultReceiveId: "chat-1" });

    await adapter.send({ conversationId: "conv-1", text: "hello" });
    await adapter.send({
      conversationId: "conv-1",
      blocks: [{ type: "text", text: "card" }],
    });

    expect(adapter.id).toBe("feishu");
    expect(client.messages).toHaveLength(1);
    expect(client.messages[0]).toMatchObject({ receiveId: "chat-1", msgType: "text" });
    expect(client.cards).toHaveLength(1);
    expect(client.cards[0]?.card).toMatchObject({
      config: { wide_screen_mode: true },
    });
  });

  it("receive is a no-op without a handler (webhook wiring is TASK-1104)", async () => {
    const client = new FakeClient();
    const adapter = new FeishuAdapter({ client });
    const message: IncomingMessage = {
      channel: "feishu",
      conversationId: "conv-1",
      messageId: "m-1",
      senderId: "u-1",
      text: "hi",
      timestamp: new Date(),
    };

    await expect(adapter.receive(message)).resolves.toBeUndefined();
    expect(client.messages).toHaveLength(0);
  });
});
