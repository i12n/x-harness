import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { cleanupWorkspacesCommand } from "../src/cli/commands/workspaceCommands.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
  type ExecutionDriver,
  type ExecutionEnvironment,
  type ExecutionRequest,
} from "../src/execution/manager.js";
import type { ExecutionMount } from "../src/execution/mounts.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { commitFile, createGitFixture, type GitFixture } from "./helpers/gitFixture.js";

/** Writes the given contents into the target workdirs, in target order. */
class ProbeEngine implements AgentEngine {
  calls = 0;

  constructor(private readonly contents: (string | undefined)[]) {}

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
      await exec(["sh", "-lc", `printf '%s' '${content}' > solution.txt`], {
        cwd: workdirs[index],
      });
    }
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: "probe done",
      stderr: "",
      startedAt: now,
      finishedAt: now,
    };
  }

  async cancel(): Promise<void> {}
}

/** Records the mounts handed to the execution layer. */
class CapturingDriver extends LocalExecutionDriver implements ExecutionDriver {
  readonly name = "capturing";
  lastMounts: ExecutionMount[] = [];

  async create(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    this.lastMounts = request.mounts ?? [];
    return super.create(request);
  }
}

describe("Worker multi-repository execution (TASK-1009)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function fixture(scriptName: string, expected: string): GitFixture {
    const fixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(
      fixture.path,
      scriptName,
      `test -f solution.txt && grep -qx '${expected}' solution.txt && echo ok\n`,
    );
    return fixture;
  }

  async function setup(engine: AgentEngine, driver: ExecutionDriver = new LocalExecutionDriver()) {
    const fixtureA = fixture("check-a.sh", "A-OK");
    const fixtureB = fixture("check-b.sh", "B-OK");
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-multi-worker-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
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
      title: "multi repo change",
      description: "d",
      status: "READY",
      acceptance: ["both checks pass"],
      maxAttempts: 3,
      targets: [
        { id: "tgt-a", taskId: "task-001", repositoryId: "repo-a", role: "primary", position: 0 },
        { id: "tgt-b", taskId: "task-001", repositoryId: "repo-b", role: "supporting", position: 1 },
      ],
    });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      agentEngine: engine,
      verifier: new Verifier(),
      executionManager: new ExecutionManager({
        driver,
        executions: undefined,
        events,
      }),
      eventStore: events,
      workerId: "worker-multi",
      heartbeatMs: 50,
      leaseSeconds: 1,
    });
    return { repositories, tasks, runs, worker, fixtureA, fixtureB, workspaceBase };
  }

  it("creates one workspace and one mount per target, runs the agent once, aggregates PASS", async () => {
    const engine = new ProbeEngine(["A-OK", "B-OK"]);
    const driver = new CapturingDriver();
    const { runs, tasks, worker } = await setup(engine, driver);

    const outcome = await worker.executeRun("run-001");

    // 6. Agent executed exactly once for the whole Run.
    expect(engine.calls).toBe(1);
    // 2/3. two workspaces, one per target; branches are per target.
    expect(outcome.workspaces).toHaveLength(2);
    expect(outcome.workspaces.map((workspace) => workspace.targetId)).toEqual([
      "tgt-a",
      "tgt-b",
    ]);
    expect(outcome.workspaces[0]?.branch).toBe("ai/task-001-run-001-t0");
    expect(outcome.workspaces[1]?.branch).toBe("ai/task-001-run-001-t1");
    // 4/5. mounts: primary -> /workspace, supporting -> /workspaces/<targetId>.
    expect(driver.lastMounts.map((mount) => [mount.targetId, mount.target])).toEqual([
      ["tgt-a", "/workspace"],
      ["tgt-b", "/workspaces/tgt-b"],
    ]);
    // 7. both targets pass -> Run SUCCEEDED, task REVIEW.
    expect(outcome.run.status).toBe("SUCCEEDED");
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");
    // 10/11. per-target evidence recorded, scoped to its own repository.
    const result = (await runs.findRun("run-001")).result as {
      targets: { targetId: string; repositoryId: string; passed: boolean; commands: string[] }[];
      workspaces: { targetId: string }[];
    };
    expect(result.targets.map((target) => target.targetId)).toEqual(["tgt-a", "tgt-b"]);
    expect(result.targets.map((target) => target.repositoryId)).toEqual([
      "repo-a",
      "repo-b",
    ]);
    expect(result.targets.map((target) => target.commands)).toEqual([
      ["sh check-a.sh"],
      ["sh check-b.sh"],
    ]);
    expect(result.targets.every((target) => target.passed)).toBe(true);
    expect(result.workspaces).toHaveLength(2);
  });

  it("fails the Run when the supporting target fails (primary still passes)", async () => {
    const engine = new ProbeEngine(["A-OK", undefined]);
    const { runs, tasks, worker } = await setup(engine);

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    expect(outcome.targets.map((target) => target.passed)).toEqual([true, false]);
    expect((await tasks.findTask("task-001")).status).toBe("READY");
    const failed = await runs.findRun("run-001");
    const result = failed.result as { targets: { targetId: string; passed: boolean }[] };
    expect(result.targets[1]).toMatchObject({ targetId: "tgt-b", passed: false });
    const error = failed.error as { failingTargets: { targetId: string }[] };
    expect(error.failingTargets.map((target) => target.targetId)).toEqual(["tgt-b"]);
  });

  it("fails the Run when the primary target fails (supporting still passes)", async () => {
    const engine = new ProbeEngine([undefined, "B-OK"]);
    const { runs, worker } = await setup(engine);

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    expect(outcome.targets.map((target) => target.passed)).toEqual([false, true]);
    const error = (await runs.findRun("run-001")).error as {
      failingTargets: { targetId: string }[];
    };
    expect(error.failingTargets.map((target) => target.targetId)).toEqual(["tgt-a"]);
  });

  it("cleans up every workspace of a finished multi-target run", async () => {
    const engine = new ProbeEngine(["A-OK", "B-OK"]);
    const { repositories, tasks, runs, worker, workspaceBase } = await setup(engine);
    const outcome = await worker.executeRun("run-001");
    const paths = outcome.workspaces.map((workspace) => workspace.path);
    expect(paths.every((path) => existsSync(path))).toBe(true);

    const report = await cleanupWorkspacesCommand({
      runs,
      tasks,
      repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
    });

    expect(report.removed).toEqual(expect.arrayContaining(paths));
    expect(paths.every((path) => !existsSync(path))).toBe(true);
  });

  it("keeps the single-target path working unchanged", async () => {
    const engine = new ProbeEngine(["A-OK"]);
    const fixtureA = fixture("check-a.sh", "A-OK");
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-single-worker-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));
    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    await repositories.createRepository({
      id: "repo-a",
      name: "rehelu",
      url: "git@github.com:example/rehelu.git",
      localPath: fixtureA.path,
      verificationCommands: ["sh check-a.sh"],
    });
    await tasks.createTask({
      id: "task-single",
      repositoryId: "repo-a",
      title: "single",
      status: "READY",
      acceptance: ["check passes"],
    });
    await runs.createRun({
      id: "run-single",
      taskId: "task-single",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      agentEngine: engine,
      verifier: new Verifier(),
      executionManager: new ExecutionManager({
        driver: new LocalExecutionDriver(),
        executions: undefined,
        events,
      }),
      eventStore: events,
      workerId: "worker-single",
      heartbeatMs: 50,
      leaseSeconds: 1,
    });

    const outcome = await worker.executeRun("run-single");

    expect(outcome.run.status).toBe("SUCCEEDED");
    expect(outcome.workspaces).toHaveLength(1);
    expect(outcome.targets).toHaveLength(1);
    expect(outcome.targets[0]?.repositoryId).toBe("repo-a");
    expect(engine.calls).toBe(1);
  });
});
