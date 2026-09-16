import { describe, expect, it } from "vitest";
import { ExecutionNotFoundError } from "../src/errors.js";
import { InMemoryExecutionStore } from "../src/store/inMemoryExecutionStore.js";

describe("InMemoryExecutionStore", () => {
  it("creates, finds and updates an execution record", async () => {
    const store = new InMemoryExecutionStore();
    const created = await store.createExecution({
      id: "exec-001",
      runId: "run-001",
      driver: "docker",
      workspacePath: "/srv/runs/run-001",
      workdir: "/workspace",
      profileName: "frontend-node",
    });
    expect(created.status).toBe("CREATING");

    const running = await store.updateExecution("exec-001", {
      status: "RUNNING",
      containerId: "ctr-1",
      startedAt: "2026-09-16T00:00:00.000Z",
    });
    expect(running.containerId).toBe("ctr-1");
    expect(running.startedAt).toBe("2026-09-16T00:00:00.000Z");

    const cleaned = await store.updateExecution("exec-001", {
      status: "CLEANED",
      cleanedAt: "2026-09-16T00:05:00.000Z",
    });
    expect(cleaned.status).toBe("CLEANED");
    expect(cleaned.cleanedAt).toBe("2026-09-16T00:05:00.000Z");

    await expect(store.findExecution("exec-001")).resolves.toEqual(cleaned);
    await expect(store.findExecution("exec-missing")).rejects.toBeInstanceOf(
      ExecutionNotFoundError,
    );
  });

  it("finds the latest execution per run and filters by status", async () => {
    const store = new InMemoryExecutionStore();
    await store.createExecution({
      id: "exec-001",
      runId: "run-001",
      driver: "docker",
      workspacePath: "/w1",
      workdir: "/workspace",
      status: "CLEANED",
    });
    await store.createExecution({
      id: "exec-002",
      runId: "run-001",
      driver: "docker",
      workspacePath: "/w2",
      workdir: "/workspace",
      status: "CLEANUP_FAILED",
    });

    expect((await store.findLatestByRunId("run-001"))?.id).toBe("exec-002");
    expect(await store.findLatestByRunId("run-404")).toBeUndefined();
    await expect(
      store.listExecutions({ statuses: ["CLEANUP_FAILED"] }),
    ).resolves.toMatchObject([{ id: "exec-002" }]);
    await expect(store.listExecutions({ runId: "run-001" })).resolves.toHaveLength(2);
  });
});
