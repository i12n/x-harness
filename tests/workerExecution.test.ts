import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import type { ExecutionEnvironment, ExecutionRequest } from "../src/execution/manager.js";
import { ExecutionManager } from "../src/execution/manager.js";
import type { ExecutionDriver } from "../src/execution/manager.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { commitFile, createGitFixture, type GitFixture } from "./helpers/gitFixture.js";

const WRITE_CODE = [
  "process.stdin.resume();",
  "process.stdin.on('end', () => {",
  "  require('fs').writeFileSync('solution.txt', 'avatar upload implemented');",
  "  console.log('changes made');",
  "});",
].join("");

class RecordingDriver implements ExecutionDriver {
  readonly calls: string[] = [];
  environment?: ExecutionEnvironment;

  constructor(
    private readonly options: { containerId?: string; workdir?: string } = {},
  ) {}

  async create(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    this.calls.push("create");
    this.environment = {
      id: `recording-${request.runId}`,
      runId: request.runId,
      workspacePath: resolve(request.workspacePath),
      containerWorkspace: this.options.workdir ?? resolve(request.workspacePath),
      profile: request.profile,
      driver: "recording",
      containerId: this.options.containerId,
    };
    return this.environment;
  }

  async start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment> {
    this.calls.push("start");
    return { ...environment, startedAt: new Date().toISOString() };
  }

  async cleanup(): Promise<void> {
    this.calls.push("cleanup");
  }
}

describe("Worker + ExecutionManager (TASK-902)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function setup(
    driver: ExecutionDriver,
    verificationCommands: string[],
    existingFixture?: GitFixture,
  ) {
    const fixture: GitFixture = existingFixture ?? createGitFixture();
    if (!existingFixture) {
      cleanups.push(fixture.cleanup);
    }
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
      verificationCommands,
    });
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "Add user avatar",
      status: "READY",
      acceptance: ["Tests pass"],
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
      agentEngine: new CodexEngine({
        executable: process.execPath,
        spawnArgs: () => ["-e", WRITE_CODE],
      }),
      verifier: new Verifier(),
      executionManager: new ExecutionManager(driver),
      eventStore: events,
      workerId: "worker-902",
      heartbeatMs: 50,
      leaseSeconds: 1,
    });
    return { tasks, runs, events, worker };
  }

  it("goes Worker -> ExecutionManager -> Agent -> Verification and cleans up", async () => {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(fixture.path, "checks.sh", "test -f solution.txt && echo ok\n");
    const driver = new RecordingDriver();
    const { runs, events, worker } = await setup(driver, ["sh checks.sh"], fixture);

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    expect(driver.calls).toEqual(["create", "start", "cleanup"]);
    expect(driver.environment?.driver).toBe("recording");
    expect(existsSync(join(outcome.workspace.path, "solution.txt"))).toBe(true);

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
    void runs;
  });

  it("runs agent and verification inside the execution workdir", async () => {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    const isolatedWorkdir = mkdtempSync(join(tmpdir(), "ai-exec-workdir-"));
    cleanups.push(() => rmSync(isolatedWorkdir, { recursive: true, force: true }));
    writeFileSync(join(isolatedWorkdir, "checks.sh"), "test -f solution.txt && echo ok\n");

    const driver = new RecordingDriver({ workdir: isolatedWorkdir });
    const { worker } = await setup(driver, ["sh checks.sh"]);

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    // The fake agent and the verifier both used the execution workdir, not the
    // worktree path itself.
    expect(existsSync(join(isolatedWorkdir, "solution.txt"))).toBe(true);
    expect(existsSync(join(outcome.workspace.path, "solution.txt"))).toBe(false);
  });

  it("refuses containerized execution until a container-aware agent exists", async () => {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(fixture.path, "checks.sh", "echo ok\n");
    const driver = new RecordingDriver({ containerId: "fake-container" });
    const { runs, worker } = await setup(driver, ["sh checks.sh"], fixture);

    await expect(worker.executeRun("run-001")).rejects.toThrow(/TASK-910/);

    expect((await runs.findRun("run-001")).status).toBe("FAILED");
    expect(driver.calls).toEqual(["create", "start", "cleanup"]);
  });
});
