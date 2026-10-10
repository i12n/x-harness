import { describe, expect, it } from "vitest";
import { createRevisionCommandHandlers } from "../src/command/handlers/revision.js";
import { latestDeliveryProduct } from "../src/delivery/application/product.js";
import { DeliveryService } from "../src/delivery/application/service.js";
import { describeRevisionRegression, readRevision } from "../src/domain/revision.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

const ACTOR = { actor: { channel: "feishu", userId: "ou_reviewer" } } as never;

function completedRun(input: {
  id: string;
  taskId: string;
  attempt: number;
  branch: string;
  files: string[];
  finishedAt: string;
}) {
  return {
    id: input.id,
    taskId: input.taskId,
    attempt: input.attempt,
    agent: "codex",
    engine: "codex",
    status: "SUCCEEDED" as const,
    workspace: { path: `/w/${input.id}`, branch: input.branch },
    diff: { files: input.files, stat: "", patch: "" },
    finishedAt: input.finishedAt,
  };
}

/**
 * TASK-1267: an acceptance-stage opinion becomes a revision — one more round of
 * work on top of the delivery, never a "send this task back" decision.
 */
async function harness(options: { released?: boolean; withoutProduct?: boolean } = {}) {
  const tasks = new InMemoryTaskStore();
  const plans = new InMemorySpecificationPlanStore();
  const deliveries = new InMemoryDeliveryStore();
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();

  await tasks.createTask({
    id: "task-spec-1-0",
    repositoryId: "repo-1",
    title: "在歌曲列表添加单曲下载按钮",
    status: "DONE",
  });
  await plans.createPlanItem({
    specificationId: "spec-1",
    position: 0,
    title: "在歌曲列表添加单曲下载按钮",
    taskId: "task-spec-1-0",
  });
  await deliveries.createDelivery({
    id: "dlv-1",
    specificationId: "spec-1",
    status: "READY_FOR_RELEASE",
  });
  if (!options.withoutProduct) {
    const run = completedRun({
      id: "run-1",
      taskId: "task-spec-1-0",
      attempt: 1,
      branch: "ai/task-spec-1-0-run-1",
      files: ["components/download-button.tsx", "lib/download.ts"],
      finishedAt: "2026-10-10T02:00:00.000Z",
    });
    await runs.createRun({
      id: run.id,
      taskId: run.taskId,
      attempt: run.attempt,
      agent: run.agent,
      engine: run.engine,
      status: "SUCCEEDED",
    });
    await runs.completeRun(run.id, {
      status: "SUCCEEDED",
      result: {
        workspace: run.workspace,
        workspaces: [{ targetId: "tgt-1", ...run.workspace }],
        diff: run.diff,
      },
      finishedAt: run.finishedAt,
    });
  }
  if (options.released) {
    await deliveries.updateDeliveryStatus("dlv-1", "RELEASED");
  }

  const service = new DeliveryService({ deliveries, plans, tasks, runs, events });
  const handlers = createRevisionCommandHandlers({
    deliveries: service,
    tasks,
    plans,
    runs,
    events,
  });
  return { handlers, tasks, plans, runs, deliveries, service, events };
}

describe("acceptance opinion → delivery revision (TASK-1267)", () => {
  it("adds one task that starts from the delivery the user is looking at", async () => {
    const { handlers, tasks, plans, deliveries } = await harness();
    const handler = handlers["delivery.revise"]!;

    const outcome = (await handler(
      { deliveryId: "dlv-1", statement: "三个按钮风格要统一" },
      ACTOR,
      ACTOR,
    )) as Record<string, any>;

    const revision = await tasks.findTask(outcome.task.id);
    expect(revision.status).toBe("READY");
    expect(revision.targets[0]!.baseRef).toBe("ai/task-spec-1-0-run-1");
    expect(readRevision(revision)?.previousFiles).toEqual([
      "components/download-button.tsx",
      "lib/download.ts",
    ]);

    // The revision joins the same Specification, after the original work.
    const items = await plans.listPlanItems("spec-1");
    expect(items.map((item) => [item.position, item.taskId])).toEqual([
      [0, "task-spec-1-0"],
      [1, outcome.task.id],
    ]);

    // The original deliverable is untouched: nothing was sent back.
    expect((await tasks.findTask("task-spec-1-0")).status).toBe("DONE");
    // ... and the aggregate reopened on its own, because a required task is open.
    expect((await deliveries.findDelivery("dlv-1")).status).toBe("IN_PROGRESS");
  });

  it("records the opinion and the base it builds on", async () => {
    const { handlers, events } = await harness();
    const outcome = (await handlers["delivery.revise"]!(
      { deliveryId: "dlv-1", statement: "按钮风格要统一" },
      ACTOR,
      ACTOR,
    )) as Record<string, any>;

    const recorded = (await events.listEvents({})).find(
      (event) => event.type === "revision.created",
    );
    expect(recorded?.taskId).toBe(outcome.task.id);
    expect(recorded?.payload).toMatchObject({
      deliveryId: "dlv-1",
      statement: "按钮风格要统一",
      baseRef: "ai/task-spec-1-0-run-1",
      baseRunId: "run-1",
    });
  });

  it("refuses a released delivery — that is a new requirement, not a revision", async () => {
    const { handlers } = await harness({ released: true });
    await expect(
      handlers["delivery.revise"]!(
        { deliveryId: "dlv-1", statement: "按钮风格要统一" },
        ACTOR,
        ACTOR,
      ),
    ).rejects.toThrow(/已经上线/);
  });

  it("still opens the round when there is no previous worktree to build on", async () => {
    const { handlers, tasks } = await harness({ withoutProduct: true });
    const outcome = (await handlers["delivery.revise"]!(
      { deliveryId: "dlv-1", statement: "按钮风格要统一" },
      ACTOR,
      ACTOR,
    )) as Record<string, any>;

    const revision = await tasks.findTask(outcome.task.id);
    expect(revision.status).toBe("READY");
    expect(revision.targets[0]!.baseRef).toBeUndefined();
    expect(readRevision(revision)?.previousFiles).toEqual([]);
  });
});

describe("the delivery's current content (TASK-1267)", () => {
  it("is the newest successful round, so a revision chain keeps moving forward", async () => {
    const { tasks, runs } = await harness();
    const second = completedRun({
      id: "run-2",
      taskId: "task-spec-1-0",
      attempt: 2,
      branch: "ai/task-spec-1-0-run-2",
      files: ["components/download-button.tsx", "components/player-bar.tsx"],
      finishedAt: "2026-10-10T03:00:00.000Z",
    });
    await runs.createRun({
      id: second.id,
      taskId: second.taskId,
      attempt: second.attempt,
      agent: second.agent,
      engine: second.engine,
      status: "SUCCEEDED",
    });
    await runs.completeRun(second.id, {
      status: "SUCCEEDED",
      result: {
        workspace: second.workspace,
        workspaces: [{ targetId: "tgt-1", ...second.workspace }],
        diff: second.diff,
      },
      finishedAt: second.finishedAt,
    });

    const product = await latestDeliveryProduct(await tasks.listTasks(), runs);

    expect(product?.run.id).toBe("run-2");
    expect(product?.branch).toBe("ai/task-spec-1-0-run-2");
  });
});

describe("revision regression (TASK-1267)", () => {
  it("flags a round that drops content the previous round added", async () => {
    const task = {
      constraints: {
        revision: {
          baseRunId: "run-1",
          previousFiles: ["components/download-button.tsx", "lib/download.ts"],
        },
      },
    } as never;

    expect(
      describeRevisionRegression(task, [
        "components/download-button.tsx",
        "lib/download.ts",
      ]),
    ).toBeUndefined();
    expect(describeRevisionRegression(task, ["components/download-button.tsx"])).toContain(
      "lib/download.ts",
    );
    // A task that is not a revision has nothing to protect.
    expect(describeRevisionRegression({ constraints: {} } as never, [])).toBeUndefined();
  });
});
