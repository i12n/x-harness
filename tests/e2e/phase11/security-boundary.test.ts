import { afterEach, describe, expect, it } from "vitest";
import { readTaskReviews } from "../../../src/domain/task.js";
import { createPhase11Harness, needsInputAnalysis } from "./harness.js";

describe("Phase 11 E2E — security boundaries", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("rejects unknown commands, unknown payload fields and dynamic calls", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);

    const unknown = await h.dispatchCommand({
      messageId: "msg-unknown",
      command: { type: "docker.exec", payload: { cmd: "rm -rf /" } },
      roles: ["admin"],
    });
    expect(unknown).toMatchObject({
      status: "rejected",
      error: { code: "unsupported_command" },
    });

    const unknownField = await h.dispatchCommand({
      messageId: "msg-field",
      command: {
        type: "task.show",
        payload: { taskId: "task-sample", method: "dropDatabase" },
      },
      roles: ["admin"],
    });
    expect(unknownField).toMatchObject({
      status: "rejected",
      error: { code: "unknown_field" },
    });
  });

  it("does not let the intent engine spoof actor or bypass authorization", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);
    await h.seedTask({ status: "READY" });
    await h.dispatchCommand({
      messageId: "msg-run",
      command: { type: "task.run", payload: { taskId: "task-sample" } },
      roles: ["developer"],
    });

    const denied = await h.dispatchCommand({
      messageId: "msg-guest-approve",
      command: { type: "review.approve", payload: { taskId: "task-sample" } },
      roles: ["guest"],
    });
    expect(denied).toMatchObject({
      status: "rejected",
      error: { code: "unauthorized" },
    });

    const spoofed = await h.dispatchCommand({
      messageId: "msg-spoofed-approve",
      senderId: "reviewer-1",
      command: {
        type: "review.approve",
        payload: { taskId: "task-sample" },
        actor: { channel: "slack", userId: "spoofed" },
      },
      roles: ["reviewer"],
    });
    expect(spoofed.status).toBe("succeeded");
    const task = await h.tasks.findTask("task-sample");
    const texts = readTaskReviews(task).map((review) => review.text).join("\n");
    expect(texts).toContain("cli:reviewer-1");
    expect(texts).not.toContain("spoofed");
  });

  it("runs one side effect per duplicated message", async () => {
    const h = await createPhase11Harness({ analyses: [needsInputAnalysis()] });
    cleanups.push(h.cleanup);
    const command = {
      type: "problem.create",
      payload: { title: "Add greet", statement: "Add greet(name)." },
    };

    const first = await h.dispatchCommand({ messageId: "msg-dup", command, roles: ["guest"] });
    const retry = await h.dispatchCommand({ messageId: "msg-dup", command, roles: ["guest"] });

    expect(first.status).toBe("succeeded");
    expect(retry.replayed).toBe(true);
    await expect(h.problemStore.listProblems()).resolves.toHaveLength(1);
  });

  it("produces the same application result from CLI and Feishu entries", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);
    await h.seedTask({ status: "READY" });
    const command = { type: "task.show", payload: { taskId: "task-sample" } };

    const cli = await h.dispatchCommand({
      messageId: "msg-cli",
      channel: "cli",
      command,
      roles: ["guest"],
    });
    const feishu = await h.dispatchFeishuEvent({
      messageId: "om_e2e_cli_parity",
      eventId: "evt-e2e-parity",
      command,
      roles: ["guest"],
    });

    expect(cli.status).toBe("succeeded");
    expect(feishu.status).toBe(200);
    expect(feishu.body).toMatchObject({ duplicate: false });

    const conversation = await h.conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "oc_chat_1",
    });
    await expect(
      h.conversationStore.listMessages(conversation.id),
    ).resolves.toHaveLength(1);
    expect((cli.data as { task: { id: string } }).task.id).toBe("task-sample");
  });
});
