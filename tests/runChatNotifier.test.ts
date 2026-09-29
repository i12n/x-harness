import { describe, expect, it } from "vitest";
import type { OutgoingMessage } from "../src/channel/message.js";
import { RunChatNotifier, type ChatTarget } from "../src/server/notifications.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";

const target: ChatTarget = {
  conversationId: "conv-1",
  receiveId: "oc_chat",
  receiveIdType: "chat_id",
};

async function setup() {
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const sent: { target: ChatTarget; message: OutgoingMessage }[] = [];
  const notifier = new RunChatNotifier({
    runs,
    events,
    send: async (to, message) => {
      sent.push({ target: to, message });
    },
  });
  const run = await runs.createRun({
    id: "run-1",
    taskId: "task-1",
    attempt: 1,
    agent: "codex",
    engine: "codex",
  });
  return { runs, events, sent, notifier, run };
}

describe("RunChatNotifier", () => {
  it("stays silent while the run is active and reports once it finishes", async () => {
    const { runs, sent, notifier } = await setup();
    await notifier.bind("run-1", target);

    expect(await notifier.flush()).toBe(0);

    await runs.completeRun("run-1", { status: "SUCCEEDED", exitCode: 0 });
    expect(await notifier.flush()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target.receiveId).toBe("oc_chat");
    expect(sent[0]!.message.metadata?.receiveId).toBe("oc_chat");
  });

  it("never reports the same terminal run twice", async () => {
    const { runs, sent, notifier } = await setup();
    await notifier.bind("run-1", target);
    await runs.completeRun("run-1", { status: "FAILED", exitCode: 1 });

    await notifier.flush();
    await notifier.flush();

    expect(sent).toHaveLength(1);
  });

  it("retries when the transport fails", async () => {
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    let attempts = 0;
    const notifier = new RunChatNotifier({
      runs,
      events,
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("feishu down");
        }
      },
    });
    const run = await runs.createRun({
      id: "run-1",
      taskId: "task-1",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await notifier.bind(run.id, target);
    await runs.completeRun("run-1", { status: "SUCCEEDED" });

    expect(await notifier.flush()).toBe(0);
    expect(await notifier.flush()).toBe(1);
    expect(attempts).toBe(2);
  });

  it("ignores runs without a chat binding", async () => {
    const { runs, sent, notifier } = await setup();
    await runs.completeRun("run-1", { status: "SUCCEEDED" });

    expect(await notifier.flush()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
