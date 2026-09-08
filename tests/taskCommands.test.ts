import { describe, expect, it } from "vitest";
import { RepositoryNotFoundError } from "../src/errors.js";
import {
  createTaskCommand,
  listTasksCommand,
  showTaskCommand,
  validateTaskCommand,
} from "../src/cli/commands/taskCommands.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";

const VALID_URL = "git@github.com:example/my-app.git";

async function setup() {
  const repositories = new InMemoryRepositoryStore();
  const tasks = new InMemoryTaskStore();
  await repositories.createRepository({ id: "repo-001", name: "my-app", url: VALID_URL });
  return { repositories, tasks };
}

describe("task CLI commands", () => {
  it("create binds a task to an existing repository with INBOX status", async () => {
    const { repositories, tasks } = await setup();
    const task = await createTaskCommand(tasks, repositories, {
      id: "task-001",
      repo: "repo-001",
      title: "Add user avatar",
      description: "Allow users to upload avatars.",
      accept: ["JPG supported", "PNG supported", "Maximum 5MB", "Tests pass"],
    });

    expect(task.repositoryId).toBe("repo-001");
    expect(task.status).toBe("INBOX");
    expect(task.acceptance).toHaveLength(4);
  });

  it("create rejects when the repository is not registered", async () => {
    const { repositories, tasks } = await setup();
    await expect(
      createTaskCommand(tasks, repositories, {
        repo: "repo-missing",
        title: "Add user avatar",
      }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it("validate moves a complete task to READY", async () => {
    const { repositories, tasks } = await setup();
    await createTaskCommand(tasks, repositories, {
      id: "task-001",
      repo: "repo-001",
      title: "Add user avatar",
      description: "Allow users to upload avatars.",
      accept: ["Tests pass"],
    });

    const result = await validateTaskCommand(tasks, repositories, "task-001");
    expect(result.issues).toEqual([]);
    expect(result.task.status).toBe("READY");
  });

  it("validate blocks a task without description or acceptance", async () => {
    const { repositories, tasks } = await setup();
    await createTaskCommand(tasks, repositories, {
      id: "task-001",
      repo: "repo-001",
      title: "Add user avatar",
    });

    const result = await validateTaskCommand(tasks, repositories, "task-001");
    expect(result.task.status).toBe("BLOCKED");
    expect(result.issues).toContain("task has no description");
    expect(result.issues).toContain("task has no acceptance criteria");
  });

  it("validate blocks a task whose repository is missing", async () => {
    const { repositories, tasks } = await setup();
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-missing",
      title: "orphan",
      description: "desc",
      acceptance: ["ok"],
    });

    const result = await validateTaskCommand(tasks, repositories, "task-001");
    expect(result.task.status).toBe("BLOCKED");
    expect(result.issues).toContain("repository not found: repo-missing");
  });

  it("list filters and show return the expected tasks", async () => {
    const { repositories, tasks } = await setup();
    await createTaskCommand(tasks, repositories, { id: "task-001", repo: "repo-001", title: "one" });

    const shown = await showTaskCommand(tasks, "task-001");
    expect(shown.title).toBe("one");
    const list = await listTasksCommand(tasks, { repositoryId: "repo-001" });
    expect(list.map((task) => task.id)).toEqual(["task-001"]);
  });

  it("records TaskCreated and TaskReady events", async () => {
    const { repositories, tasks } = await setup();
    const events = new InMemoryEventStore();
    await createTaskCommand(tasks, repositories, {
      id: "task-001",
      repo: "repo-001",
      title: "Add user avatar",
      description: "Allow users to upload avatars.",
      accept: ["Tests pass"],
    }, events);
    await validateTaskCommand(tasks, repositories, "task-001", events);

    const types = (await events.listEvents({ taskId: "task-001" })).map((e) => e.type);
    expect(types).toEqual(["TaskCreated", "TaskReady"]);
  });
});
