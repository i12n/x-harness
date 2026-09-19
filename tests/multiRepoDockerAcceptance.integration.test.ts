// TASK-1012 Phase 10 Release Gate: multi-repository E2E on real Docker.
//
//   AI_TEST_DOCKER=1 AI_EXECUTION_IMAGE=harness/execution:node22 \
//     npx vitest run tests/multiRepoDockerAcceptance.integration.test.ts
//
// Verifies DB state == execution state == Docker resources == git worktrees.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { cleanupWorkspacesCommand } from "../src/cli/commands/workspaceCommands.js";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import { WorkspaceError } from "../src/errors.js";
import {
  DockerExecutionDriver,
  ExecutionManager,
  type ExecutionDriver,
} from "../src/execution/manager.js";
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

const execFileAsync = promisify(execFile);
const dockerEnabled = process.env.AI_TEST_DOCKER === "1";
const image = process.env.AI_EXECUTION_IMAGE ?? "";
const describeGate = dockerEnabled && image ? describe : describe.skip;

async function docker(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync("docker", args);
    return { stdout, code: 0 };
  } catch {
    return { stdout: "", code: 1 };
  }
}

async function labeledContainers(): Promise<string[]> {
  const { stdout } = await docker([
    "ps",
    "-a",
    "--filter",
    "label=ai-harness.run-id",
    "--format",
    "{{.Names}}",
  ]);
  return stdout.trim().split("\n").filter(Boolean);
}

async function harnessNetworks(): Promise<string[]> {
  const { stdout } = await docker([
    "network",
    "ls",
    "--filter",
    "name=ai-net-",
    "--format",
    "{{.Name}}",
  ]);
  return stdout.trim().split("\n").filter(Boolean);
}

async function proxyContainers(): Promise<string[]> {
  const { stdout } = await docker([
    "ps",
    "-a",
    "--filter",
    "name=ai-proxy-",
    "--format",
    "{{.Names}}",
  ]);
  return stdout.trim().split("\n").filter(Boolean);
}

async function containerGone(containerId: string | undefined): Promise<boolean> {
  if (!containerId) {
    return true;
  }
  return (await docker(["inspect", "--format", "{{.Id}}", containerId])).code !== 0;
}

/** Writes solution files into the target workdirs, in target order. */
class ProbeEngine implements AgentEngine {
  calls = 0;
  constructor(public contents: (string | undefined)[]) {}

  async execute(context: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    const exec = context.execution?.exec;
    if (!exec) {
      throw new Error("probe engine requires execution.exec");
    }
    const workdirs = Object.values(context.execution?.workdirs ?? {});
    for (let index = 0; index < workdirs.length; index += 1) {
      const content = this.contents[index];
      if (!content) {
        continue;
      }
      const result = await exec(
        ["sh", "-lc", `printf '%s' '${content}' > solution.txt`],
        { cwd: workdirs[index] },
      );
      if (result.exitCode !== 0) {
        throw new Error(`probe write failed in ${workdirs[index]}: ${result.stderr}`);
      }
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

describeGate("TASK-1012 multi-repository release gate (real Docker)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    for (const name of await labeledContainers()) {
      await docker(["rm", "-f", name]);
    }
    for (const name of await proxyContainers()) {
      await docker(["rm", "-f", name]);
    }
    for (const name of await harnessNetworks()) {
      await docker(["network", "rm", name]);
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
    networkMode?: "none" | "restricted";
    executionTimeoutMs?: number;
    workspaceManager?: WorkspaceManager;
    workspaceBase?: string;
    driver?: ExecutionDriver;
    singleRepository?: boolean;
  }) {
    const fixtureA = fixture("check-a.sh", "A-OK");
    const fixtureB = options.singleRepository ? undefined : fixture("check-b.sh", "B-OK");
    const workspaceBase =
      options.workspaceBase ?? mkdtempSync(join(tmpdir(), "ai-phase10-"));
    if (!options.workspaceBase) {
      cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));
    }
    const workspaceManager =
      options.workspaceManager ?? new WorkspaceManager({ baseDir: workspaceBase });

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionStore();
    const profile = buildExecutionProfile({
      name: "acceptance",
      image,
      network: { mode: options.networkMode ?? "none" },
      resources: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
    });
    await repositories.createRepository({
      id: "repo-a",
      name: "rehelu",
      url: "git@github.com:example/rehelu.git",
      localPath: fixtureA.path,
      verificationCommands: ["sh check-a.sh"],
      executionProfile: profile,
    });
    if (fixtureB) {
      await repositories.createRepository({
        id: "repo-b",
        name: "auth",
        url: "git@github.com:example/auth.git",
        localPath: fixtureB.path,
        verificationCommands: ["sh check-b.sh"],
        executionProfile: profile,
      });
    }
    await tasks.createTask({
      id: "task-001",
      title: "phase 10 gate",
      status: "READY",
      maxAttempts: 3,
      targets: [
        { id: "tgt-a", taskId: "task-001", repositoryId: "repo-a", role: "primary", position: 0 },
        ...(fixtureB
          ? [
              {
                id: "tgt-b",
                taskId: "task-001",
                repositoryId: "repo-b",
                role: "supporting" as const,
                position: 1,
              },
            ]
          : []),
      ],
    });
    const executionManager = new ExecutionManager({
      driver:
        options.driver ??
        new DockerExecutionDriver({ workspaceRoots: [workspaceBase] }),
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
      workerId: "worker-gate",
      heartbeatMs: 2_000,
      leaseSeconds: 180,
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
      profile,
    };
  }

  it("normal dual-repo: two mounts, one agent, SUCCEEDED, container cleaned", async () => {
    const engine = new ProbeEngine(["A-OK", "B-OK"]);
    const { runs, executions, worker } = await setup({ engine });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    expect(engine.calls).toBe(1);
    expect(outcome.workspaces).toHaveLength(2);
    expect(outcome.workspaces[0]?.branch).toBe("ai/task-001-run-001-t0");
    expect(outcome.workspaces[1]?.branch).toBe("ai/task-001-run-001-t1");
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(record?.mounts?.map((mount) => mount.target)).toEqual([
      "/workspace",
      "/workspaces/tgt-b",
    ]);
    expect(await containerGone(record?.containerId)).toBe(true);
    expect(await labeledContainers()).toEqual([]);
    // Success keeps workspaces for Review (TASK-1009 semantics).
    expect(existsSync(outcome.workspaces[0]!.path)).toBe(true);
    expect(existsSync(outcome.workspaces[1]!.path)).toBe(true);
  }, 600_000);

  it("target verification failure: FAILED, all workspaces and network resources cleaned", async () => {
    const engine = new ProbeEngine(["A-OK", undefined]);
    const { runs, executions, events, worker } = await setup({
      engine,
      networkMode: "restricted",
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    expect(outcome.targets.map((target) => target.passed)).toEqual([true, false]);
    for (const workspace of outcome.workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe("CLEANED");
    expect(await labeledContainers()).toEqual([]);
    expect(await proxyContainers()).toEqual([]);
    expect(await harnessNetworks()).toEqual([]);
    const cleaned = (await events.listEvents({ runId: "run-001", type: "workspaces.cleaned" }))[0]
      ?.payload as { removed: string[] };
    expect(cleaned.removed).toHaveLength(2);
  }, 600_000);

  it("agent failure: FAILED and every workspace cleaned", async () => {
    const { runs, worker } = await setup({ engine: new ProbeEngine([undefined, undefined]) });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });
    const outcome = await worker.executeRun("run-001");
    expect(outcome.run.status).toBe("FAILED");
    for (const workspace of outcome.workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    expect(await labeledContainers()).toEqual([]);
  }, 600_000);

  it("timeout: TIMED_OUT with workspace evidence, resources cleaned", async () => {
    const { runs, executions, worker } = await setup({
      engine: new SlowEngine(),
      executionTimeoutMs: 3_000,
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });
    await expect(worker.executeRun("run-001")).rejects.toThrow(/timed_out/);

    const run = await runs.findRun("run-001");
    expect(run.status).toBe("TIMED_OUT");
    const workspaces = (run.result as { workspaces: { path: string }[] }).workspaces;
    expect(workspaces).toHaveLength(2);
    for (const workspace of workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe("CLEANED");
    expect(await labeledContainers()).toEqual([]);
  }, 600_000);

  it("cancel: CANCELLED with workspace evidence, resources cleaned", async () => {
    const { runs, worker } = await setup({ engine: new SlowEngine() });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });
    const controller = new AbortController();
    const promise = worker.executeRun("run-001", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);

    const run = await runs.findRun("run-001");
    expect(run.status).toBe("CANCELLED");
    for (const workspace of (run.result as { workspaces: { path: string }[] }).workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    expect(await labeledContainers()).toEqual([]);
  }, 600_000);

  it("worker crash: recovery uses persisted execution mounts and cleans everything", async () => {
    const {
      fixtureA,
      fixtureB,
      repositories,
      tasks,
      runs,
      events,
      executions,
      executionManager,
      workspaceManager,
      worker,
      profile,
    } = await setup({ engine: new ProbeEngine(["A-OK", "B-OK"]) });
    const workspaces = await workspaceManager.createRunWorkspaces({
      taskId: "task-001",
      runId: "run-001",
      targets: [
        { targetId: "tgt-a", repositoryLocalPath: fixtureA.path, position: 0 },
        { targetId: "tgt-b", repositoryLocalPath: fixtureB!.path, position: 1 },
      ],
    });
    await executionManager.prepare({
      runId: "run-001",
      profile,
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
    // The crashed worker never wrote run.result: recovery must have used the
    // persisted execution mounts (2 of them).
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(record?.mounts).toHaveLength(2);
    expect(await containerGone(record?.containerId)).toBe(true);
    for (const workspace of workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    expect(await labeledContainers()).toEqual([]);
  }, 600_000);

  it("retry: new Run gets brand new workspaces and branches", async () => {
    const engine = new ProbeEngine(["A-OK", undefined]);
    const { runs, worker } = await setup({ engine });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });
    const first = await worker.executeRun("run-001");
    expect(first.run.status).toBe("FAILED");
    const firstPaths = first.workspaces.map((workspace) => workspace.path);

    engine.contents = ["A-OK", "B-OK"];
    await runs.createRun({ id: "run-002", taskId: "task-001", attempt: 2, agent: "codex", engine: "codex" });
    const second = await worker.executeRun("run-002");

    expect(second.run.status).toBe("SUCCEEDED");
    const secondPaths = second.workspaces.map((workspace) => workspace.path);
    expect(secondPaths.some((path) => firstPaths.includes(path))).toBe(false);
    expect(second.workspaces.map((workspace) => workspace.branch)).toEqual([
      "ai/task-001-run-002-t0",
      "ai/task-001-run-002-t1",
    ]);
  }, 600_000);

  it("cleanup failure: run status is not overwritten and other targets still cleaned", async () => {
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-phase10-flaky-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));
    const { runs, events, worker } = await setup({
      engine: new ProbeEngine(["A-OK", undefined]),
      workspaceManager: new FlakyWorkspaceManager("tgt-b", { baseDir: workspaceBase }),
      workspaceBase,
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    expect(existsSync(outcome.workspaces[0]!.path)).toBe(false);
    expect(existsSync(outcome.workspaces[1]!.path)).toBe(true);
    const payload = (await events.listEvents({ runId: "run-001", type: "workspaces.cleaned" }))[0]
      ?.payload as { removed: string[]; skipped: { reason: string }[] };
    expect(payload.removed).toHaveLength(1);
    expect(payload.skipped[0]?.reason).toContain("simulated workspace cleanup failure");
  }, 600_000);

  it("single-repository regression: one mount, one target, SUCCEEDED", async () => {
    const engine = new ProbeEngine(["A-OK"]);
    const { runs, executions, worker } = await setup({
      engine,
      singleRepository: true,
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    expect(outcome.workspaces).toHaveLength(1);
    expect(outcome.targets).toHaveLength(1);
    expect((await executions.findLatestByRunId("run-001"))?.mounts).toHaveLength(1);
    expect(await containerGone((await executions.findLatestByRunId("run-001"))?.containerId)).toBe(
      true,
    );
  }, 600_000);

  it("release gate: no harness containers, proxies or networks remain", async () => {
    const { runs, worker, workspaceManager, repositories, tasks } = await setup({
      engine: new ProbeEngine(["A-OK", "B-OK"]),
    });
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "codex", engine: "codex" });
    const outcome = await worker.executeRun("run-001");
    // Success keeps workspaces for Review: clean them explicitly, then the
    // gate must show zero residual resources of any kind.
    const report = await cleanupWorkspacesCommand({
      runs,
      tasks,
      repositories,
      workspaceManager,
    });
    expect(report.removed).toHaveLength(2);
    expect(outcome.run.status).toBe("SUCCEEDED");

    expect(await labeledContainers()).toEqual([]);
    expect(await proxyContainers()).toEqual([]);
    expect(await harnessNetworks()).toEqual([]);
    for (const workspace of outcome.workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
  }, 600_000);
});
