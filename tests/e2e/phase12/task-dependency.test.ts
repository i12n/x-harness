import { describe, expect, it } from "vitest";
import { createPhase12Harness } from "./harness.js";

describe("Phase 12 E2E — Task Dependency / DAG (TASK-1203)", () => {
  it("gates C behind A and B without executing anything", async () => {
    const h = await createPhase12Harness();
    const specification = await h.seedReadySpecification({
      requirements: ["A: 列表接口", "B: 详情接口", "C: 联调页面"],
    });
    const planned = await h.planning.plan(specification.id);
    const [taskA, taskB, taskC] = planned.tasks;
    expect([taskA, taskB, taskC].map((task) => task?.title)).toEqual([
      "A: 列表接口",
      "B: 详情接口",
      "C: 联调页面",
    ]);
    // Planning produces INBOX tasks; an operator (or a later phase) marks them
    // READY before they can be picked up.
    for (const task of planned.tasks) {
      await h.tasks.updateTaskStatus(task.id, "READY");
    }

    // C depends on both A and B (DAG: A → C ← B).
    await h.dependencyService.addDependency(taskC!.id, taskA!.id);
    await h.dependencyService.addDependency(taskC!.id, taskB!.id);
    expect((await h.dependencyService.describe(taskC!.id)).prerequisites.map((t) => t.id))
      .toEqual([taskA!.id, taskB!.id]);

    // A not DONE → C cannot run.
    await expect(h.dependencyService.isRunnable(taskC!.id)).resolves.toBe(false);
    await h.tasks.updateTaskStatus(taskA!.id, "DONE");
    await expect(h.dependencyService.isRunnable(taskC!.id)).resolves.toBe(false);

    // B only in REVIEW → still blocked (approval is the real completion point).
    await h.tasks.updateTaskStatus(taskB!.id, "REVIEW");
    await expect(h.dependencyService.isRunnable(taskC!.id)).resolves.toBe(false);

    // B DONE → C becomes runnable.
    await h.tasks.updateTaskStatus(taskB!.id, "DONE");
    await expect(h.dependencyService.isRunnable(taskC!.id)).resolves.toBe(true);
    expect((await h.dependencyService.listRunnableTasks()).map((task) => task.id)).toEqual([
      taskC!.id,
    ]);

    // Planning/linking never touched task status and never created a Run.
    await expect(h.tasks.findTask(taskC!.id)).resolves.toMatchObject({ status: "READY" });
    await expect(
      h.events.listEvents({ type: "task.dependency.added" }),
    ).resolves.toHaveLength(2);
  });

  it("rejects cycles across a planned graph and allows cross-specification edges", async () => {
    const h = await createPhase12Harness();
    const first = await h.seedReadySpecification({
      requirements: ["A1", "A2"],
    });
    const firstPlan = await h.planning.plan(first.id);
    const [taskA1, taskA2] = firstPlan.tasks;
    await h.dependencyService.addDependency(taskA2!.id, taskA1!.id);

    // Transitive cycle: A2 → A1 already exists, so A1 → A2 must be refused.
    await expect(
      h.dependencyService.addDependency(taskA1!.id, taskA2!.id),
    ).rejects.toMatchObject({ code: "task_dependency_cycle" });

    // A different Specification may gate on this one (edges live on Task).
    const second = await h.seedReadySpecification({
      title: "另一个需求",
      requirements: ["B1"],
    });
    const secondPlan = await h.planning.plan(second.id);
    const taskB1 = secondPlan.tasks[0]!;
    const linked = await h.dependencyService.addDependency(taskB1.id, taskA1!.id);
    expect(linked.created).toBe(true);
    expect((await h.dependencyService.describe(taskB1.id)).prerequisites).toMatchObject([
      { id: taskA1!.id, title: "A1" },
    ]);

    // Re-adding the same edge is idempotent.
    const again = await h.dependencyService.addDependency(taskB1.id, taskA1!.id);
    expect(again.created).toBe(false);
    await expect(h.dependencies.listAllDependencies()).resolves.toHaveLength(2);
  });
});
