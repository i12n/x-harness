import { describe, expect, it, vi } from "vitest";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createGitCommandHandlers } from "../src/command/handlers/git.js";
import { createReviewCommandHandlers } from "../src/command/handlers/review.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import { COMMAND_SCHEMAS } from "../src/command/schema.js";
import type { CommandResult, Role } from "../src/command/types.js";
import { ReviewService } from "../src/review/application/reviewService.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import type { PublishView } from "../src/channel/rendering/review.js";

const PUSHED: PublishView = {
  repositoryId: "repo-1",
  branch: "ai/task-1-run-1",
  remote: "origin",
  committed: true,
  pushed: true,
  filesChanged: 2,
  message: "已推送 origin/ai/task-1-run-1",
};

async function setup(publish?: () => Promise<PublishView[]>) {
  const tasks = new InMemoryTaskStore();
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  await tasks.createTask({
    id: "task-1",
    repositoryId: "repo-1",
    title: "Implement",
    status: "REVIEW",
  });
  const reviews = new ReviewService({ tasks, runs, events });
  const dispatcher = new CommandDispatcher({
    handlers: {
      ...createReviewCommandHandlers({ reviews, publish }),
      ...createGitCommandHandlers({ publish: publish ?? (async () => []) }),
    },
    idempotency: new InMemoryIdempotencyStore(),
  });
  return { dispatcher, tasks };
}

async function dispatch(
  dispatcher: CommandDispatcher,
  type: string,
  payload: Record<string, unknown>,
  roles: Role[] = ["reviewer"],
) {
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

const publishOf = (result: CommandResult): PublishView[] => {
  const data = result.data as { publish?: PublishView[]; outcomes?: PublishView[] } | undefined;
  return data?.publish ?? data?.outcomes ?? [];
};

describe("approval publishes the branch", () => {
  it("publishes after a successful approval", async () => {
    const publish = vi.fn(async () => [PUSHED]);
    const { dispatcher, tasks } = await setup(publish);

    const result = await dispatch(dispatcher, "review.approve", { taskId: "task-1" });

    expect(result.status).toBe("succeeded");
    expect(publish).toHaveBeenCalledWith("task-1");
    expect(publishOf(result)[0]!.pushed).toBe(true);
    expect((await tasks.findTask("task-1")).status).toBe("DONE");
  });

  it("still approves when publishing fails, and reports the failure", async () => {
    const { dispatcher, tasks } = await setup(async () => {
      throw new Error("remote rejected");
    });

    const result = await dispatch(dispatcher, "review.approve", { taskId: "task-1" });

    expect(result.status).toBe("succeeded");
    expect((await tasks.findTask("task-1")).status).toBe("DONE");
    expect(publishOf(result)[0]!.skipped).toBe("error");
    expect(publishOf(result)[0]!.message).toContain("remote rejected");
  });

  it("does not publish when the reviewer asks for changes", async () => {
    const publish = vi.fn(async () => [PUSHED]);
    const { dispatcher } = await setup(publish);

    const result = await dispatch(dispatcher, "review.request_changes", {
      taskId: "task-1",
      feedback: "nope",
    });

    expect(result.status).toBe("succeeded");
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("git.publish command", () => {
  it("is reviewer-only and returns the outcomes", async () => {
    expect(COMMAND_SCHEMAS["git.publish"].roles).toEqual(["reviewer", "admin"]);
    const { dispatcher } = await setup(async () => [PUSHED]);

    const allowed = await dispatch(dispatcher, "git.publish", { taskId: "task-1" });
    expect(allowed.status).toBe("succeeded");
    expect(publishOf(allowed)[0]!.branch).toBe("ai/task-1-run-1");

    const denied = await dispatch(dispatcher, "git.publish", { taskId: "task-1" }, [
      "developer",
    ]);
    expect(denied.status).toBe("rejected");
    expect(denied.error?.code).toBe("unauthorized");
  });
});
