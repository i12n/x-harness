import { describe, expect, it } from "vitest";
import { DeliveryService } from "../src/delivery/application/service.js";
import {
  NoopDeliveryNotifier,
  RecordingDeliveryNotifier,
} from "../src/delivery/application/notifier.js";
import { DeliveryReconciler } from "../src/delivery/application/reconciler.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

interface Harness {
  deliveries: InMemoryDeliveryStore;
  tasks: InMemoryTaskStore;
  events: InMemoryEventStore;
  notifier: RecordingDeliveryNotifier;
  service: DeliveryService;
  reconciler: DeliveryReconciler;
}

async function harness(notifier = new RecordingDeliveryNotifier()): Promise<Harness> {
  const deliveries = new InMemoryDeliveryStore();
  const tasks = new InMemoryTaskStore();
  const plans = new InMemorySpecificationPlanStore();
  const events = new InMemoryEventStore();
  const service = new DeliveryService({ deliveries, plans, tasks, events });

  await deliveries.createDelivery({ id: "dlv-001", specificationId: "spec-001" });
  for (const [position, id] of ["task-a", "task-b"].entries()) {
    await tasks.createTask({
      id,
      repositoryId: "repo-a",
      title: id,
      status: "INBOX",
    });
    await plans.createPlanItem({
      id: `plan-spec-001-${position}`,
      specificationId: "spec-001",
      position,
      title: id,
      taskId: id,
    });
  }
  return {
    deliveries,
    tasks,
    events,
    notifier,
    service,
    reconciler: new DeliveryReconciler({ deliveries: service, notifier }),
  };
}

describe("DeliveryReconciler (TASK-1206)", () => {
  it("aggregates task facts and notifies when a delivery becomes ready", async () => {
    const h = await harness();

    const idle = await h.reconciler.reconcileAll();
    // INBOX tasks: IN_PROGRESS is not notifiable.
    expect(idle.transitions.map((entry) => entry.status)).toEqual(["IN_PROGRESS"]);
    expect(idle.notified).toBe(0);
    expect(h.notifier.notifications).toEqual([]);

    await h.tasks.updateTaskStatus("task-a", "DONE");
    await h.tasks.updateTaskStatus("task-b", "DONE");
    const ready = await h.reconciler.reconcileAll();

    expect(ready.transitions).toMatchObject([
      { previousStatus: "IN_PROGRESS", status: "READY_FOR_RELEASE" },
    ]);
    expect(ready.notified).toBe(1);
    expect(h.notifier.notifications).toHaveLength(1);
    const notification = h.notifier.notifications[0]!;
    expect(notification.status).toBe("READY_FOR_RELEASE");
    expect(notification.previousStatus).toBe("IN_PROGRESS");
    expect(JSON.stringify(notification.message.blocks)).toContain("READY_FOR_RELEASE");
    expect(JSON.stringify(notification.message.blocks)).toContain("✓ task-a");
    expect(JSON.stringify(notification.message.blocks)).toContain("(not released)");
  });

  it("is idempotent across repeated passes", async () => {
    const h = await harness();
    await h.tasks.updateTaskStatus("task-a", "DONE");
    await h.tasks.updateTaskStatus("task-b", "DONE");

    for (let pass = 0; pass < 3; pass += 1) {
      await h.reconciler.reconcileAll();
    }

    expect(h.notifier.notifications).toHaveLength(1);
    await expect(
      h.events.listEvents({ type: "delivery.ready_for_release" }),
    ).resolves.toHaveLength(1);
  });

  it("notifies a regression to BLOCKED exactly once", async () => {
    const h = await harness();
    await h.tasks.updateTaskStatus("task-a", "DONE");
    await h.tasks.updateTaskStatus("task-b", "DONE");
    await h.reconciler.reconcileAll();

    await h.tasks.updateTaskStatus("task-b", "BLOCKED");
    const blocked = await h.reconciler.reconcileAll();
    await h.reconciler.reconcileAll();

    expect(blocked.transitions).toMatchObject([
      { previousStatus: "READY_FOR_RELEASE", status: "BLOCKED" },
    ]);
    expect(blocked.notified).toBe(1);
    expect(h.notifier.notifications.map((entry) => entry.status)).toEqual([
      "READY_FOR_RELEASE",
      "BLOCKED",
    ]);
    const message = JSON.stringify(h.notifier.notifications[1]!.message.blocks);
    expect(message).toContain("BLOCKED");
    expect(message).toContain("task-b is BLOCKED");
    await expect(h.events.listEvents({ type: "delivery.blocked" })).resolves.toHaveLength(1);
  });

  it("notifies again after a blocked delivery recovers", async () => {
    const h = await harness();
    await h.tasks.updateTaskStatus("task-a", "DONE");
    await h.tasks.updateTaskStatus("task-b", "DONE");
    await h.reconciler.reconcileAll();

    await h.tasks.updateTaskStatus("task-b", "BLOCKED");
    await h.reconciler.reconcileAll();

    await h.tasks.updateTaskStatus("task-b", "READY");
    await h.tasks.updateTaskStatus("task-b", "DONE");
    const recovered = await h.reconciler.reconcileAll();

    expect(recovered.transitions).toMatchObject([
      { previousStatus: "BLOCKED", status: "READY_FOR_RELEASE" },
    ]);
    expect(recovered.notified).toBe(1);
    await expect(
      h.events.listEvents({ type: "delivery.ready_for_release" }),
    ).resolves.toHaveLength(2);
  });

  it("never overwrites a RELEASED delivery", async () => {
    const h = await harness();
    await h.tasks.updateTaskStatus("task-a", "DONE");
    await h.tasks.updateTaskStatus("task-b", "DONE");
    await h.reconciler.reconcileAll();
    await h.service.release("dlv-001", { channel: "cli", userId: "reviewer" });

    await h.tasks.updateTaskStatus("task-b", "BLOCKED");
    const after = await h.reconciler.reconcileAll();

    expect(after.transitions).toEqual([]);
    expect(after.notified).toBe(0);
    await expect(h.deliveries.findDelivery("dlv-001")).resolves.toMatchObject({
      status: "RELEASED",
    });
    expect(h.notifier.notifications.map((entry) => entry.status)).toEqual([
      "READY_FOR_RELEASE",
    ]);
  });

  it("records notifier failures, keeps the transition, and retries later", async () => {
    const notifier = RecordingDeliveryNotifier.failingOnce("notifier unavailable");
    const h = await harness(notifier);
    await h.tasks.updateTaskStatus("task-a", "DONE");
    await h.tasks.updateTaskStatus("task-b", "DONE");

    const failed = await h.reconciler.reconcileAll();
    expect(failed.notificationFailures).toEqual([
      {
        deliveryId: "dlv-001",
        status: "READY_FOR_RELEASE",
        reason: "notifier unavailable",
      },
    ]);
    expect(failed.notified).toBe(0);
    expect(failed.pendingNotifications).toBe(1);
    // The transition itself survived and is not re-emitted.
    await expect(h.deliveries.findDelivery("dlv-001")).resolves.toMatchObject({
      status: "READY_FOR_RELEASE",
    });
    await expect(
      h.events.listEvents({ type: "delivery.ready_for_release" }),
    ).resolves.toHaveLength(1);

    const retry = await h.reconciler.reconcileAll();
    expect(retry.transitions).toEqual([]);
    expect(retry.notified).toBe(1);
    expect(retry.notificationFailures).toEqual([]);
    expect(retry.pendingNotifications).toBe(0);
    expect(h.notifier.notifications).toHaveLength(1);
    await expect(
      h.events.listEvents({ type: "delivery.ready_for_release" }),
    ).resolves.toHaveLength(1);
  });

  it("does nothing without deliveries and needs no notifier", async () => {
    const deliveries = new InMemoryDeliveryStore();
    const service = new DeliveryService({
      deliveries,
      plans: new InMemorySpecificationPlanStore(),
      tasks: new InMemoryTaskStore(),
      events: new InMemoryEventStore(),
    });
    const reconciler = new DeliveryReconciler({ deliveries: service });

    await expect(reconciler.reconcileAll()).resolves.toMatchObject({
      transitions: [],
      notified: 0,
      pendingNotifications: 0,
    });
    expect(new NoopDeliveryNotifier()).toBeInstanceOf(NoopDeliveryNotifier);
  });
});
