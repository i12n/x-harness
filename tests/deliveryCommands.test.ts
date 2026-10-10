import { describe, expect, it } from "vitest";
import {
  CommandDispatcher,
  InMemoryIdempotencyStore,
  ScriptedIntentEngine,
  handleIntent,
  type CommandResult,
  type Role,
} from "../src/command/index.js";
import { createDeliveryCommandHandlers } from "../src/command/handlers/delivery.js";
import { DeliveryService } from "../src/delivery/application/service.js";
import { TaskDependencyService } from "../src/task/application/dependencyService.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemoryTaskDependencyStore } from "../src/store/inMemoryTaskDependencyStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import type { TaskStatus } from "../src/domain/task.js";

interface Harness {
  deliveries: InMemoryDeliveryStore;
  tasks: InMemoryTaskStore;
  dispatch(
    type: string,
    payload: Record<string, unknown>,
    options?: { roles?: Role[]; messageId?: string },
  ): Promise<CommandResult>;
}

async function harness(): Promise<Harness> {
  const deliveries = new InMemoryDeliveryStore();
  const tasks = new InMemoryTaskStore();
  const plans = new InMemorySpecificationPlanStore();
  const events = new InMemoryEventStore();
  const service = new DeliveryService({ deliveries, plans, tasks, events });
  const dispatcher = new CommandDispatcher({
    handlers: createDeliveryCommandHandlers({ deliveries: service }),
    idempotency: new InMemoryIdempotencyStore(),
  });

  await deliveries.createDelivery({ id: "dlv-001", specificationId: "spec-001" });
  for (const [position, status] of (["DONE", "REVIEW"] as const).entries()) {
    const id = `task-${position === 0 ? "a" : "b"}`;
    await tasks.createTask({
      id,
      repositoryId: "repo-a",
      title: id,
      status,
    });
    await plans.createPlanItem({
      id: `plan-spec-001-${position}`,
      specificationId: "spec-001",
      position,
      title: id,
      taskId: id,
    });
  }

  const dispatch = (
    type: string,
    payload: Record<string, unknown>,
    options: { roles?: Role[]; messageId?: string } = {},
  ): Promise<CommandResult> =>
    handleIntent(
      {
        channel: "cli",
        conversationId: "conv-001",
        messageId: options.messageId ?? "msg-001",
        senderId: "cli-user",
        text: "delivery",
      },
      { channel: "cli", userId: "cli-user", roles: options.roles ?? ["guest"] },
      {
        engine: new ScriptedIntentEngine({ command: { type, payload } }),
        dispatcher,
      },
    );

  return { deliveries, tasks, dispatch };
}

describe("delivery.show / delivery.release commands (TASK-1205)", () => {
  it("shows the aggregated delivery to any role", async () => {
    const h = await harness();
    const result = await h.dispatch("delivery.show", { deliveryId: "dlv-001" });

    expect(result.status).toBe("succeeded");
    const data = result.data as {
      delivery: { status: string };
      blocking: unknown[];
      message: { blocks?: unknown[] };
    };
    expect(data.delivery.status).toBe("IN_PROGRESS");
    expect(data.blocking).toEqual([]);
    expect(JSON.stringify(data.message.blocks)).toContain("task-b");
  });

  it("rejects release for guests and unfinished deliveries", async () => {
    const h = await harness();

    await expect(
      h.dispatch("delivery.release", { deliveryId: "dlv-001" }, { roles: ["guest"] }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unauthorized" } });

    await expect(
      h.dispatch("delivery.release", { deliveryId: "dlv-001" }, { roles: ["reviewer"] }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "delivery_not_ready_for_release" },
    });

    await expect(
      h.dispatch(
        "delivery.show",
        { deliveryId: "dlv-missing" },
        { messageId: "msg-missing" },
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "delivery_not_found" },
    });
    await expect(
      h.dispatch("delivery.show", { deliveryId: 42 }, { messageId: "msg-type" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "invalid_field_type" },
    });
    await expect(h.deliveries.listReleases("dlv-001")).resolves.toEqual([]);
  });

  it("releases once a reviewer asks, and replays the duplicate message", async () => {
    const h = await harness();
    await h.tasks.updateTaskStatus("task-b", "DONE");

    const first = await h.dispatch(
      "delivery.release",
      { deliveryId: "dlv-001" },
      { roles: ["reviewer"] },
    );
    expect(first.status).toBe("succeeded");
    expect(first.data).toMatchObject({
      delivery: { status: "RELEASED" },
      release: { status: "RELEASED" },
      created: true,
    });

    const replayed = await h.dispatch(
      "delivery.release",
      { deliveryId: "dlv-001" },
      { roles: ["reviewer"] },
    );
    expect(replayed.replayed).toBe(true);

    const otherMessage = await h.dispatch(
      "delivery.release",
      { deliveryId: "dlv-001" },
      { roles: ["reviewer"], messageId: "msg-002" },
    );
    expect(otherMessage.status).toBe("succeeded");
    expect((otherMessage.data as { created: boolean }).created).toBe(false);
    await expect(h.deliveries.listReleases("dlv-001")).resolves.toHaveLength(1);
  });

  it("shows the blocking chain and failure evidence for a blocked delivery (TASK-1207)", async () => {
    const deliveries = new InMemoryDeliveryStore();
    const tasks = new InMemoryTaskStore();
    const plans = new InMemorySpecificationPlanStore();
    const events = new InMemoryEventStore();
    const runs = new InMemoryRunStore();
    const dependencyStore = new InMemoryTaskDependencyStore();
    const dependencyService = new TaskDependencyService({
      tasks,
      dependencies: dependencyStore,
      events,
    });
    const service = new DeliveryService({
      deliveries,
      plans,
      tasks,
      events,
      impacts: dependencyService,
      runs,
    });
    const dispatcher = new CommandDispatcher({
      handlers: createDeliveryCommandHandlers({ deliveries: service }),
      idempotency: new InMemoryIdempotencyStore(),
    });

    await deliveries.createDelivery({ id: "dlv-001", specificationId: "spec-001" });
    const seed: [string, string, boolean, TaskStatus][] = [
      ["task-a", "A 接口", true, "DONE"],
      ["task-x", "X 迁移", false, "BLOCKED"],
      ["task-b", "B 页面", true, "READY"],
    ];
    for (const [position, [id, title, required, status]] of seed.entries()) {
      await tasks.createTask({
        id,
        title,
        status,
        targets: [
          { repositoryId: "repo-a", role: "primary", position: 0, required },
        ],
      });
      await plans.createPlanItem({
        id: `plan-spec-001-${position}`,
        specificationId: "spec-001",
        position,
        title,
        taskId: id,
      });
    }
    await dependencyService.addDependency("task-b", "task-x");
    await runs.createRun({
      id: "run-x",
      taskId: "task-x",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await runs.completeRun("run-x", {
      status: "FAILED",
      exitCode: 1,
      error: {
        failingTargets: [
          {
            targetId: "tgt-x",
            repositoryId: "repo-a",
            checks: [
              { command: "npm test", status: "failed", exitCode: 1, output: "3 tests failed" },
            ],
          },
        ],
      },
    });

    const result = await handleIntent(
      {
        channel: "cli",
        conversationId: "conv-001",
        messageId: "msg-blocked",
        senderId: "cli-user",
        text: "delivery",
      },
      { channel: "cli", userId: "cli-user", roles: ["guest"] },
      {
        engine: new ScriptedIntentEngine({
          command: { type: "delivery.show", payload: { deliveryId: "dlv-001" } },
        }),
        dispatcher,
      },
    );

    expect(result.status).toBe("succeeded");
    const data = result.data as {
      delivery: { status: string };
      blockingFacts: { taskId: string; state: string }[];
      message: { blocks?: unknown[] };
    };
    expect(data.delivery.status).toBe("BLOCKED");
    expect(data.blockingFacts).toMatchObject([
      { taskId: "task-b", state: "dependency-blocked" },
    ]);
    const rendered = JSON.stringify(data.message.blocks);
    expect(rendered).toContain("被依赖阻塞（等待 task-x）");
    expect(rendered).toContain("阻塞链");
    expect(rendered).toContain("task-x X 迁移（已阻塞）");
    expect(rendered).toContain("失败原因");
    expect(rendered).toContain("task-x: 验证未通过：npm test · 退出码 1");
    expect(rendered).toContain("3 tests failed");
  });
});
