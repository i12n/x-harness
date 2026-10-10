import { describe, expect, it } from "vitest";
import { DeliveryService } from "../src/delivery/application/service.js";
import {
  NoopDeliveryNotifier,
  RecordingDeliveryNotifier,
} from "../src/delivery/application/notifier.js";
import type { DeliveryNotifier } from "../src/delivery/application/notifier.js";
import {
  DeliveryReconciler,
  NOTIFICATION_CAPACITY,
  NOTIFICATION_MAX_PER_PASS,
} from "../src/delivery/application/reconciler.js";
import { TaskDependencyService } from "../src/task/application/dependencyService.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemoryTaskDependencyStore } from "../src/store/inMemoryTaskDependencyStore.js";
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
    expect(JSON.stringify(notification.message.blocks)).toContain("待发布");
    expect(JSON.stringify(notification.message.blocks)).toContain("✓ task-a");
    expect(JSON.stringify(notification.message.blocks)).toContain("（尚未发布）");
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
    expect(message).toContain("已阻塞");
    expect(message).toContain("task-b 处于已阻塞");
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

  it("carries the blocking chain and failure evidence in the notification (TASK-1207)", async () => {
    const deliveries = new InMemoryDeliveryStore();
    const tasks = new InMemoryTaskStore();
    const plans = new InMemorySpecificationPlanStore();
    const events = new InMemoryEventStore();
    const runs = new InMemoryRunStore();
    const dependencyService = new TaskDependencyService({
      tasks,
      dependencies: new InMemoryTaskDependencyStore(),
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
    const notifier = new RecordingDeliveryNotifier();
    const reconciler = new DeliveryReconciler({ deliveries: service, notifier });

    await deliveries.createDelivery({ id: "dlv-001", specificationId: "spec-001" });
    await tasks.createTask({
      id: "task-b",
      title: "B 页面",
      status: "READY",
      targets: [{ repositoryId: "repo-a", role: "primary", position: 0, required: true }],
    });
    await tasks.createTask({
      id: "task-x",
      title: "X 迁移",
      status: "BLOCKED",
      targets: [{ repositoryId: "repo-a", role: "primary", position: 0, required: false }],
    });
    await plans.createPlanItem({
      id: "plan-spec-001-0",
      specificationId: "spec-001",
      position: 0,
      title: "B 页面",
      taskId: "task-b",
    });
    await plans.createPlanItem({
      id: "plan-spec-001-1",
      specificationId: "spec-001",
      position: 1,
      title: "X 迁移",
      taskId: "task-x",
    });
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

    const report = await reconciler.reconcileAll();

    expect(report.transitions).toMatchObject([{ status: "BLOCKED" }]);
    expect(notifier.notifications).toHaveLength(1);
    const rendered = JSON.stringify(notifier.notifications[0]!.message.blocks);
    expect(rendered).toContain("被依赖阻塞（等待 task-x）");
    expect(rendered).toContain("阻塞链");
    expect(rendered).toContain("task-x X 迁移（已阻塞）");
    expect(rendered).toContain("验证未通过：npm test · 退出码 1");
  });
});

describe("Notification pending bounds (TASK-1207 Phase B)", () => {
  /** always-failing notifier: keeps every notification pending. */
  class BrokenNotifier implements DeliveryNotifier {
    attempts = 0;
    async notify(): Promise<void> {
      this.attempts += 1;
      throw new Error("notifier down");
    }
  }

  /** creates `count` deliveries, each with one required task. */
  async function withDeliveries(count: number) {
    const deliveries = new InMemoryDeliveryStore();
    const tasks = new InMemoryTaskStore();
    const plans = new InMemorySpecificationPlanStore();
    const events = new InMemoryEventStore();
    const service = new DeliveryService({ deliveries, plans, tasks, events });
    for (let index = 0; index < count; index += 1) {
      const specId = `spec-${index}`;
      const deliveryId = `dlv-${index}`;
      await deliveries.createDelivery({
        id: deliveryId,
        specificationId: specId,
        status: "IN_PROGRESS",
      });
      await tasks.createTask({
        id: `task-${index}`,
        repositoryId: "repo-a",
        title: `task-${index}`,
        status: "DONE",
      });
      await plans.createPlanItem({
        id: `plan-${index}`,
        specificationId: specId,
        position: 0,
        title: `task-${index}`,
        taskId: `task-${index}`,
      });
    }
    return { deliveries, tasks, service };
  }

  it("limits send attempts per pass and keeps the rest pending", async () => {
    const h = await withDeliveries(3);
    const notifier = new BrokenNotifier();
    const reconciler = new DeliveryReconciler({
      deliveries: h.service,
      notifier,
      maxPerPass: 2,
    });

    const report = await reconciler.reconcileAll();

    expect(report.transitions).toHaveLength(3);
    expect(notifier.attempts).toBe(2);
    expect(report.notified).toBe(0);
    expect(report.notificationFailures).toHaveLength(2);
    expect(report.pendingNotifications).toBe(3);
    expect(report.droppedNotifications).toBe(0);
  });

  it("drops the newest notification when the queue is full (FIFO)", async () => {
    const h = await withDeliveries(3);
    const notifier = new BrokenNotifier();
    const reconciler = new DeliveryReconciler({
      deliveries: h.service,
      notifier,
      capacity: 2,
      maxPerPass: 1,
    });

    const report = await reconciler.reconcileAll();

    // 3 transitions, 1 attempt (fails), capacity 2 → the 3rd is dropped.
    expect(report.pendingNotifications).toBe(2);
    expect(report.droppedNotifications).toBe(1);
    expect(report.notificationFailures).toEqual([
      { deliveryId: "dlv-0", status: "READY_FOR_RELEASE", reason: "notifier down" },
      {
        deliveryId: "dlv-2",
        status: "READY_FOR_RELEASE",
        reason: "notification queue full (capacity 2)",
      },
    ]);
    // Delivery state is never affected by notification loss.
    await expect(h.deliveries.findDelivery("dlv-2")).resolves.toMatchObject({
      status: "READY_FOR_RELEASE",
    });
  });

  it("retries the oldest pending notification first", async () => {
    const h = await withDeliveries(3);
    let failing = true;
    const seen: string[] = [];
    const notifier: DeliveryNotifier = {
      notify: async (notification) => {
        if (failing) {
          throw new Error("notifier down");
        }
        seen.push(notification.delivery.id);
      },
    };
    const reconciler = new DeliveryReconciler({
      deliveries: h.service,
      notifier,
      capacity: 2,
      maxPerPass: 1,
    });

    const broken = await reconciler.reconcileAll();
    expect(broken.pendingNotifications).toBe(2);
    expect(broken.droppedNotifications).toBe(1);

    // FIFO: the oldest pending delivery is retried first, one per pass.
    failing = false;
    const firstRetry = await reconciler.reconcileAll();
    expect(firstRetry.transitions).toEqual([]);
    expect(seen).toEqual(["dlv-0"]);
    expect(firstRetry.notified).toBe(1);
    expect(firstRetry.pendingNotifications).toBe(1);

    const secondRetry = await reconciler.reconcileAll();
    expect(seen).toEqual(["dlv-0", "dlv-1"]);
    expect(secondRetry.pendingNotifications).toBe(0);
  });

  it("caps the pending queue at the production default", () => {
    expect(NOTIFICATION_CAPACITY).toBe(100);
    expect(NOTIFICATION_MAX_PER_PASS).toBe(20);
  });
});
