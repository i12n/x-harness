import { describe, expect, it } from "vitest";
import { RepositoryNotFoundError, ValidationError } from "../src/errors.js";
import {
  createTaskCommand,
  listTasksCommand,
  resolveTaskTargets,
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
    expect(result.issues).toContain("没有找到仓库：repo-missing");
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

  describe("multi-repository targets (TASK-1011)", () => {
    it("maps repeated --repo flags: first primary, rest supporting", async () => {
      const { repositories } = await setup();
      await repositories.createRepository({
        id: "repo-002",
        name: "auth",
        url: "https://github.com/example/auth.git",
        defaultBranch: "develop",
      });

      const targets = await resolveTaskTargets(repositories, ["repo-001", "repo-002"]);

      expect(targets).toEqual([
        {
          repositoryId: "repo-001",
          role: "primary",
          position: 0,
          baseRef: "main",
          required: true,
        },
        {
          repositoryId: "repo-002",
          role: "supporting",
          position: 1,
          baseRef: "develop",
          required: true,
        },
      ]);
    });

    it("binds --base-ref per repository and defaults to the repository branch", async () => {
      const { repositories } = await setup();
      await repositories.createRepository({
        id: "repo-002",
        name: "auth",
        url: "https://github.com/example/auth.git",
        defaultBranch: "develop",
      });

      const targets = await resolveTaskTargets(
        repositories,
        ["repo-001", "repo-002"],
        { "repo-002": "release/2.1" },
      );

      expect(targets[0]?.baseRef).toBe("main");
      expect(targets[1]?.baseRef).toBe("release/2.1");
    });

    it("rejects base-ref entries for repositories that were not passed", async () => {
      const { repositories } = await setup();
      await expect(
        resolveTaskTargets(repositories, ["repo-001"], { "repo-999": "main" }),
      ).rejects.toThrow(/not passed via --repo/);
    });

    it("rejects duplicate repositories through the domain", async () => {
      const { repositories, tasks } = await setup();
      await expect(
        createTaskCommand(tasks, repositories, {
          repos: ["repo-001", "repo-001"],
          title: "duplicate repo",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("creates a multi-target task from CLI options", async () => {
      const { repositories, tasks } = await setup();
      await repositories.createRepository({
        id: "repo-002",
        name: "auth",
        url: "https://github.com/example/auth.git",
        defaultBranch: "develop",
      });

      const task = await createTaskCommand(tasks, repositories, {
        id: "task-multi",
        repos: ["repo-001", "repo-002"],
        baseRefs: { "repo-002": "release/2.1" },
        title: "multi",
      });

      expect(task.repositoryId).toBe("repo-001");
      expect(task.targets.map((target) => target.repositoryId)).toEqual([
        "repo-001",
        "repo-002",
      ]);
      expect(task.targets[1]?.baseRef).toBe("release/2.1");
    });
  });
});
