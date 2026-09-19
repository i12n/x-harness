import { describe, expect, it } from "vitest";
import {
  DuplicateTaskDependencyError,
  ValidationError,
} from "../src/errors.js";
import { InMemoryTaskDependencyStore } from "../src/store/inMemoryTaskDependencyStore.js";

describe("InMemoryTaskDependencyStore (TASK-1203)", () => {
  it("stores edges and queries both directions", async () => {
    const store = new InMemoryTaskDependencyStore();
    await store.addDependency({ taskId: "task-c", dependsOnTaskId: "task-a" });
    await store.addDependency({ taskId: "task-c", dependsOnTaskId: "task-b" });
    await store.addDependency({ taskId: "task-d", dependsOnTaskId: "task-a" });

    const prerequisites = await store.listDependencies("task-c");
    expect(prerequisites.map((edge) => edge.dependsOnTaskId)).toEqual([
      "task-a",
      "task-b",
    ]);

    const dependents = await store.listDependents("task-a");
    expect(dependents.map((edge) => edge.taskId)).toEqual(["task-c", "task-d"]);

    await expect(store.listAllDependencies()).resolves.toHaveLength(3);
    await expect(
      store.findDependency("task-c", "task-a"),
    ).resolves.toMatchObject({ taskId: "task-c", dependsOnTaskId: "task-a" });
    await expect(
      store.findDependency("task-a", "task-c"),
    ).resolves.toBeUndefined();
  });

  it("rejects duplicate edges and self dependencies", async () => {
    const store = new InMemoryTaskDependencyStore();
    await store.addDependency({ taskId: "task-b", dependsOnTaskId: "task-a" });

    await expect(
      store.addDependency({ taskId: "task-b", dependsOnTaskId: "task-a" }),
    ).rejects.toBeInstanceOf(DuplicateTaskDependencyError);
    await expect(
      store.addDependency({ taskId: "task-a", dependsOnTaskId: "task-a" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(store.listAllDependencies()).resolves.toHaveLength(1);
  });
});
