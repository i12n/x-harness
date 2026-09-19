import { afterEach, describe, expect, it } from "vitest";
import { createPhase11Harness } from "./harness.js";

describe("Phase 11 E2E — conversation ingestion", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("creates a conversation and dedupes re-delivered events", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);
    const body = h.feishuEventBody("om-e2e-001", "evt-e2e-001", "add greet");

    const first = await h.ingestion.handleRequest({ headers: {}, body });
    const retry = await h.ingestion.handleRequest({ headers: {}, body });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ duplicate: false });
    expect(retry.body).toMatchObject({ duplicate: true });

    const conversation = await h.conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "oc_chat_1",
    });
    expect(conversation.id).toBeTruthy();
    expect(conversation.subjectType).toBeUndefined();
    await expect(
      h.conversationStore.listMessages(conversation.id),
    ).resolves.toHaveLength(1);
  });
});
