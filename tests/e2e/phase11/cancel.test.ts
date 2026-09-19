import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Loop } from "../../../src/loop/loop.js";
import { Scheduler } from "../../../src/scheduler/scheduler.js";
import { createPhase11Harness, FailingAgentEngine } from "./harness.js";

describe("Phase 11 E2E — cancellation", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("cancels QUEUED runs synchronously and rejects terminal runs", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);
    await h.seedTask({ status: "READY" });
    await h.runs.createRun({
      id: "run-queued",
      taskId: "task-sample",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const cancelled = await h.dispatchCommand({
      messageId: "msg-cancel-queued",
      command: { type: "run.cancel", payload: { runId: "run-queued" } },
      roles: ["developer"],
    });
    expect(cancelled.status).toBe("succeeded");
    expect((await h.runs.findRun("run-queued")).status).toBe("CANCELLED");

    await h.runs.createRun({
      id: "run-done",
      taskId: "task-sample",
      attempt: 2,
      agent: "codex",
      engine: "codex",
    });
    await h.runs.claimRun("run-done", "w", "2099-01-01T00:00:00.000Z");
    await h.runs.markRunning("run-done");
    await h.runs.completeRun("run-done", { status: "SUCCEEDED" });
    const rejected = await h.dispatchCommand({
      messageId: "msg-cancel-done",
      command: { type: "run.cancel", payload: { runId: "run-done" } },
      roles: ["developer"],
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      error: { code: "run_not_cancellable" },
    });
  });

  it("persists a RUNNING cancel request and a new Loop consumes it", async () => {
    const h = await createPhase11Harness({ engine: new FailingAgentEngine() });
    cleanups.push(h.cleanup);
    await h.seedTask({ status: "RUNNING" });
    const workspaces = await h.workspaceManager.createRunWorkspaces({
      taskId: "task-sample",
      runId: "run-remote",
      targets: [
        { targetId: "task-sample-target-0", repositoryLocalPath: h.fixture.path, position: 0 },
      ],
    });
    await h.executionManager.prepare({
      runId: "run-remote",
      profile: { ...(await h.repositories.findRepository("repo-sample")).executionProfile },
      mounts: [
        {
          targetId: "task-sample-target-0",
          source: workspaces[0]!.path,
          target: "/workspace",
          primary: true,
        },
      ],
      primaryTargetId: "task-sample-target-0",
    });
    await h.runs.createRun({
      id: "run-remote",
      taskId: "task-sample",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await h.runs.claimRun("run-remote", "dead-worker", "2099-01-01T00:00:00.000Z");
    await h.runs.markRunning("run-remote");

    const requested = await h.dispatchCommand({
      messageId: "msg-cancel-running",
      command: { type: "run.cancel", payload: { runId: "run-remote" } },
      roles: ["developer"],
    });
    expect(requested.status).toBe("succeeded");
    expect((await h.runs.findRun("run-remote")).status).toBe("RUNNING");
    expect((await h.runs.findRun("run-remote")).cancelRequestedAt).toBeDefined();

    const loop = new Loop({
      scheduler: new Scheduler({ taskStore: h.tasks, runStore: h.runs }),
      worker: h.worker,
      runStore: h.runs,
      taskStore: h.tasks,
      eventStore: h.events,
      executions: h.executions,
      executionManager: h.executionManager,
      repositories: h.repositories,
      workspaceManager: h.workspaceManager,
      maxConcurrency: 1,
    });
    const report = await loop.tick();

    expect(report.cancelled.map((run) => run.id)).toEqual(["run-remote"]);
    expect((await h.runs.findRun("run-remote")).status).toBe("CANCELLED");
    expect((await h.executions.findLatestByRunId("run-remote"))?.status).toBe("CLEANED");
    for (const workspace of workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
  });
});
