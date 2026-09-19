import { describe, expect, it } from "vitest";
import { Scheduler } from "../../../src/scheduler/scheduler.js";
import { InMemoryRunStore } from "../../../src/store/inMemoryRunStore.js";
import { createPhase12Harness } from "./harness.js";

/**
 * TASK-1204 acceptance: the Scheduler consumes the dependency graph through
 * TaskDependencyService.listRunnableTasks() and never walks the DAG itself.
 * Planning still produces INBOX tasks; marking them READY is an explicit step.
 */
async function readyTasks(
  h: Awaited<ReturnType<typeof createPhase12Harness>>,
  specificationId: string,
) {
  const planned = await h.planning.plan(specificationId);
  for (const task of planned.tasks) {
    await h.tasks.updateTaskStatus(task.id, "READY");
  }
  return planned.tasks;
}

function schedulerFor(
  h: Awaited<ReturnType<typeof createPhase12Harness>>,
  runs: InMemoryRunStore,
  maxConcurrency = 2,
) {
  return new Scheduler({
    taskStore: h.tasks,
    runStore: runs,
    maxConcurrency,
    runnableTasks: h.dependencyService,
  });
}

/** Simulates worker + review: run terminal, task DONE. */
async function finish(
  h: Awaited<ReturnType<typeof createPhase12Harness>>,
  runs: InMemoryRunStore,
  runId: string,
  taskId: string,
  status: "SUCCEEDED" | "FAILED" = "SUCCEEDED",
) {
  await runs.completeRun(runId, { status, exitCode: status === "SUCCEEDED" ? 0 : 1 });
  if (status === "SUCCEEDED") {
    await h.tasks.updateTaskStatus(taskId, "DONE");
  }
}

describe("Phase 12 E2E — Dependency-aware Scheduler (TASK-1204)", () => {
  it("keeps scheduling dependency-free tasks (regression)", async () => {
    const h = await createPhase12Harness();
    const [taskA] = await readyTasks(
      h,
      (await h.seedReadySpecification({ requirements: ["A: 列表接口"] })).id,
    );
    const runs = new InMemoryRunStore();

    const created = await schedulerFor(h, runs).schedule();

    expect(created.map((run) => run.taskId)).toEqual([taskA!.id]);
    expect(created[0]?.status).toBe("QUEUED");
    // A second tick must not create a second run for the same task.
    await expect(schedulerFor(h, runs).schedule()).resolves.toHaveLength(0);
  });

  it("gates a single dependency and unlocks it when the prerequisite is DONE", async () => {
    const h = await createPhase12Harness();
    const [taskA, taskB] = await readyTasks(
      h,
      (await h.seedReadySpecification({ requirements: ["A: 接口", "B: 页面"] })).id,
    );
    await h.dependencyService.addDependency(taskB!.id, taskA!.id);
    const runs = new InMemoryRunStore();
    const scheduler = schedulerFor(h, runs);

    const first = await scheduler.schedule();
    expect(first.map((run) => run.taskId)).toEqual([taskA!.id]);
    await expect(h.dependencyService.isRunnable(taskB!.id)).resolves.toBe(false);

    await finish(h, runs, first[0]!.id, taskA!.id);
    const second = await scheduler.schedule();
    expect(second.map((run) => run.taskId)).toEqual([taskB!.id]);
  });

  it("waits for every prerequisite and never lets blocked tasks eat capacity", async () => {
    const h = await createPhase12Harness();
    const [taskA, taskB, taskC] = await readyTasks(
      h,
      (
        await h.seedReadySpecification({
          requirements: ["A: 列表接口", "B: 详情接口", "C: 联调页面"],
        })
      ).id,
    );
    await h.dependencyService.addDependency(taskC!.id, taskA!.id);
    await h.dependencyService.addDependency(taskC!.id, taskB!.id);
    const runs = new InMemoryRunStore();
    const scheduler = schedulerFor(h, runs, 2);

    const first = await scheduler.schedule();
    expect(first.map((run) => run.taskId)).toEqual([taskA!.id, taskB!.id]);

    // Only A is DONE → C stays gated even though a slot is free.
    await finish(h, runs, first[0]!.id, taskA!.id);
    await runs.completeRun(first[1]!.id, { status: "SUCCEEDED", exitCode: 0 });
    await h.tasks.updateTaskStatus(taskB!.id, "REVIEW");
    await expect(scheduler.schedule()).resolves.toHaveLength(0);

    // Approval is the completion point: REVIEW → DONE unlocks C.
    await h.tasks.updateTaskStatus(taskB!.id, "DONE");
    const third = await scheduler.schedule();
    expect(third.map((run) => run.taskId)).toEqual([taskC!.id]);
  });

  it("respects max_concurrency with independent tasks", async () => {
    const h = await createPhase12Harness();
    await readyTasks(
      h,
      (await h.seedReadySpecification({ requirements: ["A", "B", "C"] })).id,
    );
    const runs = new InMemoryRunStore();

    const created = await schedulerFor(h, runs, 2).schedule();
    expect(created).toHaveLength(2);
    expect(await runs.listRuns({ statuses: ["QUEUED"] })).toHaveLength(2);
  });

  it("gates across specifications and exposes the blocked state", async () => {
    const h = await createPhase12Harness();
    const [taskA1] = await readyTasks(
      h,
      (await h.seedReadySpecification({ requirements: ["A1"] })).id,
    );
    const [taskB1] = await readyTasks(
      h,
      (
        await h.seedReadySpecification({ title: "另一个需求", requirements: ["B1"] })
      ).id,
    );
    await h.dependencyService.addDependency(taskB1!.id, taskA1!.id);
    const runs = new InMemoryRunStore();
    const scheduler = schedulerFor(h, runs, 2);

    const first = await scheduler.schedule();
    expect(first.map((run) => run.taskId)).toEqual([taskA1!.id]);

    const view = await h.dependencyService.describe(taskB1!.id);
    expect(view.prerequisites.map((task) => task.id)).toEqual([taskA1!.id]);
    await expect(h.dependencyService.isRunnable(taskB1!.id)).resolves.toBe(false);

    await finish(h, runs, first[0]!.id, taskA1!.id);
    const second = await scheduler.schedule();
    expect(second.map((run) => run.taskId)).toEqual([taskB1!.id]);
  });

  it("keeps retry semantics: a FAILED prerequisite does not unlock anything", async () => {
    const h = await createPhase12Harness();
    const [taskA, taskB] = await readyTasks(
      h,
      (await h.seedReadySpecification({ requirements: ["A", "B"] })).id,
    );
    await h.dependencyService.addDependency(taskB!.id, taskA!.id);
    const runs = new InMemoryRunStore();
    const scheduler = schedulerFor(h, runs, 2);

    const first = await scheduler.schedule();
    await finish(h, runs, first[0]!.id, taskA!.id, "FAILED");
    await h.tasks.updateTaskStatus(taskA!.id, "READY");

    // A is runnable again (existing retry policy) but B still waits for DONE.
    const rerun = await scheduler.schedule();
    expect(rerun.map((run) => run.taskId)).toEqual([taskA!.id]);
    await expect(h.dependencyService.isRunnable(taskB!.id)).resolves.toBe(false);
  });
});
