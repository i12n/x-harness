import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutgoingMessage } from "../src/channel/message.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createConfigCommandHandlers } from "../src/command/handlers/config.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import type { IntentEngine, IntentInput, IntentResult } from "../src/command/types.js";
import { ConversationService } from "../src/conversation/service.js";
import { createConfigAdminPort } from "../src/server/deployment/configPort.js";
import { parseEnvFile } from "../src/server/deployment/envFile.js";
import {
  ChatSession,
  looksLikeSecretAssignment,
  looksLikeSecretKey,
  parseDirectSet,
} from "../src/server/session.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";

let dir: string;
let envFile: string;

class RecordingIntentEngine implements IntentEngine {
  seen: IntentInput[] = [];
  constructor(private readonly result: IntentResult = { command: undefined }) {}
  async parse(input: IntentInput): Promise<IntentResult> {
    this.seen.push(input);
    return this.result;
  }
}

function event(messageId: string, text: string, openId = "ou_admin"): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { event_id: `evt-${messageId}`, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        message_id: messageId,
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "text",
        create_time: "1758240000000",
        content: JSON.stringify({ text }),
      },
    },
  };
}

async function build(options: { role?: "admin" | "developer" } = {}) {
  const conversations = new ConversationService(new InMemoryConversationStore());
  const events = new InMemoryEventStore();
  const port = createConfigAdminPort({ envFile, env: {}, events });
  const dispatcher = new CommandDispatcher({
    handlers: createConfigCommandHandlers({ config: port }),
    idempotency: new InMemoryIdempotencyStore(),
  });
  const intent = new RecordingIntentEngine();
  const sent: OutgoingMessage[] = [];
  const session = new ChatSession({
    conversations,
    intent,
    dispatcher,
    access: {
      allowedUserIds: ["ou_admin", "ou_dev"],
      roleMap: { ou_admin: options.role ?? "admin" },
      defaultRole: "developer",
    },
    send: async (_target, message) => {
      sent.push(message);
    },
  });
  return { session, intent, sent, conversations };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-chatsecret-"));
  envFile = join(dir, "ai-harness.env");
  writeFileSync(
    envFile,
    [
      "FEISHU_APP_ID=cli_abc",
      "AI_MAX_CONCURRENCY=2",
      "FEISHU_ALLOWED_OPEN_IDS=ou_admin",
    ].join("\n"),
    { mode: 0o600 },
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (message: OutgoingMessage): string =>
  [message.text ?? "", ...(message.blocks ?? []).map((block) => JSON.stringify(block))].join("\n");

describe("structured config parsing", () => {
  it("parses the direct set forms", () => {
    expect(parseDirectSet("设置 FEISHU_APP_SECRET hydU123")).toEqual({
      key: "FEISHU_APP_SECRET",
      value: "hydU123",
    });
    expect(parseDirectSet("设定 AI_MAX_CONCURRENCY=3")).toEqual({
      key: "AI_MAX_CONCURRENCY",
      value: "3",
    });
    expect(parseDirectSet("set deepseek_api_key sk-abc")).toEqual({
      key: "DEEPSEEK_API_KEY",
      value: "sk-abc",
    });
  });

  it("does not fire on ordinary sentences", () => {
    expect(parseDirectSet("帮我加个深色模式开关")).toBeUndefined();
    expect(parseDirectSet("设置提醒")).toBeUndefined();
  });

  it("classifies secret-looking keys and prose", () => {
    expect(looksLikeSecretKey("FEISHU_APP_SECRET")).toBe(true);
    expect(looksLikeSecretKey("DEEPSEEK_API_KEY")).toBe(true);
    expect(looksLikeSecretKey("AI_MAX_CONCURRENCY")).toBe(false);
    expect(looksLikeSecretAssignment("把 App Secret 设成 abc123")).toBe(true);
    expect(looksLikeSecretAssignment("设置 FEISHU_APP_SECRET abc")).toBe(true);
    expect(looksLikeSecretAssignment("加一个 token 刷新功能")).toBe(false);
  });
});

describe("secrets never reach the model or the database", () => {
  it("writes a secret through the deterministic path", async () => {
    const { session, intent, sent, conversations } = await build();

    await session.handleEvent(event("om-1", "设置 FEISHU_APP_SECRET hydU-secret-value"));

    expect(parseEnvFile(readFileSync(envFile, "utf8")).FEISHU_APP_SECRET).toBe(
      "hydU-secret-value",
    );
    expect(intent.seen).toHaveLength(0);
    expect(textOf(sent[0]!)).toContain("已保存 FEISHU_APP_SECRET");
    expect(textOf(sent[0]!)).toContain("值不回显");
    expect(textOf(sent[0]!)).not.toContain("hydU-secret-value");

    const conversation = await conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "oc_chat",
    });
    const messages = await conversations.context(conversation.id);
    const stored = messages.map((message) => message.content).join("\n");
    expect(stored).not.toContain("hydU-secret-value");
    expect(stored).toContain("[已隐去]");
  });

  it("blocks a credential written in prose instead of handing it to the model", async () => {
    const { session, intent, sent, conversations } = await build();

    await session.handleEvent(event("om-2", "把 App Secret 设成 abc123def456"));

    expect(intent.seen).toHaveLength(0);
    expect(parseEnvFile(readFileSync(envFile, "utf8")).FEISHU_APP_SECRET).toBeUndefined();
    expect(textOf(sent[0]!)).toContain("设置 <KEY> <值>");
    const conversation = await conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "oc_chat",
    });
    const stored = (await conversations.context(conversation.id))
      .map((message) => message.content)
      .join("\n");
    expect(stored).not.toContain("abc123def456");
  });

  it("routes non-secret direct sets without the model but keeps them in history", async () => {
    const { session, intent, conversations } = await build();

    await session.handleEvent(event("om-3", "设置 AI_MAX_CONCURRENCY 1"));

    expect(parseEnvFile(readFileSync(envFile, "utf8")).AI_MAX_CONCURRENCY).toBe("1");
    expect(intent.seen).toHaveLength(0);
    const conversation = await conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "oc_chat",
    });
    const stored = (await conversations.context(conversation.id))
      .map((message) => message.content)
      .join("\n");
    expect(stored).toContain("设置 AI_MAX_CONCURRENCY 1");
  });

  it("keeps the model available for ordinary messages", async () => {
    const { session, intent } = await build();

    await session.handleEvent(event("om-4", "帮我加个 token 刷新功能"));

    expect(intent.seen).toHaveLength(1);
  });

  it("refuses secret writes from a non-admin", async () => {
    const { session, intent } = await build({ role: "developer" });

    await session.handleEvent(event("om-5", "设置 FEISHU_APP_SECRET hydU-nope"), "ou_dev");

    expect(intent.seen).toHaveLength(0);
    expect(parseEnvFile(readFileSync(envFile, "utf8")).FEISHU_APP_SECRET).toBeUndefined();
  });
});
