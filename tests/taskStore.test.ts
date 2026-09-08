import { describe, expect, it } from "vitest";
import {
  DuplicateTaskError,
  TaskNotFoundError,
  ValidationError,
} from "../src/errors.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

describe("InMemoryTaskStore", () => {
  it("creates a task with INBOX status and defaults", async () => {
    const store = new InMemoryTaskStore();
    const task = await store.createTask({
      repositoryId: "repo-001",
      title: "Add user avatar",
    });

    expect(task.id).toMatch(/^task-/);
    expect(task.repositoryId).toBe("repo-001");
    expect(task.status).toBe("INBOX");
    expect(task.priority).toBe(50);
    expect(task.maxAttempts).toBe(3);
    expect(task.description).toBe("");
    expect(task.acceptance).toEqual([]);
    expect(task.constraints).toEqual({});
  });

  it("stores description, acceptance, priority and attempts", async () => {
    const store = new InMemoryTaskStore();
    const task = await store.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "Add user avatar",
      description: "Allow users to upload avatars.",
      acceptance: ["JPG supported", "PNG supported", "Maximum 5MB", "Tests pass"],
      priority: 80,
      maxAttempts: 5,
    });

    expect(task.id).toBe("task-001");
    expect(task.description).toBe("Allow users to upload avatars.");
    expect(task.acceptance).toHaveLength(4);
    expect(task.priority).toBe(80);
    expect(task.maxAttempts).toBe(5);
  });

  it("lists tasks with repository and status filters", async () => {
    const store = new InMemoryTaskStore();
    await store.createTask({ id: "task-001", repositoryId: "repo-001", title: "one" });
    await store.createTask({ id: "task-002", repositoryId: "repo-002", title: "two" });
    await store.createTask({
      id: "task-003",
      repositoryId: "repo-001",
      title: "ready one",
      status: "READY",
    });

    await expect(store.listTasks({ repositoryId: "repo-001" })).resolves.toHaveLength(2);
    await expect(store.listTasks({ status: "READY" })).resolves.toHaveLength(1);
    await expect(
      store.listTasks({ repositoryId: "repo-001", status: "READY" }),
    ).resolves.toMatchObject([{ id: "task-003" }]);
  });

  it("finds a task and updates its status", async () => {
    const store = new InMemoryTaskStore();
    await store.createTask({ id: "task-001", repositoryId: "repo-001", title: "one" });

    const updated = await store.updateTaskStatus("task-001", "READY");
    expect(updated.status).toBe("READY");
    expect(updated.updatedAt >= updated.createdAt).toBe(true);
    await expect(store.findTask("task-001")).resolves.toMatchObject({ status: "READY" });
    await expect(store.findTask("task-missing")).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("rejects duplicate ids and invalid inputs", async () => {
    const store = new InMemoryTaskStore();
    await store.createTask({ id: "task-001", repositoryId: "repo-001", title: "one" });

    await expect(
      store.createTask({ id: "task-001", repositoryId: "repo-001", title: "two" }),
    ).rejects.toBeInstanceOf(DuplicateTaskError);
    await expect(
      store.createTask({ repositoryId: "repo-001", title: "  " }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.createTask({ repositoryId: "repo-001", title: "x", status: "NOPE" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
