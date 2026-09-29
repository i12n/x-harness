import { describe, expect, it } from "vitest";
import { createChatHistoryPort } from "../src/server/deployment/chatHistoryPort.js";
import { createHistoryCommandHandlers } from "../src/command/handlers/history.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import { COMMAND_SCHEMAS } from "../src/command/schema.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";

async function setup() {
  const store = new InMemoryConversationStore();
  const conversation = await store.ensureConversation({
    channel: "feishu",
    externalChatId: "oc_1",
  });
  await store.attachSubject(conversation.id, { subjectType: "problem", subjectId: "prob-1" });
  for (let index = 0; index < 5; index += 1) {
    await store.appendMessage({
      conversationId: conversation.id,
      channel: "feishu",
      direction: index % 2 === 0 ? "INBOUND" : "OUTBOUND",
      senderId: index % 2 === 0 ? "ou_admin" : "harness",
      messageType: "text",
      content: `message-${index}`,
      externalMessageId: `om_${index}`,
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
    });
  }
  const dispatcher = new CommandDispatcher({
    handlers: createHistoryCommandHandlers({
      history: createChatHistoryPort({ conversations: store }),
    }),
    idempotency: new InMemoryIdempotencyStore(),
  });
  return { store, conversation, dispatcher };
}

async function dispatch(
  dispatcher: CommandDispatcher,
  conversationId: string | undefined,
  payload: Record<string, unknown>,
  roles: ("admin" | "developer")[] = ["admin"],
) {
  return dispatcher.dispatch(
    {
      id: "cmd-1",
      type: "conversation.show",
      version: 1,
      actor: { channel: "feishu", userId: "ou_admin" },
      ...(conversationId ? { conversation: { id: conversationId } } : {}),
      payload,
      idempotencyKey: "feishu:om-x:conversation.show",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    { channel: "feishu", userId: "ou_admin", roles },
  );
}

describe("conversation.show", () => {
  it("is admin-only", () => {
    expect(COMMAND_SCHEMAS["conversation.show"].roles).toEqual(["admin"]);
  });

  it("renders the transcript, newest last, with the subject", async () => {
    const { dispatcher, conversation } = await setup();

    const result = await dispatch(dispatcher, conversation.id, { limit: 3 });

    expect(result.status).toBe("succeeded");
    const data = result.data as { entries: { text: string }[]; omitted: number };
    expect(data.entries.map((entry) => entry.text)).toEqual([
      "message-2",
      "message-3",
      "message-4",
    ]);
    expect(data.omitted).toBe(2);

    const rendered = JSON.stringify((result.data as { message: unknown }).message);
    expect(rendered).toContain("prob-1");
    expect(rendered).toContain("另有 2 条更早的消息未显示");
    expect(rendered).toContain("ai conversation export");
  });

  it("rejects a developer", async () => {
    const { dispatcher, conversation } = await setup();
    const result = await dispatch(dispatcher, conversation.id, {}, ["developer"]);
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("unauthorized");
  });

  it("requires a conversation context", async () => {
    const { dispatcher } = await setup();
    const result = await dispatch(dispatcher, undefined, {});
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("no_conversation");
  });
});
