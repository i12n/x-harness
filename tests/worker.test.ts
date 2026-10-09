import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { readTaskReviews } from "../src/domain/task.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryExecutionStore } from "../src/store/inMemoryExecutionStore.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
} from "../src/execution/manager.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
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

describe("Worker", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function setup(
    engineCode: string,
    attempts = 3,
    extra: Partial<ConstructorParameters<typeof Worker>[0]> = {},
  ) {
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
      maxAttempts: attempts,
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
      executionManager: new ExecutionManager({
        driver: new LocalExecutionDriver(),
        executions: new InMemoryExecutionStore(),
        events,
      }),
      eventStore: events,
      workerId: "worker-test",
      heartbeatMs: 50,
      leaseSeconds: 1,
      // Caller overrides win (agentEngine, repairRounds, baseRefs…).
      ...extra,
    });
    return { fixture, repositories, tasks, runs, events, worker };
  }

  // TASK-1245: the base ref is resolved (fetch + origin/<branch>) before the
  // worktree is cut, and the chosen commit is recorded for staleness audits.
  it("cuts the worktree from the resolved base ref and records it", async () => {
    const asked: (string | undefined)[] = [];
    const { runs, worker, events } = await setup(WRITE_CODE, 3, {
      baseRefs: {
        prepareBaseRef: async (_repository, baseRef) => {
          asked.push(baseRef);
          return { ref: "main", sha: "deadbeef", fetched: true };
        },
      },
    });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    // The Task carries no explicit base ref, so the repository default is used.
    expect(asked).toEqual([undefined]);
    const recorded = await events.listEvents({ type: "WorkspaceBaseResolved" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      ref: "main",
      sha: "deadbeef",
      fetched: true,
    });
  });

  /**
   * TASK-1247: an agent that can continue its own session gets one (or more)
   * repair turn(s) before the Run is called failed.
   */
  class RepairingEngine implements AgentEngine {
    readonly model = "stub";
    readonly continuations: { prompt: string; sessionId?: string }[] = [];
    constructor(
      private readonly firstPass: (workspace: string) => void,
      private readonly repair: (workspace: string) => void,
    ) {}
    async execute(context: AgentContext): Promise<AgentResult> {
      this.firstPass(context.workspacePath);
      return result(context.runId, "session-1");
    }
    async continue(
      context: AgentContext,
      prompt: string,
      options: { sessionId?: string } = {},
    ): Promise<AgentResult> {
      this.continuations.push({ prompt, ...options });
      this.repair(context.workspacePath);
      return result(context.runId, options.sessionId);
    }
    async cancel(): Promise<void> {}
  }

  const result = (runId: string, sessionId?: string): AgentResult => ({
    runId,
    exitCode: 0,
    signal: undefined,
    stdout: sessionId
      ? `{"type":"thread.started","thread_id":"${sessionId}"}`
      : "",
    stderr: "",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
  });

  it("repairs a failed verification in the same session instead of giving up", async () => {
    const engine = new RepairingEngine(
      () => {},
      (workspace) => writeFileSync(join(workspace, "solution.txt"), "fixed\n"),
    );
    const { runs, worker, events } = await setup(IDLE_CODE, 3, { agentEngine: engine });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    expect(engine.continuations).toHaveLength(1);
    // Same session, and the brief names the command that failed.
    expect(engine.continuations[0]!.sessionId).toBe("session-1");
    expect(engine.continuations[0]!.prompt).toContain("验证失败");
    expect(engine.continuations[0]!.prompt).toContain("sh checks.sh");
    const repairs = (await runs.findRun("run-001")).result?.repairs as
      | { round: number; passed: boolean }[]
      | undefined;
    expect(repairs).toEqual([{ round: 1, commands: ["sh checks.sh"], exitCode: 0, passed: true }]);
    const started = await events.listEvents({ type: "RepairStarted" });
    expect(started).toHaveLength(1);
  });

  it("does not burn repair turns on an environmental failure", async () => {
    const engine = new RepairingEngine(
      () => {},
      (workspace) => writeFileSync(join(workspace, "solution.txt"), "fixed\n"),
    );
    const { fixture, runs, worker, events } = await setup(IDLE_CODE, 3, {
      agentEngine: engine,
    });
    // A missing binary is not something the agent can fix by editing files.
    writeFileSync(join(fixture.path, "checks.sh"), "definitely-not-a-command\n");
    commitFile(fixture.path, "checks.sh", "definitely-not-a-command\n");
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    expect(engine.continuations).toHaveLength(0);
    expect(await events.listEvents({ type: "RepairSkipped" })).toHaveLength(1);
  });

  it("writes the failure onto the task so the next attempt knows what broke", async () => {
    const { tasks, runs, worker } = await setup(IDLE_CODE);
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    await worker.executeRun("run-001");

    const task = await tasks.findTask("task-001");
    expect(task.status).toBe("READY");
    const reviews = readTaskReviews(task);
    expect(reviews.at(-1)?.text).toContain("VERIFICATION FAILED");
    expect(reviews.at(-1)?.text).toContain("sh checks.sh");
  });

  it("claims, executes, verifies and completes a successful run", async () => {
    const { tasks, runs, worker } = await setup(WRITE_CODE);
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    expect(outcome.run.workerId).toBe("worker-test");
    expect(outcome.verification.passed).toBe(true);
    expect(outcome.task.status).toBe("REVIEW");
    expect(existsSync(join(outcome.workspace.path, "solution.txt"))).toBe(true);
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");
  });

  it("marks the run FAILED and returns the task to READY on verification failure", async () => {
    const { tasks, runs, worker } = await setup(IDLE_CODE);
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    expect(outcome.verification.passed).toBe(false);
    expect(outcome.task.status).toBe("READY");
  });

  it("blocks the task once max attempts are exhausted", async () => {
    const { tasks, runs, worker } = await setup(IDLE_CODE, 1);
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    await worker.executeRun("run-001");

    expect((await tasks.findTask("task-001")).status).toBe("BLOCKED");
  });

  it("records the full run lifecycle as events", async () => {
    const { events, runs, worker } = await setup(WRITE_CODE);
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    await worker.executeRun("run-001");

    const types = (await events.listEvents({ runId: "run-001" })).map((e) => e.type);
    expect(types).toEqual([
      "RunStarted",
      "execution.prepared",
      "AgentStarted",
      "AgentFinished",
      "VerificationStarted",
      "VerificationPassed",
      "RunSucceeded",
      "TaskReview",
      "execution.cleaned",
    ]);
  });

  it("records failure events when verification fails", async () => {
    const { events, runs, worker } = await setup(IDLE_CODE);
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    await worker.executeRun("run-001");

    const types = (await events.listEvents({ runId: "run-001" })).map((e) => e.type);
    expect(types).toContain("VerificationFailed");
    expect(types).toContain("RunFailed");
    expect(types).not.toContain("RunSucceeded");
  });
});
