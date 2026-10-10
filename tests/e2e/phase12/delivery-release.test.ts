import { describe, expect, it } from "vitest";
import { createPhase12Harness } from "./harness.js";

describe("Phase 12 E2E — Delivery aggregation and release (TASK-1205)", () => {
  it("auto-creates the Delivery on planning and reaches READY_FOR_RELEASE", async () => {
    const h = await createPhase12Harness();
    const specification = await h.seedReadySpecification({
      requirements: ["A: 列表接口", "B: 页面"],
    });
    const planned = await h.planning.plan(specification.id);

    // spec.plan created the Delivery — no delivery.create command exists.
    const delivery = await h.deliveryService.findBySpecification(specification.id);
    expect(delivery).toBeDefined();
    expect(delivery?.status).toBe("PLANNED");

    const showed = await h.dispatch(
      "delivery.show",
      { deliveryId: delivery!.id },
      { roles: ["guest"] },
    );
    expect(showed.status).toBe("succeeded");
    const data = showed.data as {
      delivery: { status: string };
      tasks: unknown[];
      message: { blocks?: unknown[] };
    };
    expect(data.delivery.status).toBe("IN_PROGRESS");
    expect(data.tasks).toHaveLength(2);
    const rendered = JSON.stringify(data.message.blocks);
    expect(rendered).toContain("开发中");
    expect(rendered).toContain("（尚未发布）");

    // Planning is idempotent, and so is the Delivery.
    await h.planning.plan(specification.id);
    await expect(h.deliveries.listDeliveries()).resolves.toHaveLength(1);

    // Finish every task (Task DONE is the completion point).
    const plannedAgain = await h.planning.plan(specification.id);
    for (const task of plannedAgain.tasks) {
      await h.tasks.updateTaskStatus(task.id, "DONE");
    }
    const ready = await h.deliveryService.show(delivery!.id);
    expect(ready.delivery.status).toBe("READY_FOR_RELEASE");

    // Human release through the command layer.
    const released = await h.dispatch(
      "delivery.release",
      { deliveryId: delivery!.id },
      { roles: ["reviewer"], senderId: "reviewer-1" },
    );
    expect(released.status).toBe("succeeded");
    const releasedData = released.data as {
      delivery: { status: string };
      release: { status: string; createdBy?: string };
      created: boolean;
      message: { blocks?: unknown[] };
    };
    expect(releasedData.created).toBe(true);
    expect(releasedData.delivery.status).toBe("RELEASED");
    expect(releasedData.release).toMatchObject({
      status: "RELEASED",
      createdBy: "cli:reviewer-1",
    });
    expect(JSON.stringify(releasedData.message.blocks)).toContain("已发布");

    // Repeated release is idempotent: no second Release row, no extra events.
    const again = await h.dispatch(
      "delivery.release",
      { deliveryId: delivery!.id },
      { roles: ["reviewer"], messageId: "msg-release-2" },
    );
    expect(again.status).toBe("succeeded");
    expect((again.data as { created: boolean }).created).toBe(false);
    await expect(h.deliveries.listReleases(delivery!.id)).resolves.toHaveLength(1);
    await expect(
      h.events.listEvents({ type: "release.released" }),
    ).resolves.toHaveLength(1);
    expect(planned.tasks).toHaveLength(2);
  });

  it("rejects a release while a required task is unfinished", async () => {
    const h = await createPhase12Harness();
    const specification = await h.seedReadySpecification({
      requirements: ["A", "B"],
    });
    const planned = await h.planning.plan(specification.id);
    const delivery = (await h.deliveryService.findBySpecification(specification.id))!;
    await h.tasks.updateTaskStatus(planned.tasks[0]!.id, "DONE");
    await h.tasks.updateTaskStatus(planned.tasks[1]!.id, "BLOCKED");

    const blocked = await h.deliveryService.show(delivery.id);
    expect(blocked.delivery.status).toBe("BLOCKED");
    expect(blocked.blocking.map((task) => task.id)).toEqual([planned.tasks[1]!.id]);

    const rejected = await h.dispatch(
      "delivery.release",
      { deliveryId: delivery.id },
      { roles: ["reviewer"] },
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      error: { code: "delivery_not_ready_for_release" },
    });
    await expect(h.deliveries.listReleases(delivery.id)).resolves.toEqual([]);

    // Guests cannot release, and unknown deliveries are rejected.
    await expect(
      h.dispatch(
        "delivery.release",
        { deliveryId: delivery.id },
        { roles: ["guest"], messageId: "msg-guest" },
      ),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unauthorized" } });
    await expect(
      h.dispatch(
        "delivery.show",
        { deliveryId: "dlv-missing" },
        { roles: ["guest"], messageId: "msg-missing" },
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "delivery_not_found" },
    });
  });

  it("keeps delivery status a live aggregate over task facts", async () => {
    const h = await createPhase12Harness();
    const specification = await h.seedReadySpecification({ requirements: ["A", "B"] });
    const planned = await h.planning.plan(specification.id);
    const delivery = (await h.deliveryService.findBySpecification(specification.id))!;
    for (const task of planned.tasks) {
      await h.tasks.updateTaskStatus(task.id, "DONE");
    }
    await expect(h.deliveryService.show(delivery.id)).resolves.toMatchObject({
      delivery: { status: "READY_FOR_RELEASE" },
    });

    // A regression must be visible again: no permanently written status.
    await h.tasks.updateTaskStatus(planned.tasks[0]!.id, "REVIEW");
    const regressed = await h.deliveryService.show(delivery.id);
    expect(regressed.delivery.status).toBe("IN_PROGRESS");

    await h.tasks.updateTaskStatus(planned.tasks[0]!.id, "DONE");
    await expect(h.deliveryService.show(delivery.id)).resolves.toMatchObject({
      delivery: { status: "READY_FOR_RELEASE" },
    });
  });
});
