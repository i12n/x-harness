import { describe, expect, it } from "vitest";
import {
  aggregateDeliveryStatus,
  blockingTasks,
  buildDelivery,
  buildRelease,
  isRequiredTask,
} from "../src/domain/delivery.js";
import type { DeliveryStatus } from "../src/domain/delivery.js";
import { buildTask } from "../src/domain/task.js";
import type { Task, TaskStatus } from "../src/domain/task.js";
import { DeliveryService } from "../src/delivery/application/service.js";
import { DeliveryNotFoundError, ValidationError } from "../src/errors.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

function task(
  id: string,
  status: TaskStatus,
  options: { required?: boolean } = {},
): Task {
  return buildTask({
    id,
    title: id,
    status,
    targets: [
      {
        repositoryId: "repo-a",
        role: "primary",
        position: 0,
        required: options.required ?? true,
      },
    ],
  });
}

describe("Delivery domain (TASK-1205)", () => {
  it("builds a PLANNED delivery and validates input", () => {
    const delivery = buildDelivery({ specificationId: " spec-001 " });
    expect(delivery).toMatchObject({ specificationId: "spec-001", status: "PLANNED" });
    expect(delivery.id).toMatch(/^dlv-/);
    expect(() => buildDelivery({ specificationId: " " })).toThrow(ValidationError);
    expect(() =>
      // @ts-expect-error invalid status on purpose
      buildDelivery({ specificationId: "spec-001", status: "SHIPPED" }),
    ).toThrow(ValidationError);
    expect(() => buildRelease({ deliveryId: "" })).toThrow(ValidationError);
  });

  it("treats the primary target's required flag as the Task requirement", () => {
    expect(isRequiredTask(task("task-a", "READY"))).toBe(true);
    expect(isRequiredTask(task("task-b", "READY", { required: false }))).toBe(false);
  });

  it("aggregates required-only Task facts", () => {
    const cases: { tasks: Task[]; expected: DeliveryStatus }[] = [
      { tasks: [], expected: "PLANNED" },
      { tasks: [task("a", "DONE")], expected: "READY_FOR_RELEASE" },
      {
        tasks: [task("a", "DONE"), task("b", "DONE"), task("c", "DONE")],
        expected: "READY_FOR_RELEASE",
      },
      { tasks: [task("a", "DONE"), task("b", "REVIEW")], expected: "IN_PROGRESS" },
      { tasks: [task("a", "DONE"), task("b", "BLOCKED")], expected: "BLOCKED" },
      { tasks: [task("a", "FAILED")], expected: "BLOCKED" },
      {
        // optional tasks never block
        tasks: [task("a", "DONE"), task("b", "DONE"), task("c", "REVIEW", { required: false })],
        expected: "READY_FOR_RELEASE",
      },
      {
        tasks: [task("a", "DONE"), task("c", "BLOCKED", { required: false })],
        expected: "READY_FOR_RELEASE",
      },
    ];
    for (const entry of cases) {
      expect(aggregateDeliveryStatus(entry.tasks), JSON.stringify(entry.tasks.map((t) => t.status))).toBe(
        entry.expected,
      );
    }
  });

  it("lists the blocking tasks for visibility", () => {
    const tasks = [task("a", "DONE"), task("b", "BLOCKED"), task("c", "FAILED", { required: false })];
    expect(blockingTasks(tasks).map((entry) => entry.id)).toEqual(["b"]);
  });
});

interface Harness {
  deliveries: InMemoryDeliveryStore;
  tasks: InMemoryTaskStore;
  plans: InMemorySpecificationPlanStore;
  events: InMemoryEventStore;
  service: DeliveryService;
}

async function harness(): Promise<Harness> {
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
      status: "READY",
    });
    await plans.createPlanItem({
      id: `plan-spec-001-${position}`,
      specificationId: "spec-001",
      position,
      title: id,
      taskId: id,
    });
  }
  return { deliveries, tasks, plans, events, service };
}

describe("DeliveryService (TASK-1205)", () => {
  it("creates at most one Delivery per specification", async () => {
    const h = await harness();
    const again = await h.service.createForSpecification("spec-001");
    expect(again.id).toBe("dlv-001");
    expect(await h.deliveries.listDeliveries()).toHaveLength(1);

    const created = await h.service.createForSpecification("spec-002");
    expect(created.status).toBe("PLANNED");
    expect(await h.deliveries.listDeliveries()).toHaveLength(2);
    const events = await h.events.listEvents({ type: "delivery.created" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ specificationId: "spec-002" });
  });

  it("aggregates current task facts and emits ready_for_release once", async () => {
    const h = await harness();
    expect((await h.service.show("dlv-001")).delivery.status).toBe("IN_PROGRESS");

    for (const id of ["task-a", "task-b"]) {
      await h.tasks.updateTaskStatus(id, "DONE");
    }
    const view = await h.service.show("dlv-001");
    expect(view.delivery.status).toBe("READY_FOR_RELEASE");
    expect(view.requiredTasks).toHaveLength(2);
    expect(view.optionalTasks).toEqual([]);

    // Re-reading must not duplicate the event (edge-triggered).
    await h.service.show("dlv-001");
    const events = await h.events.listEvents({ type: "delivery.ready_for_release" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      deliveryId: "dlv-001",
      specificationId: "spec-001",
      status: "READY_FOR_RELEASE",
    });
  });

  it("follows task facts when they regress (never writes a fixed status)", async () => {
    const h = await harness();
    for (const id of ["task-a", "task-b"]) {
      await h.tasks.updateTaskStatus(id, "DONE");
    }
    await expect(h.service.show("dlv-001")).resolves.toMatchObject({
      delivery: { status: "READY_FOR_RELEASE" },
    });

    await h.tasks.updateTaskStatus("task-b", "BLOCKED");
    const regressed = await h.service.show("dlv-001");
    expect(regressed.delivery.status).toBe("BLOCKED");
    expect(regressed.blocking.map((entry) => entry.id)).toEqual(["task-b"]);
    const events = await h.events.listEvents({ type: "delivery.blocked" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      blocking: [{ id: "task-b", status: "BLOCKED" }],
    });
  });

  it("ignores optional tasks when aggregating", async () => {
    const h = await harness();
    await h.tasks.createTask({
      id: "task-optional",
      title: "optional",
      status: "REVIEW",
      targets: [
        { repositoryId: "repo-a", role: "primary", position: 0, required: false },
      ],
    });
    await h.plans.createPlanItem({
      id: "plan-spec-001-2",
      specificationId: "spec-001",
      position: 2,
      title: "optional",
      taskId: "task-optional",
    });
    for (const id of ["task-a", "task-b"]) {
      await h.tasks.updateTaskStatus(id, "DONE");
    }

    const view = await h.service.show("dlv-001");
    expect(view.delivery.status).toBe("READY_FOR_RELEASE");
    expect(view.requiredTasks.map((entry) => entry.id)).toEqual(["task-a", "task-b"]);
    expect(view.optionalTasks.map((entry) => entry.id)).toEqual(["task-optional"]);
  });

  it("rejects a release until every required task is DONE", async () => {
    const h = await harness();
    await h.tasks.updateTaskStatus("task-a", "DONE");

    await expect(
      h.service.release("dlv-001", { channel: "cli", userId: "reviewer" }),
    ).rejects.toMatchObject({ code: "delivery_not_ready_for_release" });
    await expect(h.deliveries.listReleases("dlv-001")).resolves.toEqual([]);
  });

  it("records a release once and keeps it idempotent", async () => {
    const h = await harness();
    for (const id of ["task-a", "task-b"]) {
      await h.tasks.updateTaskStatus(id, "DONE");
    }

    const first = await h.service.release("dlv-001", {
      channel: "cli",
      userId: "reviewer-1",
    });
    expect(first.created).toBe(true);
    expect(first.release).toMatchObject({
      deliveryId: "dlv-001",
      status: "RELEASED",
      createdBy: "cli:reviewer-1",
    });
    expect(first.delivery.status).toBe("RELEASED");

    const second = await h.service.release("dlv-001", {
      channel: "cli",
      userId: "reviewer-2",
    });
    expect(second.created).toBe(false);
    expect(second.release.id).toBe(first.release.id);
    expect(await h.deliveries.listReleases("dlv-001")).toHaveLength(1);

    const events = await h.events.listEvents({ type: "release.released" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ releaseId: first.release.id });
  });

  it("keeps RELEASED after the aggregate would change", async () => {
    const h = await harness();
    for (const id of ["task-a", "task-b"]) {
      await h.tasks.updateTaskStatus(id, "DONE");
    }
    await h.service.release("dlv-001", { channel: "cli", userId: "reviewer" });

    await h.tasks.updateTaskStatus("task-b", "READY");
    const view = await h.service.show("dlv-001");
    expect(view.delivery.status).toBe("RELEASED");
    expect(view.release?.status).toBe("RELEASED");
  });

  it("rejects unknown deliveries", async () => {
    const h = await harness();
    await expect(h.service.show("dlv-missing")).rejects.toBeInstanceOf(
      DeliveryNotFoundError,
    );
    await expect(
      h.service.release("dlv-missing", { channel: "cli", userId: "reviewer" }),
    ).rejects.toBeInstanceOf(DeliveryNotFoundError);
  });

  it("ignores plan items that have no task yet", async () => {
    const h = await harness();
    await h.plans.createPlanItem({
      id: "plan-spec-001-9",
      specificationId: "spec-001",
      position: 9,
      title: "pending",
    });
    for (const id of ["task-a", "task-b"]) {
      await h.tasks.updateTaskStatus(id, "DONE");
    }
    await expect(h.service.show("dlv-001")).resolves.toMatchObject({
      delivery: { status: "READY_FOR_RELEASE" },
    });
  });
});
