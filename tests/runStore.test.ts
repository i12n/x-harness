import { describe, expect, it } from "vitest";
import {
  RunConflictError,
  RunNotCancellableError,
  RunNotFoundError,
} from "../src/errors.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";

describe("InMemoryRunStore", () => {
  it("creates a queued run and claims it with a worker lease", async () => {
    const store = new InMemoryRunStore();
    const created = await store.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    expect(created.status).toBe("QUEUED");

    const claimed = await store.claimRun("run-001", "worker-1", "2099-01-01T00:00:00.000Z");
    expect(claimed.status).toBe("STARTING");
    expect(claimed.workerId).toBe("worker-1");
    expect(claimed.leaseUntil).toBe("2099-01-01T00:00:00.000Z");
  });

  it("only allows one worker to claim a run", async () => {
    const store = new InMemoryRunStore();
    await store.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await store.claimRun("run-001", "worker-1", "2099-01-01T00:00:00.000Z");

    await expect(
      store.claimRun("run-001", "worker-2", "2099-01-01T00:00:00.000Z"),
    ).rejects.toBeInstanceOf(RunConflictError);
  });

  it("marks runs running, refreshes leases and completes them", async () => {
    const store = new InMemoryRunStore();
    await store.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await store.claimRun("run-001", "worker-1", "2099-01-01T00:00:00.000Z");

    const running = await store.markRunning("run-001");
    expect(running.status).toBe("RUNNING");
    expect(running.startedAt).toBeDefined();

    const touched = await store.touchLease("run-001", "2099-02-01T00:00:00.000Z");
    expect(touched.leaseUntil).toBe("2099-02-01T00:00:00.000Z");

    const completed = await store.completeRun("run-001", {
      status: "SUCCEEDED",
      exitCode: 0,
      result: { ok: true },
      finishedAt: "2099-03-01T00:00:00.000Z",
    });
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.finishedAt).toBe("2099-03-01T00:00:00.000Z");
  });

  it("lists runs by task and active statuses", async () => {
    const store = new InMemoryRunStore();
    await store.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "a", engine: "e" });
    await store.createRun({ id: "run-002", taskId: "task-002", attempt: 1, agent: "a", engine: "e" });
    await store.createRun({ id: "run-003", taskId: "task-001", attempt: 2, agent: "a", engine: "e", status: "FAILED" });

    await expect(store.listRuns({ taskId: "task-001" })).resolves.toHaveLength(2);
    await expect(store.listRuns({ statuses: ["FAILED"] })).resolves.toMatchObject([
      { id: "run-003" },
    ]);
    await expect(store.findRun("run-missing")).rejects.toBeInstanceOf(RunNotFoundError);
  });

  describe("cancel requests (TASK-1108)", () => {
    it("persists a request once and is idempotent", async () => {
      const store = new InMemoryRunStore();
      await store.createRun({
        id: "run-001",
        taskId: "task-001",
        attempt: 1,
        agent: "codex",
        engine: "codex",
      });
      await store.claimRun("run-001", "worker-1", "2099-01-01T00:00:00.000Z");
      await store.markRunning("run-001");

      const first = await store.requestCancel("run-001", "feishu:ou_1");
      const second = await store.requestCancel("run-001", "feishu:ou_2");

      expect(first.status).toBe("RUNNING");
      expect(first.cancelRequestedAt).toBeDefined();
      expect(second.cancelRequestedBy).toBe("feishu:ou_1");
      await expect(store.listRuns({ cancelRequested: true })).resolves.toHaveLength(1);
      await expect(store.listRuns({ cancelRequested: false })).resolves.toHaveLength(0);
    });

    it("rejects cancelling a terminal run", async () => {
      const store = new InMemoryRunStore();
      await store.createRun({
        id: "run-001",
        taskId: "task-001",
        attempt: 1,
        agent: "codex",
        engine: "codex",
      });
      await store.claimRun("run-001", "worker-1", "2099-01-01T00:00:00.000Z");
      await store.markRunning("run-001");
      await store.completeRun("run-001", { status: "SUCCEEDED", exitCode: 0 });

      await expect(
        store.requestCancel("run-001", "feishu:ou_1"),
      ).rejects.toBeInstanceOf(RunNotCancellableError);
    });
  });
});
