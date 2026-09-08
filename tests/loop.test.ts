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
    });
    return { tasks, runs, loop };
  }

  it("schedules, executes, verifies and moves a task to REVIEW in one tick", async () => {
    const { tasks, runs, loop } = await setup(WRITE_CODE);

    const report = await loop.tick();

    expect(report.scheduled).toHaveLength(1);
    expect(report.executed).toHaveLength(1);
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");
    const created = await runs.listRuns({ taskId: "task-001" });
    expect(created[0]?.status).toBe("SUCCEEDED");
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
    const { tasks, runs, loop } = await setup(IDLE_CODE);
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
  });
});
