import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
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
      ...extra,
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
