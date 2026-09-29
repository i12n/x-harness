import { describe, expect, it } from "vitest";
import type { OutgoingMessage } from "../src/channel/message.js";
import { parseFeishuEvent } from "../src/channel/feishu/events.js";
import { FeishuAdapter } from "../src/channel/feishu/adapter.js";
import type {
  BotInfo,
  FeishuClient,
  ReplyMessageRequest,
  SendCardRequest,
  SendMessageRequest,
  SendMessageResult,
} from "../src/channel/feishu/client.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import type { IntentEngine, IntentInput, IntentResult } from "../src/command/types.js";
import { ConversationService } from "../src/conversation/service.js";
import type { ChatTarget } from "../src/server/notifications.js";
import { ChatSession, isBotMentioned } from "../src/server/session.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";

const BOT_OPEN_ID = "ou_bot_0001";

function groupEvent(
  messageId: string,
  text: string,
  mentions: { openId: string; name?: string; key?: string }[],
): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { event_id: `evt-${messageId}`, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_admin" }, sender_type: "user" },
      message: {
        message_id: messageId,
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        create_time: "1758240000000",
        content: JSON.stringify({ text }),
        mentions: mentions.map((mention, index) => ({
          key: mention.key ?? `@_user_${index + 1}`,
          id: { open_id: mention.openId },
          name: mention.name ?? "someone",
        })),
      },
    },
  };
}

class RecordingIntentEngine implements IntentEngine {
  seen: IntentInput[] = [];
  async parse(input: IntentInput): Promise<IntentResult> {
    this.seen.push(input);
    return { command: undefined };
  }
}

function privateEvent(messageId: string): Record<string, unknown> {
  return {
    header: { event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_admin" }, sender_type: "user" },
      message: {
        message_id: messageId,
        chat_id: "oc_p2p",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "你好" }),
      },
    },
  };
}

async function build() {
  const conversations = new ConversationService(new InMemoryConversationStore());
  const intent = new RecordingIntentEngine();
  const sent: OutgoingMessage[] = [];
  const session = new ChatSession({
    conversations,
    intent,
    dispatcher: new CommandDispatcher({
      handlers: {},
      idempotency: new InMemoryIdempotencyStore(),
    }),
    access: { allowedUserIds: ["ou_admin"], roleMap: { ou_admin: "admin" }, defaultRole: "guest" },
    botOpenId: BOT_OPEN_ID,
    send: async (_target: ChatTarget, message) => {
      sent.push(message);
    },
  });
  return { session, intent, sent, conversations };
}

describe("group mention rules", () => {
  it("stays silent when the group message does not mention the bot", async () => {
    const { session, intent, sent, conversations } = await build();

    await session.handleEvent(
      groupEvent("om-1", "大家看下这个", [{ openId: "ou_someone_else" }]),
    );

    expect(sent).toHaveLength(0);
    expect(intent.seen).toHaveLength(0);
    // Nothing was recorded either: the bot did not take part in this exchange.
    const all = await conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "oc_group",
    });
    expect(await conversations.context(all.id)).toHaveLength(0);
  });

  it("answers a message that mentions the bot", async () => {
    const { session, intent, sent } = await build();

    await session.handleEvent(
      groupEvent("om-2", "@_user_1 你好", [{ openId: BOT_OPEN_ID }]),
    );

    expect(sent).toHaveLength(1);
    expect(intent.seen).toHaveLength(1);
    // The mention placeholder is stripped before the command parser sees it.
    expect(intent.seen[0]!.text).toBe("你好");
  });

  it("tells bot mentions apart from mentions of other people", async () => {
    const { session, intent } = await build();

    await session.handleEvent(
      groupEvent("om-3", "@_user_1 帮看下", [
        { openId: "ou_colleague" },
        { openId: BOT_OPEN_ID },
      ]),
    );

    expect(intent.seen).toHaveLength(1);
  });
});

describe("group replies go into a thread", () => {
  it("marks replies to a group mention for threaded delivery", async () => {
    const { session, sent } = await build();

    await session.handleEvent(
      groupEvent("om-4", "@_user_1 你好", [{ openId: BOT_OPEN_ID }]),
    );

    expect(sent[0]!.metadata).toMatchObject({
      replyToMessageId: "om-4",
      replyInThread: true,
    });
  });

  it("threads private chat replies by default", async () => {
    const { session, sent } = await build();
    await session.handleEvent(privateEvent("om-6"));

    expect(sent[0]!.metadata).toMatchObject({
      replyToMessageId: "om-6",
      replyInThread: true,
    });
  });

  it("can be configured to leave private chats in the main flow", async () => {
    const conversations = new ConversationService(new InMemoryConversationStore());
    const sent: OutgoingMessage[] = [];
    const session = new ChatSession({
      conversations,
      intent: new RecordingIntentEngine(),
      dispatcher: new CommandDispatcher({
        handlers: {},
        idempotency: new InMemoryIdempotencyStore(),
      }),
      access: {
        allowedUserIds: ["ou_admin"],
        roleMap: { ou_admin: "admin" },
        defaultRole: "guest",
      },
      botOpenId: BOT_OPEN_ID,
      threadReplies: "group",
      send: async (_target, message) => {
        sent.push(message);
      },
    });

    await session.handleEvent(privateEvent("om-7"));

    expect(sent[0]!.metadata?.replyToMessageId).toBeUndefined();
  });

  it("falls back to a normal send when threaded replies are rejected", async () => {
    const sent: SendMessageRequest[] = [];
    const fallbacks: unknown[] = [];
    const client: FeishuClient = {
      sendMessage: async (request): Promise<SendMessageResult> => {
        sent.push(request);
        return { messageId: "om_sent" };
      },
      sendCard: async (): Promise<SendMessageResult> => ({ messageId: "om_sent" }),
      replyMessage: async () => {
        throw new Error("thread not supported in this chat");
      },
      getBotInfo: async (): Promise<BotInfo> => ({ openId: BOT_OPEN_ID }),
    };
    const adapter = new FeishuAdapter({
      client,
      onThreadFallback: (error) => fallbacks.push(error),
    });

    await adapter.send({
      conversationId: "conv-1",
      text: "收到",
      metadata: { receiveId: "oc_p2p", replyToMessageId: "om-6", replyInThread: true },
    });

    expect(fallbacks).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain("收到");
  });

  it("calls the reply API with reply_in_thread for a group message", async () => {
    const replies: ReplyMessageRequest[] = [];
    const client: FeishuClient = {
      sendMessage: async (_request: SendMessageRequest): Promise<SendMessageResult> => ({
        messageId: "om_sent",
      }),
      sendCard: async (_request: SendCardRequest): Promise<SendMessageResult> => ({
        messageId: "om_sent",
      }),
      replyMessage: async (request): Promise<SendMessageResult> => {
        replies.push(request);
        return { messageId: "om_reply" };
      },
      getBotInfo: async (): Promise<BotInfo> => ({ openId: BOT_OPEN_ID }),
    };
    const adapter = new FeishuAdapter({ client });

    await adapter.send({
      conversationId: "conv-1",
      text: "收到",
      metadata: { receiveId: "oc_group", replyToMessageId: "om-4", replyInThread: true },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      messageId: "om-4",
      replyInThread: true,
      msgType: "text",
    });
  });
});

describe("isBotMentioned", () => {
  it("matches on open_id, and is permissive when the bot id is unknown", () => {
    const mentions = [{ openId: "ou_other" }];
    expect(isBotMentioned(mentions, BOT_OPEN_ID)).toBe(false);
    expect(isBotMentioned([{ openId: BOT_OPEN_ID }], BOT_OPEN_ID)).toBe(true);
    expect(isBotMentioned(mentions, undefined)).toBe(true);
    expect(isBotMentioned([], BOT_OPEN_ID)).toBe(false);
  });
});

describe("thread conversations inherit the chat's subject", () => {
  it("copies the subject onto a new topic conversation", async () => {
    const conversations = new ConversationService(new InMemoryConversationStore());
    const sent: OutgoingMessage[] = [];
    const session = new ChatSession({
      conversations,
      intent: new RecordingIntentEngine(),
      dispatcher: new CommandDispatcher({
        handlers: {},
        idempotency: new InMemoryIdempotencyStore(),
      }),
      access: {
        allowedUserIds: ["ou_admin"],
        roleMap: { ou_admin: "admin" },
        defaultRole: "guest",
      },
      botOpenId: BOT_OPEN_ID,
      send: async (_target, message) => {
        sent.push(message);
      },
    });

    // The chat-level conversation already tracks a problem…
    const parent = await conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "oc_group",
    });
    await conversations.attachSubject(parent.id, { type: "problem", id: "prob-1" });

    // …and a message inside a topic opens a second conversation.
    const envelope = groupEvent("om-thread-1", "@_user_1 确认", [
      { openId: BOT_OPEN_ID },
    ]);
    const message = (envelope.event as { message: Record<string, unknown> }).message;
    message.thread_id = "omt_topic_1";
    await session.handleEvent(envelope);

    const thread = await conversations.findByExternal({
      channel: "feishu",
      externalChatId: "oc_group",
      externalThreadId: "omt_topic_1",
    });
    expect(thread?.subjectType).toBe("problem");
    expect(thread?.subjectId).toBe("prob-1");
  });
});

describe("parseFeishuEvent mentions", () => {
  it("keeps mentions in metadata", () => {
    const parsed = parseFeishuEvent(
      groupEvent("om-6", "@_user_1 hello", [{ openId: BOT_OPEN_ID, name: "AI Coding" }]),
    );
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      return;
    }
    expect(parsed.message.metadata?.mentions).toEqual([
      { key: "@_user_1", openId: BOT_OPEN_ID, name: "AI Coding" },
    ]);
    expect(parsed.message.text).toBe("hello");
  });
});
