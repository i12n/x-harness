import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";

describe("InMemoryEventStore", () => {
  it("records events in order and filters them", async () => {
    const store = new InMemoryEventStore();
    await store.record({ type: "TaskCreated", taskId: "task-001", payload: { title: "t" } });
    await store.record({ type: "RunCreated", taskId: "task-001", runId: "run-001" });
    await store.record({ type: "RunSucceeded", taskId: "task-001", runId: "run-001" });

    const all = await store.listEvents();
    expect(all.map((event) => event.type)).toEqual([
      "TaskCreated",
      "RunCreated",
      "RunSucceeded",
    ]);
    expect(all[0]?.taskId).toBe("task-001");
    expect(all[0]?.payload).toEqual({ title: "t" });

    await expect(store.listEvents({ taskId: "task-001" })).resolves.toHaveLength(3);
    await expect(store.listEvents({ runId: "run-001" })).resolves.toHaveLength(2);
    await expect(store.listEvents({ type: "RunCreated" })).resolves.toHaveLength(1);
    await expect(store.listEvents({ limit: 2 })).resolves.toHaveLength(2);
  });
});
