import { describe, expect, it } from "vitest";
import {
  exportConversationCommand,
  listConversationsCommand,
  pruneConversationsCommand,
  showConversationCommand,
} from "../src/cli/commands/conversationCommands.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";

async function seed() {
  const store = new InMemoryConversationStore();
  const first = await store.ensureConversation({
    channel: "feishu",
    externalChatId: "oc_1",
  });
  await store.appendMessage({
    conversationId: first.id,
    channel: "feishu",
    direction: "INBOUND",
    senderId: "ou_admin",
    messageType: "text",
    content: "首页太空了",
    externalMessageId: "om_1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await store.appendMessage({
    conversationId: first.id,
    channel: "feishu",
    direction: "OUTBOUND",
    senderId: "harness",
    messageType: "text",
    content: "prob-1 已创建",
    createdAt: "2026-01-01T00:00:05.000Z",
  });
  await store.attachSubject(first.id, { subjectType: "problem", subjectId: "prob-1" });

  const second = await store.ensureConversation({
    channel: "feishu",
    externalChatId: "oc_2",
  });
  await store.appendMessage({
    conversationId: second.id,
    channel: "feishu",
    direction: "INBOUND",
    senderId: "ou_other",
    messageType: "text",
    content: "你好",
    externalMessageId: "om_2",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  return { store, first };
}

describe("conversation commands", () => {
  it("lists conversations, newest activity first, with counts", async () => {
    const { store } = await seed();

    const summaries = await listConversationsCommand(store);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.conversation.externalChatId).toBe("oc_2");
    expect(summaries[1]!.messageCount).toBe(2);
    expect(summaries[1]!.lastMessageAt).toBe("2026-01-01T00:00:05.000Z");
  });

  it("filters by channel and limit", async () => {
    const { store } = await seed();
    expect(await listConversationsCommand(store, { channel: "cli" })).toEqual([]);
    expect(await listConversationsCommand(store, { limit: 1 })).toHaveLength(1);
  });

  it("shows a transcript, and can limit to the most recent messages", async () => {
    const { store, first } = await seed();

    const full = await showConversationCommand(store, first.id);
    expect(full.messages.map((message) => message.content)).toEqual([
      "首页太空了",
      "prob-1 已创建",
    ]);

    const limited = await showConversationCommand(store, first.id, { limit: 1 });
    expect(limited.messages.map((message) => message.content)).toEqual(["prob-1 已创建"]);
  });

  it("accepts the platform chat id as well as the internal id", async () => {
    const { store } = await seed();
    const byChat = await showConversationCommand(store, "oc_2");
    expect(byChat.conversation.externalChatId).toBe("oc_2");
    expect(byChat.messages[0]!.content).toBe("你好");
  });

  it("exports a markdown transcript with the subject and both directions", async () => {
    const { store, first } = await seed();

    const markdown = await exportConversationCommand(store, first.id);

    expect(markdown).toContain(`# Conversation ${first.id}`);
    expect(markdown).toContain("- channel: feishu");
    expect(markdown).toContain("- subject: problem prob-1");
    expect(markdown).toContain("## 2026-01-01T00:00:00.000Z · user ou_admin");
    expect(markdown).toContain("首页太空了");
    expect(markdown).toContain("## 2026-01-01T00:00:05.000Z · harness");
    expect(markdown).toContain("prob-1 已创建");
  });
});

describe("conversation retention", () => {
  it("is a dry run by default and reports what would go", async () => {
    const { store, first } = await seed();

    const result = await pruneConversationsCommand(store, {
      keepDays: 1,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });

    expect(result.deleted).toBe(2);
    expect(result.executed).toBe(false);
    // Nothing was removed.
    expect((await showConversationCommand(store, first.id)).messages).toHaveLength(2);
  });

  it("deletes only what is older than the window when executed", async () => {
    const { store, first } = await seed();

    const result = await pruneConversationsCommand(store, {
      keepDays: 1,
      execute: true,
      now: () => new Date("2026-01-02T12:00:00.000Z"),
    });

    // Only the first conversation's messages predate the cutoff.
    expect(result.deleted).toBe(2);
    expect((await showConversationCommand(store, first.id)).messages).toHaveLength(0);
    const summaries = await listConversationsCommand(store);
    const survivor = summaries.find((item) => item.conversation.externalChatId === "oc_2");
    expect(survivor?.messageCount).toBe(1);
  });

  it("rejects a non-positive window", async () => {
    const { store } = await seed();
    await expect(
      pruneConversationsCommand(store, { keepDays: 0 }),
    ).rejects.toThrowError(/keep-days/);
  });
});
