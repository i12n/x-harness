import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import {
  ExecutionManager,
  type ExecutionDriver,
  type ExecutionEnvironment,
  type ExecutionRequest,
} from "../src/execution/manager.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryExecutionStore } from "../src/store/inMemoryExecutionStore.js";

interface DriverBehavior {
  failCreate?: boolean;
  failStart?: boolean;
  cleanupFailures?: number;
  containerId?: string;
}

class ControlDriver implements ExecutionDriver {
  readonly name = "control";
  createCalls = 0;
  cleanupCalls = 0;
  private cleanupFailures: number;

  constructor(private readonly behavior: DriverBehavior = {}) {
    this.cleanupFailures = behavior.cleanupFailures ?? 0;
  }

  async create(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    this.createCalls += 1;
    if (this.behavior.failCreate) {
      throw new Error("create boom");
    }
    return {
      id: `control-${request.runId}`,
      runId: request.runId,
      workspacePath: request.workspacePath,
      containerWorkspace: request.workspacePath,
      profile: request.profile,
      driver: this.name,
      containerId: this.behavior.containerId,
    };
  }

  async start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment> {
    if (this.behavior.failStart) {
      throw new Error("start boom");
    }
    return { ...environment, startedAt: new Date().toISOString() };
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
    if (this.cleanupFailures > 0) {
      this.cleanupFailures -= 1;
      throw new Error("cleanup boom");
    }
  }
}

describe("Execution lifecycle contract (TASK-901/908)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function setup(behavior: DriverBehavior = {}) {
    const workspace = mkdtempSync(join(tmpdir(), "ai-exec-lifecycle-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const executions = new InMemoryExecutionStore();
    const events = new InMemoryEventStore();
    const driver = new ControlDriver(behavior);
    const manager = new ExecutionManager({ driver, executions, events });
    const request = {
      runId: "run-001",
      workspacePath: workspace,
      profile: defaultExecutionProfile(),
    };
    return { executions, events, driver, manager, request };
  }

  it("create failure: no cleanup obligation, record FAILED", async () => {
    const { executions, driver, manager, request } = await setup({ failCreate: true });

    await expect(manager.prepare(request)).rejects.toThrow(/create boom/);

    expect(driver.cleanupCalls).toBe(0);
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("FAILED");
    expect(String(record?.error)).toContain("create boom");
  });

  it("start failure: cleanup is still executed", async () => {
    const { executions, events, driver, manager, request } = await setup({
      failStart: true,
    });

    await expect(manager.prepare(request)).rejects.toThrow(/start boom/);

    expect(driver.cleanupCalls).toBe(1);
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    const types = (await events.listEvents({ runId: "run-001" })).map((e) => e.type);
    expect(types).toContain("execution.failed");
    expect(types).toContain("execution.cleaned");
  });

  it("cleanup failure is recorded and retryable, never hidden", async () => {
    const { executions, events, driver, manager, request } = await setup({
      cleanupFailures: 1,
    });
    const environment = await manager.prepare(request);

    const failed = await manager.cleanup(environment);
    expect(failed?.status).toBe("CLEANUP_FAILED");
    expect(driver.cleanupCalls).toBe(1);
    expect(
      (await events.listEvents({ runId: "run-001" })).map((e) => e.type),
    ).toContain("execution.cleanup_failed");

    const retried = await manager.cleanupRecord(failed!);
    expect(retried?.status).toBe("CLEANED");
    expect(driver.cleanupCalls).toBe(2);
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe("CLEANED");
  });

  it("cleanup is idempotent once CLEANED", async () => {
    const { driver, manager, request } = await setup();
    const environment = await manager.prepare(request);

    await manager.cleanup(environment);
    await manager.cleanup(environment);

    expect(driver.cleanupCalls).toBe(1);
  });

  it("finish records terminal status before cleanup", async () => {
    const { executions, manager, request } = await setup({ containerId: "ctr-1" });
    const environment = await manager.prepare(request);
    await manager.finish(environment, "SUCCEEDED");

    expect((await executions.findLatestByRunId("run-001"))?.status).toBe("SUCCEEDED");
    const cleaned = await manager.cleanup(environment);
    expect(cleaned?.status).toBe("CLEANED");
    expect(cleaned?.containerId).toBe("ctr-1");
  });
});
