import { describe, expect, it } from "vitest";
import type { MessageChoice, OutgoingMessage } from "../src/channel/message.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createReviewCommandHandlers } from "../src/command/handlers/review.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import type { CommandResult, Role } from "../src/command/types.js";
import { ReviewService } from "../src/review/application/reviewService.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

async function setup() {
  const tasks = new InMemoryTaskStore();
  for (const id of ["task-1", "task-2"]) {
    await tasks.createTask({
      id,
      repositoryId: "repo-1",
      title: `待评审 ${id}`,
      status: "REVIEW",
    });
  }
  await tasks.createTask({
    id: "task-3",
    repositoryId: "repo-1",
    title: "已经完成",
    status: "DONE",
  });
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const reviews = new ReviewService({ tasks, runs, events });
  const dispatcher = new CommandDispatcher({
    handlers: createReviewCommandHandlers({
      reviews,
      tasks: {
        list: async () =>
          (await tasks.listTasks({ status: "REVIEW" })).map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            repositoryName: "repo-1",
            updatedAt: task.updatedAt,
          })),
      },
    }),
    idempotency: new InMemoryIdempotencyStore(),
  });
  return { dispatcher, tasks };
}

async function dispatch(
  dispatcher: CommandDispatcher,
  type: string,
  payload: Record<string, unknown>,
  roles: Role[] = ["reviewer"],
): Promise<CommandResult> {
  return dispatcher.dispatch(
    {
      id: `cmd-${type}`,
      type,
      version: 1,
      actor: { channel: "feishu", userId: "ou_reviewer" },
      payload,
      idempotencyKey: `feishu:om-${type}:${type}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    { channel: "feishu", userId: "ou_reviewer", roles },
  );
}

const messageOf = (result: CommandResult): OutgoingMessage =>
  (result.data as { message: OutgoingMessage }).message;

const choiceOf = (message: OutgoingMessage): MessageChoice =>
  message.blocks!.find((block): block is MessageChoice => block.type === "choice")!;

describe("batch review (TASK-1216)", () => {
  it("review.list renders one multi-select card for every pending task", async () => {
    const { dispatcher } = await setup();
    const result = await dispatch(dispatcher, "review.list", {});

    expect(result.status).toBe("succeeded");
    const message = messageOf(result);
    const choice = choiceOf(message);
    expect(choice.multi).toBe(true);
    expect(choice.options.map((option) => option.id)).toEqual(["task-1", "task-2"]);
    expect(choice.submit).toMatchObject({
      action: "review.approve_batch",
      selectionField: "taskIds",
    });
  });

  it("approves every ticked task in one command", async () => {
    const { dispatcher, tasks } = await setup();
    const result = await dispatch(dispatcher, "review.approve_batch", {
      taskIds: ["task-1", "task-2"],
    });

    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ approved: ["task-1", "task-2"], failed: [] });
    expect((await tasks.findTask("task-1")).status).toBe("DONE");
    expect((await tasks.findTask("task-2")).status).toBe("DONE");
  });

  it("reports a task that is no longer reviewable instead of aborting the batch", async () => {
    const { dispatcher, tasks } = await setup();
    const result = await dispatch(dispatcher, "review.approve_batch", {
      taskIds: ["task-1", "task-3"],
    });

    expect(result.status).toBe("succeeded");
    const data = result.data as { approved: string[]; failed: { taskId: string }[] };
    expect(data.approved).toEqual(["task-1"]);
    expect(data.failed.map((entry) => entry.taskId)).toEqual(["task-3"]);
    expect((await tasks.findTask("task-1")).status).toBe("DONE");
  });

  it("rejects a batch with no selection", async () => {
    const { dispatcher } = await setup();
    const result = await dispatch(dispatcher, "review.approve_batch", { taskIds: [] });
    expect(result.status).toBe("rejected");
  });

  it("says so when nothing is waiting for review", async () => {
    const { dispatcher, tasks } = await setup();
    // Approve everything, then ask again.
    await dispatch(dispatcher, "review.approve_batch", { taskIds: ["task-1", "task-2"] });
    expect((await tasks.listTasks({ status: "REVIEW" })).length).toBe(0);

    const result = await dispatch(dispatcher, "review.list", {});
    expect(result.status).toBe("succeeded");
    expect(messageOf(result).text).toContain("没有待评审");
  });
});
