import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";

describe("InMemorySpecificationPlanStore (TASK-1202)", () => {
  it("creates plan items and lists them by position", async () => {
    const store = new InMemorySpecificationPlanStore();
    await store.createPlanItem({
      id: "plan-1",
      specificationId: "spec-001",
      position: 1,
      title: "second",
    });
    await store.createPlanItem({
      id: "plan-0",
      specificationId: "spec-001",
      position: 0,
      title: "first",
      description: "first item",
    });
    await store.createPlanItem({
      id: "plan-other",
      specificationId: "spec-002",
      position: 0,
      title: "other",
    });

    const items = await store.listPlanItems("spec-001");
    expect(items.map((item) => item.id)).toEqual(["plan-0", "plan-1"]);
    expect(items[0]).toMatchObject({
      position: 0,
      title: "first",
      description: "first item",
      taskId: undefined,
    });
    expect(items[0]?.createdAt).toBe(items[0]?.updatedAt);
  });

  it("enforces one plan item per (specification, position) and per task", async () => {
    const store = new InMemorySpecificationPlanStore();
    await store.createPlanItem({
      id: "plan-0",
      specificationId: "spec-001",
      position: 0,
      title: "first",
    });

    await expect(
      store.createPlanItem({
        id: "plan-0b",
        specificationId: "spec-001",
        position: 0,
        title: "clash",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.createPlanItem({
        id: "plan-0",
        specificationId: "spec-001",
        position: 1,
        title: "duplicate id",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await store.createPlanItem({
      id: "plan-t",
      specificationId: "spec-001",
      position: 1,
      title: "linked",
      taskId: "task-0",
    });
    await expect(
      store.createPlanItem({
        specificationId: "spec-002",
        position: 0,
        title: "task clash",
        taskId: "task-0",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("links a task and deletes the whole plan", async () => {
    const store = new InMemorySpecificationPlanStore();
    await store.createPlanItem({
      id: "plan-0",
      specificationId: "spec-001",
      position: 0,
      title: "first",
    });

    const linked = await store.attachTask("plan-0", "task-spec-001-0");
    expect(linked.taskId).toBe("task-spec-001-0");
    await expect(store.attachTask("plan-missing", "task-x")).rejects.toBeInstanceOf(
      ValidationError,
    );

    await store.deletePlanItemsForSpecification("spec-001");
    await expect(store.listPlanItems("spec-001")).resolves.toEqual([]);
  });
});
