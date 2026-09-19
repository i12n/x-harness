import { afterEach, describe, expect, it } from "vitest";
import { readTaskReviews } from "../../../src/domain/task.js";
import { createPhase11Harness } from "./harness.js";

describe("Phase 11 E2E — review and approval", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function runToReview(h: Awaited<ReturnType<typeof createPhase11Harness>>) {
    await h.seedTask({ status: "READY" });
    const ran = await h.dispatchCommand({
      messageId: "msg-run",
      command: { type: "task.run", payload: { taskId: "task-sample" } },
      roles: ["developer"],
    });
    expect(ran.status).toBe("succeeded");
    return (ran.data as { runId: string }).runId;
  }

  it("shows review evidence and approves REVIEW → DONE with audit", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);
    await runToReview(h);

    const shown = await h.dispatchCommand({
      messageId: "msg-review-show",
      command: { type: "review.show", payload: { taskId: "task-sample" } },
      roles: ["guest"],
    });
    expect(shown.status).toBe("succeeded");
    const message = (shown.data as { message: { blocks?: unknown[] } }).message;
    expect(JSON.stringify(message.blocks)).toContain("Ready for Review");
    expect(JSON.stringify(message.blocks)).toContain("review.approve");

    const approved = await h.dispatchCommand({
      messageId: "msg-approve",
      senderId: "reviewer-1",
      command: { type: "review.approve", payload: { taskId: "task-sample" } },
      roles: ["reviewer"],
    });
    expect(approved.status).toBe("succeeded");

    const task = await h.tasks.findTask("task-sample");
    expect(task.status).toBe("DONE");
    const reviews = readTaskReviews(task);
    expect(reviews.some((review) => review.text.includes("APPROVED:"))).toBe(true);
    expect(
      reviews.some((review) => review.text.includes("cli:reviewer-1")),
    ).toBe(true);
    await expect(
      h.events.listEvents({ taskId: "task-sample", type: "review.approved" }),
    ).resolves.toHaveLength(1);

    const retry = await h.dispatchCommand({
      messageId: "msg-approve",
      senderId: "reviewer-1",
      command: { type: "review.approve", payload: { taskId: "task-sample" } },
      roles: ["reviewer"],
    });
    expect(retry.replayed).toBe(true);
    expect(readTaskReviews(await h.tasks.findTask("task-sample"))).toHaveLength(
      reviews.length,
    );
  });

  it("rejects a guest approval without touching the task", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);
    await runToReview(h);

    const denied = await h.dispatchCommand({
      messageId: "msg-approve-guest",
      command: { type: "review.approve", payload: { taskId: "task-sample" } },
      roles: ["guest"],
    });

    expect(denied).toMatchObject({ status: "rejected", error: { code: "unauthorized" } });
    expect((await h.tasks.findTask("task-sample")).status).toBe("REVIEW");
  });

  it("request_changes returns the task to READY and the retry uses a new workspace", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);
    const firstRunId = await runToReview(h);
    const firstRun = await h.runs.findRun(firstRunId);
    const firstWorkspace = (firstRun.result as { workspaces: { path: string }[] })
      .workspaces[0]!.path;

    const changes = await h.dispatchCommand({
      messageId: "msg-changes",
      senderId: "reviewer-1",
      command: {
        type: "review.request_changes",
        payload: { taskId: "task-sample", feedback: "please add tests" },
      },
      roles: ["reviewer"],
    });
    expect(changes.status).toBe("succeeded");
    const task = await h.tasks.findTask("task-sample");
    expect(task.status).toBe("READY");
    expect(
      readTaskReviews(task).some((review) =>
        review.text.includes("please add tests"),
      ),
    ).toBe(true);
    await expect(
      h.events.listEvents({ taskId: "task-sample", type: "review.changes_requested" }),
    ).resolves.toHaveLength(1);
    // The review command itself must not create a Run.
    await expect(h.runs.listRuns({ taskId: "task-sample" })).resolves.toHaveLength(1);

    const rerun = await h.dispatchCommand({
      messageId: "msg-rerun",
      command: { type: "task.run", payload: { taskId: "task-sample" } },
      roles: ["developer"],
    });
    const secondRun = await h.runs.findRun((rerun.data as { runId: string }).runId);
    const secondWorkspace = (secondRun.result as { workspaces: { path: string }[] })
      .workspaces[0]!.path;
    expect(secondWorkspace).not.toBe(firstWorkspace);
  });
});
