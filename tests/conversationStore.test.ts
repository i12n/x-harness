import { describe, expect, it } from "vitest";
import {
  ConversationNotFoundError,
  ValidationError,
} from "../src/errors.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";

const CHANNEL = "feishu";

describe("InMemoryConversationStore (TASK-1102)", () => {
  it("creates a conversation without a subject", async () => {
    const store = new InMemoryConversationStore();
    const conversation = await store.createConversation({
      id: "conv-001",
      channel: CHANNEL,
      externalChatId: "chat-1",
      title: "Rehelu",
    });

    expect(conversation).toMatchObject({
      id: "conv-001",
      channel: CHANNEL,
      externalChatId: "chat-1",
      title: "Rehelu",
      status: "ACTIVE",
    });
    expect(conversation.subjectType).toBeUndefined();
    expect(conversation.subjectId).toBeUndefined();
  });

  it("ensures one conversation per (channel, chat, thread)", async () => {
    const store = new InMemoryConversationStore();
    const first = await store.ensureConversation({
      channel: CHANNEL,
      externalChatId: "chat-1",
    });
    const again = await store.ensureConversation({
      channel: CHANNEL,
      externalChatId: "chat-1",
    });
    const threaded = await store.ensureConversation({
      channel: CHANNEL,
      externalChatId: "chat-1",
      externalThreadId: "thread-9",
    });
    const otherChannel = await store.ensureConversation({
      channel: "dingtalk",
      externalChatId: "chat-1",
    });

    expect(again.id).toBe(first.id);
    expect(threaded.id).not.toBe(first.id);
    expect(otherChannel.id).not.toBe(first.id);
    await expect(
      store.findConversationByExternal({ channel: CHANNEL, externalChatId: "chat-1" }),
    ).resolves.toMatchObject({ id: first.id });
  });

  it("lists and filters conversations", async () => {
    const store = new InMemoryConversationStore();
    await store.createConversation({ id: "conv-1", channel: CHANNEL, externalChatId: "c1" });
    await store.createConversation({ id: "conv-2", channel: "dingtalk", externalChatId: "c2" });
    await store.attachSubject("conv-1", { subjectType: "problem", subjectId: "PROB-1" });

    await expect(store.listConversations({ channel: CHANNEL })).resolves.toHaveLength(1);
    await expect(
      store.listConversations({ subjectType: "problem", subjectId: "PROB-1" }),
    ).resolves.toMatchObject([{ id: "conv-1" }]);
  });

  it("links problem / task / run subjects without owning their lifecycle", async () => {
    const store = new InMemoryConversationStore();
    await store.createConversation({ id: "conv-1", channel: CHANNEL, externalChatId: "c1" });

    for (const type of ["problem", "task", "run"] as const) {
      const updated = await store.attachSubject("conv-1", {
        subjectType: type,
        subjectId: `${type}-1`,
      });
      expect(updated.subjectType).toBe(type);
      expect(updated.subjectId).toBe(`${type}-1`);
      expect(updated.status).toBe("ACTIVE");
    }
  });

  it("records inbound and outbound messages in stable order", async () => {
    const store = new InMemoryConversationStore();
    await store.createConversation({ id: "conv-1", channel: CHANNEL, externalChatId: "c1" });
    await store.appendMessage({
      id: "msg-1",
      conversationId: "conv-1",
      channel: CHANNEL,
      direction: "INBOUND",
      senderId: "user-1",
      content: "hello",
      externalMessageId: "ext-1",
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    await store.appendMessage({
      id: "msg-2",
      conversationId: "conv-1",
      channel: CHANNEL,
      direction: "OUTBOUND",
      senderId: "harness",
      content: "hi",
      metadata: { kind: "ack" },
      createdAt: "2026-09-19T00:00:01.000Z",
    });

    const messages = await store.listMessages("conv-1");
    expect(messages.map((message) => [message.id, message.direction, message.senderId])).toEqual([
      ["msg-1", "INBOUND", "user-1"],
      ["msg-2", "OUTBOUND", "harness"],
    ]);
    expect(messages[1]?.metadata).toEqual({ kind: "ack" });
  });

  it("treats a repeated (channel, externalMessageId) as a duplicate", async () => {
    const store = new InMemoryConversationStore();
    await store.createConversation({ id: "conv-1", channel: CHANNEL, externalChatId: "c1" });
    const first = await store.appendMessage({
      id: "msg-1",
      conversationId: "conv-1",
      channel: CHANNEL,
      direction: "INBOUND",
      senderId: "user-1",
      content: "hello",
      externalMessageId: "ext-1",
    });
    const second = await store.appendMessage({
      id: "msg-2",
      conversationId: "conv-1",
      channel: CHANNEL,
      direction: "INBOUND",
      senderId: "user-1",
      content: "hello again",
      externalMessageId: "ext-1",
    });

    expect(second.id).toBe(first.id);
    await expect(store.listMessages("conv-1")).resolves.toHaveLength(1);
    await expect(store.findMessageByExternal(CHANNEL, "ext-1")).resolves.toMatchObject({
      id: "msg-1",
    });
    // The same id on another channel is a different message.
    const otherChannel = await store.appendMessage({
      conversationId: "conv-1",
      channel: "dingtalk",
      direction: "INBOUND",
      senderId: "user-1",
      content: "hello",
      externalMessageId: "ext-1",
    });
    expect(otherChannel.id).not.toBe(first.id);
  });

  it("supports context windows: recent N, before and after", async () => {
    const store = new InMemoryConversationStore();
    await store.createConversation({ id: "conv-1", channel: CHANNEL, externalChatId: "c1" });
    for (let index = 1; index <= 5; index += 1) {
      await store.appendMessage({
        id: `msg-${index}`,
        conversationId: "conv-1",
        channel: CHANNEL,
        direction: "INBOUND",
        senderId: "user-1",
        content: `m${index}`,
        createdAt: `2026-09-19T00:00:0${index}.000Z`,
      });
    }

    const recent = await store.listMessages("conv-1", { limit: 2 });
    expect(recent.map((message) => message.id)).toEqual(["msg-4", "msg-5"]);

    const before = await store.listMessages("conv-1", {
      before: "2026-09-19T00:00:04.000Z",
    });
    expect(before.map((message) => message.id)).toEqual(["msg-1", "msg-2", "msg-3"]);

    const after = await store.listMessages("conv-1", {
      after: "2026-09-19T00:00:03.000Z",
    });
    expect(after.map((message) => message.id)).toEqual(["msg-4", "msg-5"]);
  });

  it("rejects invalid input and missing conversations", async () => {
    const store = new InMemoryConversationStore();
    await expect(
      store.createConversation({ channel: "", externalChatId: "c1" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.createConversation({ channel: CHANNEL, externalChatId: " " }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(store.findConversation("conv-missing")).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );

    await store.createConversation({ id: "conv-1", channel: CHANNEL, externalChatId: "c1" });
    await expect(
      store.appendMessage({
        conversationId: "conv-1",
        channel: CHANNEL,
        direction: "SIDEWAYS" as never,
        senderId: "user-1",
        content: "x",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.appendMessage({
        conversationId: "conv-1",
        channel: CHANNEL,
        direction: "INBOUND",
        senderId: "  ",
        content: "x",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
