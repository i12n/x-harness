import { describe, expect, it } from "vitest";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createTaskListCommandHandlers } from "../src/command/handlers/taskList.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import { COMMAND_SCHEMAS } from "../src/command/schema.js";
import { createTaskQueryPort } from "../src/server/deployment/taskQueryPort.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

async function setup() {
  const repositories = new InMemoryRepositoryStore();
  const tasks = new InMemoryTaskStore();
  await repositories.createRepository({
    id: "repo-demo",
    name: "demo-app",
    url: "git@github.com:example/demo.git",
    localPath: "/srv/repos/demo",
  });
  await tasks.createTask({ id: "task-1", repositoryId: "repo-demo", title: "Add greet", status: "REVIEW" });
  await tasks.createTask({ id: "task-2", repositoryId: "repo-demo", title: "Fix empty state", status: "READY" });
  await tasks.createTask({ id: "task-3", repositoryId: "repo-demo", title: "Ship it", status: "DONE" });

  const dispatcher = new CommandDispatcher({
    handlers: createTaskListCommandHandlers({
      tasks: createTaskQueryPort({ tasks, repositories }),
    }),
    idempotency: new InMemoryIdempotencyStore(),
  });
  return { dispatcher };
}

async function dispatch(dispatcher: CommandDispatcher, payload: Record<string, unknown>) {
  return dispatcher.dispatch(
    {
      id: "cmd-1",
      type: "task.list",
      version: 1,
      actor: { channel: "feishu", userId: "ou_admin" },
      payload,
      idempotencyKey: "feishu:om-x:task.list",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    { channel: "feishu", userId: "ou_admin", roles: ["guest"] },
  );
}

describe("task.list", () => {
  it("is readable by every role", () => {
    expect(COMMAND_SCHEMAS["task.list"].roles).toContain("guest");
  });

  it("lists tasks grouped by status with the repository name", async () => {
    const { dispatcher } = await setup();

    const result = await dispatch(dispatcher, {});

    expect(result.status).toBe("succeeded");
    const data = result.data as { tasks: { id: string }[]; message: unknown };
    expect(data.tasks).toHaveLength(3);
    const rendered = JSON.stringify(data.message);
    expect(rendered).toContain("待评审（1）");
    expect(rendered).toContain("task-1");
    expect(rendered).toContain("demo-app");
    // Running/verifying work sorts above finished work.
    expect(rendered.indexOf("待评审（1）")).toBeLessThan(rendered.indexOf("已完成（1）"));
  });

  it("filters by status, case-insensitively", async () => {
    const { dispatcher } = await setup();
    const result = await dispatch(dispatcher, { status: "review" });
    const data = result.data as { tasks: { id: string }[] };
    expect(data.tasks.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("accepts the English synonyms a model produces", async () => {
    const { dispatcher } = await setup();
    const running = await dispatch(dispatcher, { status: "in_progress" });
    // No RUNNING task is seeded, so the synonym must simply not be rejected.
    expect(running.status).toBe("succeeded");
    expect((running.data as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("rejects an unknown status instead of silently returning everything", async () => {
    const { dispatcher } = await setup();
    const result = await dispatch(dispatcher, { status: "PRETEND" });
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("invalid_task_status");
  });

  it("says so when nothing matches", async () => {
    const { dispatcher } = await setup();
    const result = await dispatch(dispatcher, { status: "BLOCKED" });
    const rendered = JSON.stringify((result.data as { message: unknown }).message);
    expect(rendered).toContain("没有符合条件的任务");
  });
});
