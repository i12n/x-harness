import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

describe("Scheduler", () => {
  it("creates runs for READY tasks up to max_concurrency", async () => {
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    for (const id of ["task-001", "task-002", "task-003"]) {
      await tasks.createTask({
        id,
        repositoryId: "repo-001",
        title: id,
        description: "d",
        acceptance: ["a"],
        status: "READY",
        priority: 50,
      });
    }

    const scheduler = new Scheduler({ taskStore: tasks, runStore: runs, maxConcurrency: 2 });
    const created = await scheduler.schedule();

    expect(created).toHaveLength(2);
    expect(created.map((run) => run.status)).toEqual(["QUEUED", "QUEUED"]);
    expect(created.map((run) => run.attempt)).toEqual([1, 1]);
    // The second pass must not double-schedule tasks with active runs.
    await expect(scheduler.schedule()).resolves.toHaveLength(0);
  });

  it("schedules higher priority tasks first", async () => {
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    await tasks.createTask({
      id: "task-low",
      repositoryId: "repo-001",
      title: "low",
      status: "READY",
      priority: 10,
    });
    await tasks.createTask({
      id: "task-high",
      repositoryId: "repo-001",
      title: "high",
      status: "READY",
      priority: 90,
    });

    const scheduler = new Scheduler({ taskStore: tasks, runStore: runs, maxConcurrency: 1 });
    const created = await scheduler.schedule();
    expect(created.map((run) => run.taskId)).toEqual(["task-high"]);
  });

  it("numbers attempts after existing runs", async () => {
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "t",
      status: "READY",
    });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "a",
      engine: "e",
      status: "FAILED",
    });

    const scheduler = new Scheduler({ taskStore: tasks, runStore: runs, maxConcurrency: 2 });
    const created = await scheduler.schedule();
    expect(created[0]?.attempt).toBe(2);
  });
});
