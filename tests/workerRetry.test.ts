import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
} from "../src/execution/manager.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryExecutionStore } from "../src/store/inMemoryExecutionStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import {
  commitFile,
  createGitFixture,
  type GitFixture,
} from "./helpers/gitFixture.js";

const CHECK = "test -f solution.txt && grep -qx 'done' solution.txt && echo ok\n";

interface AgentRun {
  attempt: number;
  workdirs: string[];
  /** "clean" when a marker written to another target's workdir is invisible. */
  leakProbes: string[];
}

/** Writes `contents(attempt)` into every workdir; can probe target isolation. */
class AttemptEngine implements AgentEngine {
  readonly runs: AgentRun[] = [];

  constructor(
    private readonly contents: (attempt: number) => string,
    private readonly probeIsolation = false,
  ) {}

  async execute(context: AgentContext): Promise<AgentResult> {
    const exec = context.execution?.exec;
    if (!exec) {
      throw new Error("retry test agent requires execution.exec");
    }
    const attempt = this.runs.length + 1;
    const workdirs = Object.values(context.execution?.workdirs ?? {});
    const content = this.contents(attempt);
    const leakProbes: string[] = [];
    for (const workdir of workdirs) {
      await exec(["sh", "-lc", `printf '%s' '${content}' > solution.txt`], {
        cwd: workdir,
      });
    }
    if (this.probeIsolation && workdirs.length > 1) {
      for (const [index, workdir] of workdirs.entries()) {
        await exec(["sh", "-lc", `printf marker > marker-t${index}.txt`], {
          cwd: workdir,
        });
      }
      for (const [index, workdir] of workdirs.entries()) {
        const other = (index + 1) % workdirs.length;
        const probe = await exec(
          ["sh", "-lc", `[ -f marker-t${other}.txt ] && echo leak || echo clean`],
          { cwd: workdir },
        );
        leakProbes.push(probe.stdout.trim());
      }
    }
    this.runs.push({ attempt, workdirs, leakProbes });
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: `attempt ${attempt}`,
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

describe("Retry / workspace isolation (TASK-1207 Phase D)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function fixture(): GitFixture {
    const created = createGitFixture();
    cleanups.push(created.cleanup);
    commitFile(created.path, "check.sh", CHECK);
    return created;
  }

  async function harness(options: {
    engine: AgentEngine;
    multiTarget?: boolean;
    executionTimeoutMs?: number;
  }) {
    const fixtureA = fixture();
    const fixtureB = options.multiTarget ? fixture() : undefined;
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-retry-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionStore();

    await repositories.createRepository({
      id: "repo-a",
      name: "primary",
      url: "git@github.com:example/primary.git",
      localPath: fixtureA.path,
      verificationCommands: ["sh check.sh"],
      executionProfile: defaultExecutionProfile(),
    });
    if (fixtureB) {
      await repositories.createRepository({
        id: "repo-b",
        name: "supporting",
        url: "git@github.com:example/supporting.git",
        localPath: fixtureB.path,
        verificationCommands: ["sh check.sh"],
        executionProfile: defaultExecutionProfile(),
      });
    }
    await tasks.createTask({
      id: "task-001",
      title: "retry me",
      description: "d",
      acceptance: ["check passes"],
      status: "READY",
      maxAttempts: 3,
      targets: [
        { repositoryId: "repo-a", role: "primary", position: 0 },
        ...(fixtureB
          ? [{ repositoryId: "repo-b", role: "supporting" as const, position: 1 }]
          : []),
      ],
    });

    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      agentEngine: options.engine,
      verifier: new Verifier(),
      executionManager: new ExecutionManager({
        driver: new LocalExecutionDriver(),
        executions,
        events,
      }),
      eventStore: events,
      workerId: "worker-retry",
      heartbeatMs: 25,
      leaseSeconds: 5,
      executionTimeoutMs: options.executionTimeoutMs,
    });

    const createRun = async (runId: string) => {
      const existing = await runs.listRuns({ taskId: "task-001" });
      await runs.createRun({
        id: runId,
        taskId: "task-001",
        attempt: existing.length + 1,
        agent: "codex",
        engine: "codex",
      });
      return runId;
    };
    const attempt = async (runId: string) => {
      await createRun(runId);
      return worker.executeRun(runId);
    };

    return { tasks, runs, events, executions, worker, attempt, createRun };
  }

  function workspacePaths(run: { result?: unknown }): string[] {
    const result = run.result as
      | { workspaces?: { path: string }[]; workspace?: { path: string } }
      | undefined;
    if (result?.workspaces) {
      return result.workspaces.map((entry) => entry.path);
    }
    return result?.workspace ? [result.workspace.path] : [];
  }

  it("gives every retry a fresh workspace and cleans the failed attempt", async () => {
    const engine = new AttemptEngine((attempt) => (attempt === 1 ? "wrong" : "done"));
    const h = await harness({ engine });

    const first = await h.attempt("run-001");
    expect(first.run.status).toBe("FAILED");
    // Attempts remain → the existing retry policy returns the task to READY.
    await expect(h.tasks.findTask("task-001")).resolves.toMatchObject({ status: "READY" });

    const second = await h.attempt("run-002");
    expect(second.run.status).toBe("SUCCEEDED");
    await expect(h.tasks.findTask("task-001")).resolves.toMatchObject({ status: "REVIEW" });

    const firstPaths = workspacePaths(first.run);
    const secondPaths = workspacePaths(second.run);
    expect(firstPaths).toHaveLength(1);
    expect(secondPaths).toHaveLength(1);
    expect(firstPaths[0]).not.toBe(secondPaths[0]);
    // The failed attempt is cleaned up entirely: a later run cannot reuse it.
    expect(existsSync(firstPaths[0]!)).toBe(false);
    // The successful attempt keeps its workspace as the review artifact.
    expect(existsSync(secondPaths[0]!)).toBe(true);
  });

  it("keeps every target isolated and rotates workspaces per attempt", async () => {
    const engine = new AttemptEngine(
      (attempt) => (attempt === 1 ? "wrong" : "done"),
      true,
    );
    const h = await harness({ engine, multiTarget: true });

    const first = await h.attempt("run-001");
    expect(first.run.status).toBe("FAILED");
    expect(first.targets.map((target) => target.passed)).toEqual([false, false]);
    expect(engine.runs[0]?.leakProbes).toEqual(["clean", "clean"]);

    const second = await h.attempt("run-002");
    expect(second.run.status).toBe("SUCCEEDED");
    expect(engine.runs[1]?.leakProbes).toEqual(["clean", "clean"]);

    const attemptOne = workspacePaths(first.run);
    const attemptTwo = workspacePaths(second.run);
    expect(attemptOne).toHaveLength(2);
    expect(attemptTwo).toHaveLength(2);
    // A1 ≠ A2, B1 ≠ B2, A1 ≠ B1, A1 ≠ B2, B1 ≠ B2.
    const all = [...attemptOne, ...attemptTwo];
    expect(new Set(all).size).toBe(4);
    // The failed attempt left nothing behind for the retry to pick up.
    for (const path of attemptOne) {
      expect(existsSync(path)).toBe(false);
    }
    // The successful attempt keeps both workspaces for review.
    for (const path of attemptTwo) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("cleans every workspace of a timed-out multi-target attempt", async () => {
    const h = await harness({
      engine: new SlowEngine(),
      multiTarget: true,
      executionTimeoutMs: 150,
    });

    await h.createRun("run-001");
    await expect(h.worker.executeRun("run-001")).rejects.toThrow(/timed_out/);

    const timedOut = await h.runs.findRun("run-001");
    expect(timedOut.status).toBe("TIMED_OUT");
    await expect(h.tasks.findTask("task-001")).resolves.toMatchObject({ status: "READY" });
    for (const path of workspacePaths(timedOut)) {
      expect(existsSync(path)).toBe(false);
    }
    await expect(
      h.events.listEvents({ runId: "run-001", type: "RunTimedOut" }),
    ).resolves.toHaveLength(1);
  });

  it("keeps a lost run's cleanup on the Loop recovery path", async () => {
    const engine = new AttemptEngine(() => "done");
    const h = await harness({ engine });
    // A worker that died while holding the lease: STARTING + expired lease.
    await h.runs.createRun({
      id: "run-lost",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await h.runs.claimRun("run-lost", "dead-worker", "2000-01-01T00:00:00.000Z");
    await h.tasks.updateTaskStatus("task-001", "RUNNING");

    const { Loop } = await import("../src/loop/loop.js");
    const { Scheduler } = await import("../src/scheduler/scheduler.js");
    const loop = new Loop({
      scheduler: new Scheduler({ taskStore: h.tasks, runStore: h.runs, maxConcurrency: 1 }),
      worker: h.worker,
      runStore: h.runs,
      taskStore: h.tasks,
      eventStore: h.events,
      executions: h.executions,
      executionManager: new ExecutionManager({
        driver: new LocalExecutionDriver(),
        executions: h.executions,
        events: h.events,
      }),
      maxConcurrency: 1,
    });

    const report = await loop.tick();

    expect(report.recovered.map((run) => run.id)).toEqual(["run-lost"]);
    await expect(h.runs.findRun("run-lost")).resolves.toMatchObject({ status: "LOST" });
    // The same tick retried the recovered task with a brand-new workspace.
    // (The lost worker's own workspace cleanup, driven by execution mounts, is
    // covered by tests/loop.test.ts and tests/workerRecoveryMulti.test.ts.)
    const runs = await h.runs.listRuns({ taskId: "task-001" });
    expect(runs.map((run) => run.status)).toEqual(["LOST", "SUCCEEDED"]);
    const retryPath = workspacePaths(runs[1]!);
    expect(retryPath).toHaveLength(1);
    expect(existsSync(retryPath[0]!)).toBe(true);
    await expect(h.tasks.findTask("task-001")).resolves.toMatchObject({ status: "REVIEW" });
  });
});
