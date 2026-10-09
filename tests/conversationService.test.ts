import { describe, expect, it } from "vitest";
import { ConversationService } from "../src/conversation/service.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";

function incoming(overrides: Record<string, unknown> = {}) {
  return {
    channel: "feishu",
    externalChatId: "chat-1",
    messageId: "message-001",
    senderId: "user-1",
    text: "Rehelu 首页太空了",
    timestamp: new Date("2026-09-19T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ConversationService (TASK-1102)", () => {
  // TASK-1243: the first message anchors the requirement's topic, so every
  // later reply for it can be placed in the same thread.
  it("anchors the topic on the first inbound message and keeps it", async () => {
    const store = new InMemoryConversationStore();
    const service = new ConversationService(store);

    const first = await service.handleIncoming(incoming());
    expect(first.conversation.anchorMessageId).toBe("message-001");

    const second = await service.handleIncoming(
      incoming({ messageId: "message-002", text: "继续" }),
    );
    expect(second.conversation.anchorMessageId).toBe("message-001");
  });

  it("moves the anchor when a new requirement starts in the same chat", async () => {
    const store = new InMemoryConversationStore();
    const service = new ConversationService(store);
    const first = await service.handleIncoming(incoming());

    const moved = await service.setAnchor(first.conversation.id, "message-009");

    expect(moved.anchorMessageId).toBe("message-009");
  });

  it("records the first inbound message and reports no duplicate", async () => {
    const store = new InMemoryConversationStore();
    const service = new ConversationService(store);

    const outcome = await service.handleIncoming(incoming());

    expect(outcome.duplicate).toBe(false);
    expect(outcome.conversation).toMatchObject({ channel: "feishu", externalChatId: "chat-1" });
    expect(outcome.message).toMatchObject({
      direction: "INBOUND",
      senderId: "user-1",
      content: "Rehelu 首页太空了",
      externalMessageId: "message-001",
    });
  });

  it("treats a retried webhook as duplicate: no second message, no second conversation", async () => {
    const store = new InMemoryConversationStore();
    const service = new ConversationService(store);
    let sideEffects = 0;

    const first = await service.handleIncoming(incoming());
    if (!first.duplicate) {
      sideEffects += 1;
    }
    const retry = await service.handleIncoming(incoming());
    if (!retry.duplicate) {
      sideEffects += 1;
    }

    expect(retry.duplicate).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.conversation.id).toBe(first.conversation.id);
    expect(sideEffects).toBe(1);
    await expect(store.listConversations()).resolves.toHaveLength(1);
    await expect(store.listMessages(first.conversation.id)).resolves.toHaveLength(1);
  });

  it("does not confuse the same message id on another channel", async () => {
    const store = new InMemoryConversationStore();
    const service = new ConversationService(store);

    const feishu = await service.handleIncoming(incoming());
    const dingtalk = await service.handleIncoming(
      incoming({ channel: "dingtalk", senderId: "user-2" }),
    );

    expect(dingtalk.duplicate).toBe(false);
    expect(dingtalk.message.id).not.toBe(feishu.message.id);
    await expect(store.listConversations()).resolves.toHaveLength(2);
  });

  it("returns a bounded context window in chronological order", async () => {
    const store = new InMemoryConversationStore();
    const service = new ConversationService(store);
    for (let index = 1; index <= 4; index += 1) {
      await service.handleIncoming(
        incoming({
          messageId: `message-00${index}`,
          text: `m${index}`,
          timestamp: new Date(`2026-09-19T00:00:0${index}.000Z`),
        }),
      );
    }

    const conversation = await store.findConversationByExternal({
      channel: "feishu",
      externalChatId: "chat-1",
    });
    const recent = await service.context(conversation!.id, { limit: 2 });

    expect(recent.map((message) => message.content)).toEqual(["m3", "m4"]);
  });

  it("records outgoing replies and links a subject", async () => {
    const store = new InMemoryConversationStore();
    const service = new ConversationService(store);
    const { conversation } = await service.handleIncoming(incoming());

    await service.recordOutgoing(conversation.id, { text: "已创建 PROB-018" });
    const linked = await service.attachSubject(conversation.id, {
      type: "problem",
      id: "PROB-018",
    });

    expect(linked.subjectType).toBe("problem");
    expect(linked.subjectId).toBe("PROB-018");
    const messages = await store.listMessages(conversation.id);
    expect(messages.map((message) => message.direction)).toEqual([
      "INBOUND",
      "OUTBOUND",
    ]);
    expect(messages[1]?.senderId).toBe("harness");
  });

  it("keeps a conversation usable with no subject at all", async () => {
    const store = new InMemoryConversationStore();
    const service = new ConversationService(store);
    const conversation = await service.getOrCreate({
      channel: "feishu",
      externalChatId: "chat-2",
    });

    const again = await service.getOrCreate({
      channel: "feishu",
      externalChatId: "chat-2",
    });

    expect(again.id).toBe(conversation.id);
    expect(conversation.subjectType).toBeUndefined();
    expect(await service.context(conversation.id)).toEqual([]);
  });
});
