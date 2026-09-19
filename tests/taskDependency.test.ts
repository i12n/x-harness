import { describe, expect, it } from "vitest";
import {
  buildTaskDependency,
  createsDependencyCycle,
  isTaskRunnable,
} from "../src/domain/taskDependency.js";
import { ValidationError } from "../src/errors.js";
import { TaskDependencyService } from "../src/task/application/dependencyService.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryTaskDependencyStore } from "../src/store/inMemoryTaskDependencyStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import type { TaskStatus } from "../src/domain/task.js";

describe("Task dependency domain (TASK-1203)", () => {
  it("builds a trimmed edge and rejects self dependencies", () => {
    const dependency = buildTaskDependency({
      taskId: " task-b ",
      dependsOnTaskId: " task-a ",
    });
    expect(dependency).toMatchObject({
      taskId: "task-b",
      dependsOnTaskId: "task-a",
    });
    expect(() =>
      buildTaskDependency({ taskId: "task-a", dependsOnTaskId: "task-a" }),
    ).toThrow(ValidationError);
    expect(() =>
      buildTaskDependency({ taskId: "", dependsOnTaskId: "task-a" }),
    ).toThrow(ValidationError);
  });

  it("detects direct and transitive cycles", () => {
    const chain = [
      { taskId: "task-b", dependsOnTaskId: "task-a" },
      { taskId: "task-c", dependsOnTaskId: "task-b" },
    ];

    expect(createsDependencyCycle(chain, "task-d", "task-c")).toBe(false);
    // a → b, so b → a would close a 2-cycle
    expect(createsDependencyCycle(chain, "task-a", "task-b")).toBe(true);
    // a → b → c, so c → a would close a 3-cycle
    expect(createsDependencyCycle(chain, "task-a", "task-c")).toBe(true);
    expect(createsDependencyCycle(chain, "task-b", "task-c")).toBe(true);
    expect(createsDependencyCycle([], "task-a", "task-b")).toBe(false);
  });

  it("only DONE satisfies a dependency", () => {
    const statuses: TaskStatus[] = [
      "INBOX",
      "READY",
      "RUNNING",
      "VERIFYING",
      "REVIEW",
      "BLOCKED",
      "FAILED",
    ];
    for (const status of statuses) {
      expect(isTaskRunnable({ status: "READY" }, [{ status }])).toBe(false);
    }
    expect(isTaskRunnable({ status: "READY" }, [{ status: "DONE" }])).toBe(true);
    expect(isTaskRunnable({ status: "READY" }, [])).toBe(true);
    expect(
      isTaskRunnable({ status: "REVIEW" }, [{ status: "DONE" }]),
    ).toBe(false);
  });
});

interface Harness {
  tasks: InMemoryTaskStore;
  dependencies: InMemoryTaskDependencyStore;
  events: InMemoryEventStore;
  service: TaskDependencyService;
}

async function harness(): Promise<Harness> {
  const tasks = new InMemoryTaskStore();
  const dependencies = new InMemoryTaskDependencyStore();
  const events = new InMemoryEventStore();
  for (const id of ["task-a", "task-b", "task-c"]) {
    await tasks.createTask({
      id,
      repositoryId: "repo-a",
      title: id,
      status: "READY",
    });
  }
  return {
    tasks,
    dependencies,
    events,
    service: new TaskDependencyService({ tasks, dependencies, events }),
  };
}

describe("TaskDependencyService (TASK-1203)", () => {
  it("adds dependencies and reports whether the edge is new", async () => {
    const h = await harness();

    const first = await h.service.addDependency("task-b", "task-a");
    expect(first.created).toBe(true);
    expect(first.dependency).toMatchObject({
      taskId: "task-b",
      dependsOnTaskId: "task-a",
    });

    const again = await h.service.addDependency("task-b", "task-a");
    expect(again.created).toBe(false);
    await expect(h.dependencies.listAllDependencies()).resolves.toHaveLength(1);

    const events = await h.events.listEvents({ type: "task.dependency.added" });
    expect(events).toHaveLength(1);
    expect(events[0]?.taskId).toBe("task-b");
    expect(events[0]?.payload).toMatchObject({ dependsOnTaskId: "task-a" });
  });

  it("supports multiple prerequisites", async () => {
    const h = await harness();
    await h.service.addDependency("task-c", "task-a");
    await h.service.addDependency("task-c", "task-b");

    const view = await h.service.describe("task-c");
    expect(view.dependencies.map((edge) => edge.dependsOnTaskId)).toEqual([
      "task-a",
      "task-b",
    ]);
    expect(view.prerequisites.map((task) => task.id)).toEqual(["task-a", "task-b"]);

    const dependents = await h.service.listDependents("task-a");
    expect(dependents.map((task) => task.id)).toEqual(["task-c"]);
  });

  it("rejects self dependencies and cycles", async () => {
    const h = await harness();
    await h.service.addDependency("task-b", "task-a");
    await h.service.addDependency("task-c", "task-b");

    await expect(h.service.addDependency("task-a", "task-a")).rejects.toMatchObject({
      code: "task_dependency_self",
    });
    await expect(h.service.addDependency("task-a", "task-c")).rejects.toMatchObject({
      code: "task_dependency_cycle",
    });
    await expect(h.service.addDependency("task-b", "task-c")).rejects.toMatchObject({
      code: "task_dependency_cycle",
    });
    await expect(h.dependencies.listAllDependencies()).resolves.toHaveLength(2);
  });

  it("rejects unknown tasks", async () => {
    const h = await harness();
    await expect(
      h.service.addDependency("task-missing", "task-a"),
    ).rejects.toMatchObject({ code: "task_not_found" });
    await expect(
      h.service.addDependency("task-a", "task-missing"),
    ).rejects.toMatchObject({ code: "task_not_found" });
  });

  it("computes runnable tasks from DONE prerequisites", async () => {
    const h = await harness();
    await h.service.addDependency("task-c", "task-a");
    await h.service.addDependency("task-c", "task-b");

    // A and B are READY, so only they (plus nothing else) can run right now.
    await expect(h.service.isRunnable("task-c")).resolves.toBe(false);
    await expect(h.service.isRunnable("task-a")).resolves.toBe(true);
    expect((await h.service.listRunnableTasks()).map((task) => task.id)).toEqual([
      "task-a",
      "task-b",
    ]);

    await h.tasks.updateTaskStatus("task-a", "DONE");
    await expect(h.service.isRunnable("task-c")).resolves.toBe(false);

    await h.tasks.updateTaskStatus("task-b", "DONE");
    await expect(h.service.isRunnable("task-c")).resolves.toBe(true);
    expect((await h.service.listRunnableTasks()).map((task) => task.id)).toEqual([
      "task-c",
    ]);
  });

  it("keeps a task blocked while a prerequisite is only in REVIEW", async () => {
    const h = await harness();
    await h.service.addDependency("task-c", "task-a");
    await h.tasks.updateTaskStatus("task-a", "REVIEW");

    await expect(h.service.isRunnable("task-c")).resolves.toBe(false);
    const runnable = await h.service.listRunnableTasks();
    expect(runnable.map((task) => task.id)).not.toContain("task-c");
  });

  it("does not change task status while linking", async () => {
    const h = await harness();
    await h.service.addDependency("task-b", "task-a");
    await expect(h.tasks.findTask("task-a")).resolves.toMatchObject({ status: "READY" });
    await expect(h.tasks.findTask("task-b")).resolves.toMatchObject({ status: "READY" });
  });
});
