import { describe, expect, it } from "vitest";
import { TaskRunService } from "../src/run/application/taskRunService.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import type { Worker } from "../src/worker/worker.js";

describe("TaskRunService enqueue mode", () => {
  it("creates a QUEUED run and never executes it inline", async () => {
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    let executed = 0;
    const worker = {
      executeRun: async () => {
        executed += 1;
        throw new Error("must not run inline");
      },
    } as unknown as Worker;

    await tasks.createTask({
      id: "task-1",
      repositoryId: "repo-1",
      title: "Implement",
      acceptance: [],
      status: "READY",
      maxAttempts: 1,
    });

    const service = new TaskRunService({
      tasks,
      runs,
      repositories: new InMemoryRepositoryStore(),
      worker,
      runMode: "enqueue",
    });

    const outcome = await service.run("task-1");

    expect(outcome.run.status).toBe("QUEUED");
    expect(outcome.outcome).toBeUndefined();
    expect(executed).toBe(0);
    expect(await runs.listRuns({ statuses: ["QUEUED"] })).toHaveLength(1);
  });

  it("keeps executing inline by default (CLI behavior)", async () => {
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    let executed = 0;
    const worker = {
      executeRun: async (runId: string) => {
        executed += 1;
        return {
          run: await runs.findRun(runId),
          task: await tasks.findTask("task-1"),
          agentResult: {},
          verification: {},
          workspace: {},
          workspaces: [],
          targets: [],
        };
      },
    } as unknown as Worker;
    await tasks.createTask({
      id: "task-1",
      repositoryId: "repo-1",
      title: "Implement",
      acceptance: [],
      status: "READY",
      maxAttempts: 1,
    });
    const service = new TaskRunService({
      tasks,
      runs,
      repositories: new InMemoryRepositoryStore(),
      worker,
    });

    const outcome = await service.run("task-1");

    expect(executed).toBe(1);
    expect(outcome.outcome).toBeDefined();
  });
});
