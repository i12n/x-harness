import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import { Loop } from "../src/loop/loop.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryExecutionStore } from "../src/store/inMemoryExecutionStore.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
  type ExecutionDriver,
  type ExecutionEnvironment,
  type ExecutionRequest,
} from "../src/execution/manager.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import {
  commitFile,
  createGitFixture,
  type GitFixture,
} from "./helpers/gitFixture.js";

const WRITE_CODE = [
  "process.stdin.resume();",
  "process.stdin.on('end', () => {",
  "  require('fs').writeFileSync('solution.txt', 'avatar upload implemented');",
  "  console.log('changes made');",
  "});",
].join("");

const IDLE_CODE =
  "process.stdin.resume(); process.stdin.on('end', () => console.log('done'));";

class CrashDriver extends LocalExecutionDriver implements ExecutionDriver {
  readonly name = "crash";
  cleanupCalls = 0;
  private cleanupFailures: number;

  constructor(cleanupFailures = 0) {
    super();
    this.cleanupFailures = cleanupFailures;
  }

  async create(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    return {
      id: `crash-${request.runId}`,
      runId: request.runId,
      workspacePath: request.workspacePath,
      containerWorkspace: request.workspacePath,
      profile: request.profile,
      driver: this.name,
      containerId: "ctr-crash-1",
    };
  }

  async start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment> {
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

describe("Loop", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function setup(engineCode: string, maxAttempts = 3) {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(fixture.path, "checks.sh", "test -f solution.txt && echo ok\n");
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    await repositories.createRepository({
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
      localPath: fixture.path,
      verificationCommands: ["sh checks.sh"],
    });
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "Add user avatar",
      description: "Allow users to upload avatars.",
      status: "READY",
      acceptance: ["Tests pass"],
      maxAttempts,
    });
    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      agentEngine: new CodexEngine({
        executable: process.execPath,
        spawnArgs: () => ["-e", engineCode],
      }),
      verifier: new Verifier(),
      workerId: "worker-loop",
      heartbeatMs: 50,
      leaseSeconds: 1,
    });
    const scheduler = new Scheduler({
      taskStore: tasks,
      runStore: runs,
      maxConcurrency: 2,
    });
    const loop = new Loop({
      scheduler,
      worker,
      runStore: runs,
      taskStore: tasks,
      maxConcurrency: 2,
      eventStore: events,
    });
    return { tasks, runs, events, loop, scheduler, worker };
  }

  it("schedules, executes, verifies and moves a task to REVIEW in one tick", async () => {
    const { tasks, runs, loop } = await setup(WRITE_CODE);

    const report = await loop.tick();

    expect(report.scheduled).toHaveLength(1);
    expect(report.executed).toHaveLength(1);
    // TASK-1206: without a delivery reconciler the tick is unchanged.
    expect(report.deliveryTransitions).toEqual([]);
    expect(report.deliveryNotifications).toBe(0);
    expect(report.deliveryNotificationFailures).toEqual([]);
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");
    const created = await runs.listRuns({ taskId: "task-001" });
    expect(created[0]?.status).toBe("SUCCEEDED");
  });

  it("runs delivery reconciliation twice per tick and reports transitions (TASK-1206)", async () => {
    const { tasks, runs, events, scheduler, worker } = await setup(WRITE_CODE);
    let calls = 0;
    const loop = new Loop({
      scheduler,
      worker,
      runStore: runs,
      taskStore: tasks,
      maxConcurrency: 2,
      eventStore: events,
      deliveryReconciler: {
        reconcileAll: async () => {
          calls += 1;
          // The second pass sees no transition, exactly like the real one.
          const first = calls === 1;
          return {
            transitions: first
              ? [
                  {
                    delivery: { id: "dlv-001" },
                    previousStatus: "IN_PROGRESS",
                    status: "READY_FOR_RELEASE",
                  },
                ]
              : [],
            notified: first ? 1 : 0,
            notificationFailures: [],
            pendingNotifications: 0,
          };
        },
      },
    });

    const report = await loop.tick();

    // Once before scheduling, once after execution (same-tick detection).
    expect(calls).toBe(2);
    expect(report.deliveryTransitions.map((entry) => entry.delivery.id)).toEqual([
      "dlv-001",
    ]);
    expect(report.deliveryNotifications).toBe(1);
    expect(report.deliveryNotificationFailures).toEqual([]);
  });

  it("retries failed runs until the task is BLOCKED at max attempts", async () => {
    const { tasks, runs, loop } = await setup(IDLE_CODE, 3);

    for (let tick = 0; tick < 4; tick += 1) {
      await loop.tick();
      const task = await tasks.findTask("task-001");
      if (task.status !== "READY") {
        break;
      }
    }

    const finalTask = await tasks.findTask("task-001");
    const allRuns = await runs.listRuns({ taskId: "task-001" });
    expect(finalTask.status).toBe("BLOCKED");
    expect(allRuns).toHaveLength(3);
    expect(allRuns.map((run) => run.status)).toEqual(["FAILED", "FAILED", "FAILED"]);
  });

  it("recovers runs whose lease expired and releases the task", async () => {
    const { tasks, runs, events, loop } = await setup(IDLE_CODE);
    await runs.createRun({
      id: "run-expired",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await runs.claimRun("run-expired", "worker-dead", "2000-01-01T00:00:00.000Z");
    await runs.markRunning("run-expired", "2000-01-01T00:00:00.000Z");
    await tasks.updateTaskStatus("task-001", "RUNNING");

    const report = await loop.tick();

    expect(report.recovered.map((run) => run.id)).toEqual(["run-expired"]);
    expect((await runs.findRun("run-expired")).status).toBe("LOST");
    expect((await tasks.findTask("task-001")).status).toBe("READY");
    expect(
      (await events.listEvents({ runId: "run-expired", type: "RunLost" })).map((e) => e.type),
    ).toEqual(["RunLost"]);
  });

  async function crashedRun(cleanupFailures = 0) {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionStore();
    await repositories.createRepository({
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
      localPath: fixture.path,
      verificationCommands: [],
    });
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "crashed task",
      description: "d",
      acceptance: ["a"],
      status: "RUNNING",
      maxAttempts: 3,
    });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await runs.claimRun("run-001", "worker-dead", "2000-01-01T00:00:00.000Z");
    await runs.markRunning("run-001", "2000-01-01T00:00:00.000Z");

    const driver = new CrashDriver(cleanupFailures);
    const executionManager = new ExecutionManager({ driver, executions, events });
    await executionManager.prepare({
      runId: "run-001",
      workspacePath: fixture.path,
      profile: defaultExecutionProfile(),
    });

    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      agentEngine: new CodexEngine({
        executable: process.execPath,
        spawnArgs: () => ["-e", IDLE_CODE],
      }),
      verifier: new Verifier(),
      workerId: "worker-loop",
      heartbeatMs: 50,
      leaseSeconds: 1,
    });
    const loop = new Loop({
      scheduler: new Scheduler({ taskStore: tasks, runStore: runs }),
      worker,
      runStore: runs,
      taskStore: tasks,
      eventStore: events,
      executions,
      executionManager,
      maxConcurrency: 1,
    });
    return { tasks, runs, events, executions, driver, loop };
  }

  it("recovers a crashed worker by finishing and cleaning its execution", async () => {
    const { tasks, runs, events, executions, driver, loop } = await crashedRun();

    const report = await loop.tick();

    expect(report.recovered.map((run) => run.id)).toEqual(["run-001"]);
    expect((await runs.findRun("run-001")).status).toBe("LOST");
    expect((await tasks.findTask("task-001")).status).toBe("READY");
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe("CLEANED");
    expect(driver.cleanupCalls).toBe(1);
    const types = (await events.listEvents({ runId: "run-001" })).map((e) => e.type);
    expect(types).toContain("execution.cleaned");
  });

  it("retries cleanup failures on later ticks until the execution is CLEANED", async () => {
    const { executions, driver, loop } = await crashedRun(2);

    await loop.tick();
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe(
      "CLEANUP_FAILED",
    );
    expect(driver.cleanupCalls).toBe(2);

    const second = await loop.tick();
    expect(second.cleanupRetries).toBeGreaterThanOrEqual(1);
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe("CLEANED");
    expect(driver.cleanupCalls).toBe(3);
  });
});
