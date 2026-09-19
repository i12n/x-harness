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
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

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
});
