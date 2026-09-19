import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import { WorkspaceError } from "../src/errors.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
  type ExecutionDriver,
} from "../src/execution/manager.js";
import { buildDockerRunArgs } from "../src/execution/dockerArgs.js";
import { Loop } from "../src/loop/loop.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryExecutionStore } from "../src/store/inMemoryExecutionStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { commitFile, createGitFixture, type GitFixture } from "./helpers/gitFixture.js";

class ProbeEngine implements AgentEngine {
  calls = 0;

  constructor(private readonly contents: (string | undefined)[]) {}

  async execute(context: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    const exec = context.execution?.exec!;
    const workdirs = Object.values(context.execution?.workdirs ?? {});
    for (let index = 0; index < workdirs.length; index += 1) {
      const content = this.contents[index];
      if (!content) {
        continue;
      }
      await exec(["sh", "-lc", `printf '%s' '${content}' > solution.txt`], {
        cwd: workdirs[index],
      });
    }
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: "probe",
      stderr: "",
      startedAt: now,
      finishedAt: now,
    };
  }

  async cancel(): Promise<void> {}
}

class SlowEngine implements AgentEngine {
  private pending?: (result: AgentResult) => void;

  async execute(context: AgentContext): Promise<AgentResult> {
    void context;
    return new Promise<AgentResult>((resolve) => {
      this.pending = resolve;
    });
  }

  async cancel(): Promise<void> {
    const resolve = this.pending;
    this.pending = undefined;
    const now = new Date().toISOString();
    resolve?.({
      runId: "slow",
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      startedAt: now,
      finishedAt: now,
    });
  }
}

class FlakyWorkspaceManager extends WorkspaceManager {
  constructor(
    private readonly failFragment: string,
    options: { baseDir: string },
  ) {
    super(options);
  }

  async removeWorkspace(workspace: {
    path: string;
    repositoryLocalPath: string;
  }): Promise<void> {
    if (workspace.path.includes(this.failFragment)) {
      throw new WorkspaceError("simulated workspace cleanup failure");
    }
    return super.removeWorkspace(workspace);
  }
}

describe("Worker retry / recovery with multiple targets (TASK-1010)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function fixture(script: string, expected: string): GitFixture {
    const created = createGitFixture();
    cleanups.push(created.cleanup);
    commitFile(
      created.path,
      script,
      `test -f solution.txt && grep -qx '${expected}' solution.txt && echo ok\n`,
    );
    return created;
  }

  async function setup(options: {
    engine: AgentEngine;
    workspaceManager?: WorkspaceManager;
    executionTimeoutMs?: number;
    driver?: ExecutionDriver;
  }) {
    const fixtureA = fixture("check-a.sh", "A-OK");
    const fixtureB = fixture("check-b.sh", "B-OK");
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-recovery-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));
    const workspaceManager =
      options.workspaceManager ?? new WorkspaceManager({ baseDir: workspaceBase });

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionStore();
    await repositories.createRepository({
      id: "repo-a",
      name: "rehelu",
      url: "git@github.com:example/rehelu.git",
      localPath: fixtureA.path,
      verificationCommands: ["sh check-a.sh"],
      executionProfile: defaultExecutionProfile(),
    });
    await repositories.createRepository({
      id: "repo-b",
      name: "auth",
      url: "git@github.com:example/auth.git",
      localPath: fixtureB.path,
      verificationCommands: ["sh check-b.sh"],
      executionProfile: defaultExecutionProfile(),
    });
    await tasks.createTask({
      id: "task-001",
      title: "multi",
      status: "READY",
      maxAttempts: 3,
      targets: [
        { id: "tgt-a", taskId: "task-001", repositoryId: "repo-a", role: "primary", position: 0 },
        { id: "tgt-b", taskId: "task-001", repositoryId: "repo-b", role: "supporting", position: 1 },
      ],
    });

    const executionManager = new ExecutionManager({
      driver: options.driver ?? new LocalExecutionDriver(),
      executions,
      events,
    });
    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager,
      agentEngine: options.engine,
      verifier: new Verifier(),
      executionManager,
      eventStore: events,
      workerId: "worker-recovery",
      heartbeatMs: 50,
      leaseSeconds: 1,
      executionTimeoutMs: options.executionTimeoutMs,
    });
    return {
      fixtureA,
      fixtureB,
      workspaceBase,
      workspaceManager,
      repositories,
      tasks,
      runs,
      events,
      executions,
      executionManager,
      worker,
    };
  }

  it("cleans every target workspace when verification fails", async () => {
    const { runs, events, worker } = await setup({
      engine: new ProbeEngine(["A-OK", undefined]),
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    for (const workspace of outcome.workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    const cleaned = await events.listEvents({ runId: "run-001", type: "workspaces.cleaned" });
    expect(cleaned).toHaveLength(1);
    expect((cleaned[0]?.payload as { removed: string[] }).removed).toHaveLength(2);
  });

  it("cleans every target workspace when the agent fails", async () => {
    const { runs, worker } = await setup({ engine: new ProbeEngine([undefined, undefined]) });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    for (const workspace of outcome.workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
  });

  it("records workspaces on timeout and cleans them up", async () => {
    const { runs, worker } = await setup({
      engine: new SlowEngine(),
      executionTimeoutMs: 150,
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });

    await expect(worker.executeRun("run-001")).rejects.toThrow(/timed_out/);

    const run = await runs.findRun("run-001");
    expect(run.status).toBe("TIMED_OUT");
    const result = run.result as {
      workspaces: { targetId: string; path: string; branch: string }[];
    };
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces.map((workspace) => workspace.targetId)).toEqual([
      "tgt-a",
      "tgt-b",
    ]);
    for (const workspace of result.workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
  });

  it("records workspaces on cancel and cleans them up", async () => {
    const { runs, events, worker } = await setup({ engine: new SlowEngine() });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });
    const controller = new AbortController();

    const promise = worker.executeRun("run-001", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);

    const run = await runs.findRun("run-001");
    expect(run.status).toBe("CANCELLED");
    const result = run.result as { workspaces: { path: string }[] };
    expect(result.workspaces).toHaveLength(2);
    for (const workspace of result.workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    expect(
      (await events.listEvents({ runId: "run-001" })).map((event) => event.type),
    ).toContain("RunCancelled");
  });

  it("never reuses workspaces on retry (new Run = new directories and branches)", async () => {
    const engine = new ProbeEngine(["A-OK", undefined]);
    const { runs, tasks, worker } = await setup({ engine });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });
    const first = await worker.executeRun("run-001");
    expect(first.run.status).toBe("FAILED");
    const firstPaths = first.workspaces.map((workspace) => workspace.path);
    const firstBranches = first.workspaces.map((workspace) => workspace.branch);

    // The failing attempt cleaned up after itself, and the task is READY again.
    expect((await tasks.findTask("task-001")).status).toBe("READY");
    expect(firstPaths.every((path) => !existsSync(path))).toBe(true);

    // Retry: a brand new Run with brand new workspaces (and a passing agent).
    engine.contents = ["A-OK", "B-OK"];
    await runs.createRun({ id: "run-002", taskId: "task-001", attempt: 2, agent: "codex", engine: "codex" });
    const second = await worker.executeRun("run-002");
    expect(second.run.status).toBe("SUCCEEDED");
    const secondPaths = second.workspaces.map((workspace) => workspace.path);
    expect(secondPaths.some((path) => firstPaths.includes(path))).toBe(false);
    expect(second.workspaces.map((workspace) => workspace.branch)).not.toEqual(
      firstBranches,
    );
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");
  });

  it("cleans execution and all workspaces when a worker crashes (lease expiry)", async () => {
    const {
      repositories,
      tasks,
      runs,
      events,
      executions,
      executionManager,
      workspaceManager,
      worker,
      fixtureA,
      fixtureB,
    } = await setup({ engine: new ProbeEngine([undefined, undefined]) });

    const workspaces = await workspaceManager.createRunWorkspaces({
      taskId: "task-001",
      runId: "run-001",
      targets: [
        { targetId: "tgt-a", repositoryLocalPath: fixtureA.path, position: 0 },
        { targetId: "tgt-b", repositoryLocalPath: fixtureB.path, position: 1 },
      ],
    });
    await executionManager.prepare({
      runId: "run-001",
      profile: defaultExecutionProfile(),
      mounts: [
        { targetId: "tgt-a", source: workspaces[0]!.path, target: "/workspace", primary: true },
        { targetId: "tgt-b", source: workspaces[1]!.path, target: "/workspaces/tgt-b" },
      ],
      primaryTargetId: "tgt-a",
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });
    await runs.claimRun("run-001", "worker-dead", "2000-01-01T00:00:00.000Z");
    await runs.markRunning("run-001", "2000-01-01T00:00:00.000Z");
    await tasks.updateTaskStatus("task-001", "RUNNING");

    const loop = new Loop({
      scheduler: new Scheduler({ taskStore: tasks, runStore: runs }),
      worker,
      runStore: runs,
      taskStore: tasks,
      eventStore: events,
      executions,
      executionManager,
      repositories,
      workspaceManager,
      maxConcurrency: 1,
    });

    const report = await loop.tick();

    expect(report.recovered.map((run) => run.id)).toEqual(["run-001"]);
    expect((await runs.findRun("run-001")).status).toBe("LOST");
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe("CLEANED");
    // The loop retried immediately; that retry also failed (probe writes
    // nothing), so the task is READY for another attempt.
    const allRuns = await runs.listRuns({ taskId: "task-001" });
    expect(allRuns.map((run) => run.status)).toEqual(["LOST", "FAILED"]);
    expect((await tasks.findTask("task-001")).status).toBe("READY");
    for (const workspace of workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    const cleaned = await events.listEvents({ runId: "run-001", type: "workspaces.cleaned" });
    expect((cleaned[0]?.payload as { removed: string[] }).removed).toHaveLength(2);
  });

  it("does not lose other targets when one workspace cleanup fails", async () => {
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-recovery-flaky-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));
    const { runs, events, worker } = await setup({
      engine: new ProbeEngine(["A-OK", undefined]),
      workspaceManager: new FlakyWorkspaceManager("tgt-b", { baseDir: workspaceBase }),
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    expect(existsSync(outcome.workspaces[0]!.path)).toBe(false);
    expect(existsSync(outcome.workspaces[1]!.path)).toBe(true);
    const cleaned = await events.listEvents({ runId: "run-001", type: "workspaces.cleaned" });
    const payload = cleaned[0]?.payload as {
      removed: string[];
      skipped: { path: string; reason: string }[];
    };
    expect(payload.removed).toHaveLength(1);
    expect(payload.skipped[0]?.reason).toContain("simulated workspace cleanup failure");
  });
});
