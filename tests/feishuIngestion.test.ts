import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationService } from "../src/conversation/service.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";
import { FeishuEventIngestion } from "../src/channel/feishu/webhook.js";
import { feishuSignature } from "../src/channel/feishu/verification.js";

const FIXTURES = join(process.cwd(), "src/channel/feishu/fixtures");
const ENCRYPT_KEY = "encrypt-key-1";
const VERIFICATION_TOKEN = "verification-token-1";
const NOW_MS = 1_758_240_000_000;
const NOW_SECONDS = String(NOW_MS / 1000);

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function signedHeaders(body: string): Record<string, string> {
  return {
    "x-lark-request-timestamp": NOW_SECONDS,
    "x-lark-request-nonce": "nonce-1",
    "x-lark-signature": feishuSignature(NOW_SECONDS, "nonce-1", ENCRYPT_KEY, body),
  };
}

function setup(options: { verify?: boolean; onMessage?: () => void } = {}) {
  const store = new InMemoryConversationStore();
  const conversation = new ConversationService(store);
  let sideEffects = 0;
  const ingestion = new FeishuEventIngestion({
    conversation,
    verify: options.verify
      ? {
          encryptKey: ENCRYPT_KEY,
          verificationToken: VERIFICATION_TOKEN,
          now: () => NOW_MS,
        }
      : undefined,
    onMessage: () => {
      sideEffects += 1;
      options.onMessage?.();
    },
  });
  return { store, conversation, ingestion, sideEffects: () => sideEffects };
}

describe("Feishu event ingestion (TASK-1104)", () => {
  it("answers the url_verification challenge and records nothing", async () => {
    const { store, ingestion } = setup({ verify: true });
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-123",
      token: VERIFICATION_TOKEN,
    });

    const response = await ingestion.handleRequest({ headers: {}, body });

    expect(response).toEqual({ status: 200, body: { challenge: "challenge-123" } });
    await expect(store.listConversations()).resolves.toHaveLength(0);
  });

  it("rejects a wrong verification token before any side effect", async () => {
    const { store, ingestion, sideEffects } = setup({ verify: true });
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-123",
      token: "wrong-token",
    });

    const response = await ingestion.handleRequest({ headers: {}, body });

    expect(response.status).toBe(403);
    expect(sideEffects()).toBe(0);
    await expect(store.listConversations()).resolves.toHaveLength(0);
  });

  it("rejects an invalid signature and never reaches Conversation", async () => {
    const { store, ingestion, sideEffects } = setup({ verify: true });
    const body = fixture("message.json");

    const response = await ingestion.handleRequest({
      headers: { ...signedHeaders(body), "x-lark-signature": "deadbeef" },
      body,
    });

    expect(response.status).toBe(403);
    expect(sideEffects()).toBe(0);
    await expect(store.listConversations()).resolves.toHaveLength(0);
  });

  it("rejects missing signature headers and stale timestamps", async () => {
    const { ingestion } = setup({ verify: true });
    const body = fixture("message.json");

    expect((await ingestion.handleRequest({ headers: {}, body })).status).toBe(403);

    const staleHeaders = signedHeaders(body);
    const stale = await ingestion.handleRequest({
      headers: { ...staleHeaders, "x-lark-request-timestamp": "1000000" },
      body,
    });
    expect(stale).toMatchObject({ status: 403 });
  });

  it("parses a direct message into IncomingMessage and Conversation", async () => {
    const { store, ingestion, sideEffects } = setup({ verify: true });
    const body = fixture("message.json");

    const response = await ingestion.handleRequest({
      headers: signedHeaders(body),
      body,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ duplicate: false });
    const conversation = await store.findConversationByExternal({
      channel: "feishu",
      externalChatId: "oc_chat_1",
    });
    expect(conversation).toBeDefined();
    const messages = await store.listMessages(conversation!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channel: "feishu",
      direction: "INBOUND",
      senderId: "ou_user_1",
      messageType: "text",
      content: "Rehelu 首页太空了",
      externalMessageId: "om_message_001",
    });
    expect(messages[0]?.createdAt).toBe(new Date(NOW_MS).toISOString());
    expect(messages[0]?.metadata).toMatchObject({
      chatId: "oc_chat_1",
      chatType: "p2p",
      eventType: "im.message.receive_v1",
      eventId: "evt-001",
    });
    expect(sideEffects()).toBe(1);
  });

  it("maps a group message thread to external_thread_id", async () => {
    const { store, ingestion } = setup({ verify: true });
    const body = fixture("group-message.json");

    await ingestion.handleRequest({ headers: signedHeaders(body), body });

    const conversation = await store.findConversationByExternal({
      channel: "feishu",
      externalChatId: "oc_group_1",
      externalThreadId: "omt_thread_1",
    });
    expect(conversation).toBeDefined();
    const unthreaded = await store.findConversationByExternal({
      channel: "feishu",
      externalChatId: "oc_group_1",
    });
    expect(unthreaded).toBeUndefined();
  });

  it("is idempotent across webhook retries: one message, one side effect", async () => {
    const { store, ingestion, sideEffects } = setup({ verify: true });
    const body = fixture("message.json");

    const first = await ingestion.handleRequest({ headers: signedHeaders(body), body });
    const retry = await ingestion.handleRequest({ headers: signedHeaders(body), body });

    expect(first.body).toMatchObject({ duplicate: false });
    expect(retry.body).toMatchObject({ duplicate: true });
    expect(sideEffects()).toBe(1);
    await expect(store.listConversations()).resolves.toHaveLength(1);
    const conversation = await store.findConversationByExternal({
      channel: "feishu",
      externalChatId: "oc_chat_1",
    });
    await expect(store.listMessages(conversation!.id)).resolves.toHaveLength(1);
  });

  it("does not treat the same message id on another channel as a duplicate", async () => {
    const { conversation } = setup();
    const base = {
      externalChatId: "chat-1",
      messageId: "om_message_001",
      senderId: "user-1",
      text: "hi",
      timestamp: new Date(NOW_MS),
    };

    await conversation.handleIncoming({ ...base, channel: "feishu" });
    const other = await conversation.handleIncoming({ ...base, channel: "dingtalk" });

    expect(other.duplicate).toBe(false);
  });

  it("ignores unsupported events and malformed bodies without side effects", async () => {
    const { store, ingestion, sideEffects } = setup({ verify: true });

    const unsupportedBody = fixture("unsupported.json");
    const ignored = await ingestion.handleRequest({
      headers: signedHeaders(unsupportedBody),
      body: unsupportedBody,
    });
    expect(ignored).toMatchObject({ status: 200 });
    expect(ignored.body).toMatchObject({ ignored: true });

    const malformed = await ingestion.handleRequest({ headers: {}, body: "not json" });
    expect(malformed.status).toBe(400);

    expect(sideEffects()).toBe(0);
    await expect(store.listConversations()).resolves.toHaveLength(0);
  });

  it("runs the whole pipeline without credentials in dev/offline mode", async () => {
    const { store, ingestion } = setup();
    const body = fixture("message.json");

    const response = await ingestion.handleRequest({ headers: {}, body });

    expect(response.status).toBe(200);
    await expect(store.listConversations()).resolves.toHaveLength(1);
  });
});
