import { describe, expect, it } from "vitest";
import { DuplicateActiveRunError } from "../src/errors.js";
import type { CreateRunInput, Run } from "../src/domain/run.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { TaskDependencyService } from "../src/task/application/dependencyService.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskDependencyStore } from "../src/store/inMemoryTaskDependencyStore.js";
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

describe("Dependency-aware scheduling (TASK-1204)", () => {
  async function setup(maxConcurrency = 2) {
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const dependencies = new InMemoryTaskDependencyStore();
    const dependencyService = new TaskDependencyService({
      tasks,
      dependencies,
      events: new InMemoryEventStore(),
    });
    for (const id of ["task-a", "task-b", "task-c"]) {
      await tasks.createTask({
        id,
        repositoryId: "repo-a",
        title: id,
        status: "READY",
      });
    }
    const scheduler = new Scheduler({
      taskStore: tasks,
      runStore: runs,
      maxConcurrency,
      runnableTasks: dependencyService,
    });
    return { tasks, runs, dependencies, dependencyService, scheduler };
  }

  it("schedules tasks without dependencies (regression)", async () => {
    const { scheduler } = await setup();
    const created = await scheduler.schedule();
    expect(created.map((run) => run.taskId)).toEqual(["task-a", "task-b"]);
  });

  it("gates a task behind its prerequisite", async () => {
    const { tasks, runs, dependencyService, scheduler } = await setup(1);
    await dependencyService.addDependency("task-b", "task-a");

    const first = await scheduler.schedule();
    expect(first.map((run) => run.taskId)).toEqual(["task-a"]);

    // A DONE (worker finished + approved) → the next tick selects B.
    await runs.completeRun(first[0]!.id, { status: "SUCCEEDED", exitCode: 0 });
    await tasks.updateTaskStatus("task-a", "DONE");
    const second = await scheduler.schedule();
    expect(second.map((run) => run.taskId)).toEqual(["task-b"]);
  });

  it("waits for every prerequisite of a multi-dependency task", async () => {
    const { tasks, runs, dependencyService, scheduler } = await setup(2);
    await dependencyService.addDependency("task-c", "task-a");
    await dependencyService.addDependency("task-c", "task-b");

    const first = await scheduler.schedule();
    expect(first.map((run) => run.taskId)).toEqual(["task-a", "task-b"]);

    // Both runs finish, but only A reaches DONE → C stays gated.
    for (const run of first) {
      await runs.completeRun(run.id, { status: "SUCCEEDED", exitCode: 0 });
    }
    await tasks.updateTaskStatus("task-a", "DONE");
    await tasks.updateTaskStatus("task-b", "REVIEW");
    await expect(scheduler.schedule()).resolves.toHaveLength(0);

    // REVIEW is not DONE; approval is the completion point.
    await tasks.updateTaskStatus("task-b", "DONE");
    const third = await scheduler.schedule();
    expect(third.map((run) => run.taskId)).toEqual(["task-c"]);
  });

  it("does not let a blocked task consume a concurrency slot", async () => {
    const { tasks, dependencyService, scheduler } = await setup(1);
    await tasks.createTask({
      id: "task-blocker",
      repositoryId: "repo-a",
      title: "blocker",
      status: "RUNNING",
    });
    await dependencyService.addDependency("task-a", "task-blocker");

    const created = await scheduler.schedule();
    expect(created.map((run) => run.taskId)).toEqual(["task-b"]);
  });

  it("keeps priority ordering among runnable tasks", async () => {
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const dependencyService = new TaskDependencyService({
      tasks,
      dependencies: new InMemoryTaskDependencyStore(),
    });
    await tasks.createTask({
      id: "task-blocker",
      repositoryId: "repo-a",
      title: "blocker",
      status: "RUNNING",
    });
    await tasks.createTask({
      id: "task-low",
      repositoryId: "repo-a",
      title: "low",
      status: "READY",
      priority: 10,
    });
    await tasks.createTask({
      id: "task-high",
      repositoryId: "repo-a",
      title: "high",
      status: "READY",
      priority: 90,
    });
    await tasks.createTask({
      id: "task-gated",
      repositoryId: "repo-a",
      title: "gated",
      status: "READY",
      priority: 99,
    });
    await dependencyService.addDependency("task-gated", "task-blocker");

    const scheduler = new Scheduler({
      taskStore: tasks,
      runStore: runs,
      maxConcurrency: 1,
      runnableTasks: dependencyService,
    });
    // Highest priority (task-gated) is blocked → the next priority wins.
    const created = await scheduler.schedule();
    expect(created.map((run) => run.taskId)).toEqual(["task-high"]);
  });

  it("tolerates a duplicate active run created by another scheduler", async () => {
    const conflicting: string[] = [];
    class ConflictingRunStore extends InMemoryRunStore {
      override async createRun(input: CreateRunInput): Promise<Run> {
        if (input.taskId === "task-a") {
          conflicting.push(input.taskId);
          throw new DuplicateActiveRunError(input.taskId);
        }
        return super.createRun(input);
      }
    }
    const tasks = new InMemoryTaskStore();
    const runs = new ConflictingRunStore();
    const dependencyService = new TaskDependencyService({
      tasks,
      dependencies: new InMemoryTaskDependencyStore(),
    });
    for (const id of ["task-a", "task-b"]) {
      await tasks.createTask({
        id,
        repositoryId: "repo-a",
        title: id,
        status: "READY",
      });
    }
    const scheduler = new Scheduler({
      taskStore: tasks,
      runStore: runs,
      maxConcurrency: 2,
      runnableTasks: dependencyService,
    });

    const created = await scheduler.schedule();
    expect(conflicting).toEqual(["task-a"]);
    expect(created.map((run) => run.taskId)).toEqual(["task-b"]);
    expect(await runs.listRuns({ taskId: "task-a" })).toHaveLength(0);
  });
});
