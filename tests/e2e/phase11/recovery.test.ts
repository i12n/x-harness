import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Loop } from "../../../src/loop/loop.js";
import { Scheduler } from "../../../src/scheduler/scheduler.js";
import { createPhase11Harness, FailingAgentEngine } from "./harness.js";

describe("Phase 11 E2E — recovery", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("recovers a crashed worker: LOST + execution and workspaces reclaimed", async () => {
    const h = await createPhase11Harness({ engine: new FailingAgentEngine() });
    cleanups.push(h.cleanup);
    await h.seedTask({ status: "RUNNING" });
    const workspaces = await h.workspaceManager.createRunWorkspaces({
      taskId: "task-sample",
      runId: "run-crashed",
      targets: [
        { targetId: "task-sample-target-0", repositoryLocalPath: h.fixture.path, position: 0 },
      ],
    });
    await h.executionManager.prepare({
      runId: "run-crashed",
      profile: (await h.repositories.findRepository("repo-sample")).executionProfile,
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
      id: "run-crashed",
      taskId: "task-sample",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await h.runs.claimRun("run-crashed", "dead-worker", "2000-01-01T00:00:00.000Z");
    await h.runs.markRunning("run-crashed", "2000-01-01T00:00:00.000Z");

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

    expect(report.recovered.map((run) => run.id)).toEqual(["run-crashed"]);
    expect((await h.runs.findRun("run-crashed")).status).toBe("LOST");
    expect((await h.executions.findLatestByRunId("run-crashed"))?.status).toBe(
      "CLEANED",
    );
    for (const workspace of workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    // The immediate retry also failed (failing agent) → task is READY again.
    expect((await h.tasks.findTask("task-sample")).status).toBe("READY");
  });
});
