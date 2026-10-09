import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import {
  approveTaskCommand,
  rejectTaskCommand,
  reviewRunCommand,
} from "../src/cli/commands/reviewCommands.js";
import { HarnessError } from "../src/errors.js";
import { readTaskReviews } from "../src/domain/task.js";
import { ReviewService } from "../src/review/application/reviewService.js";
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

const REVIEWER_CODE = [
  "process.stdin.resume();",
  "process.stdin.on('end', () => {",
  "  console.log('REVIEW OK: change satisfies the acceptance criteria');",
  "});",
].join("");

describe("Review and human approval (v0.2)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function reviewedTask(maxAttempts = 3) {
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
        spawnArgs: () => ["-e", WRITE_CODE],
      }),
      verifier: new Verifier(),
      workerId: "worker-review",
      heartbeatMs: 50,
      leaseSeconds: 1,
    });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await worker.executeRun("run-001");

    const reviewer = async () => {
      return reviewRunCommand({
        tasks,
        runs,
        repositories,
        workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
        engine: new CodexEngine({
          executable: process.execPath,
          spawnArgs: () => ["-e", REVIEWER_CODE],
        }),
        runId: "run-001",
      });
    };
    return { tasks, runs, reviewer };
  }

  it("records a review on a succeeded run and keeps the task in REVIEW", async () => {
    const { tasks, reviewer } = await reviewedTask();

    const outcome = await reviewer();

    expect(outcome.task.status).toBe("REVIEW");
    const reviews = readTaskReviews(outcome.task);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.runId).toBe("run-001");
    expect(reviews[0]?.text).toContain("REVIEW OK");
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");
  });

  it("approves a REVIEW task to DONE", async () => {
    const { tasks, reviewer } = await reviewedTask();
    await reviewer();

    const approved = await approveTaskCommand(tasks, "task-001", "looks good");
    expect(approved.status).toBe("DONE");
    expect(readTaskReviews(approved)).toHaveLength(2);
    expect(readTaskReviews(approved)[1]?.text).toContain("APPROVED: looks good");
  });

  it("rejects a REVIEW task back to READY while attempts remain", async () => {
    const { tasks, reviewer } = await reviewedTask(3);
    await reviewer();

    const runs = new InMemoryRunStore();
    await runs.createRun({ id: "run-001", taskId: "task-001", attempt: 1, agent: "a", engine: "e" });
    const result = await rejectTaskCommand(tasks, runs, "task-001", "fix the edge case");
    expect(result.status).toBe("READY");
    expect(readTaskReviews(result)[1]?.text).toContain(
      "CHANGES REQUESTED: fix the edge case",
    );
  });

  it("blocks a rejected task once max attempts are exhausted", async () => {
    const { tasks, runs, reviewer } = await reviewedTask(1);
    await reviewer();

    const blocked = await rejectTaskCommand(tasks, runs, "task-001", "not good enough");
    expect(blocked.status).toBe("BLOCKED");
  });

  // TASK-1242: the test environment is reviewed *after* the task is DONE, so a
  // human has to be able to reopen finished work with feedback.
  it("reopens a DONE task with the acceptance feedback", async () => {
    const { tasks, runs, reviewer } = await reviewedTask(1);
    await reviewer();
    await approveTaskCommand(tasks, "task-001", "looks good");

    const reopened = await rejectTaskCommand(
      tasks,
      runs,
      "task-001",
      "测试环境：间距应该是 24px，不是 16px",
    );

    expect(reopened.status).toBe("READY");
    const reviews = readTaskReviews(reopened);
    expect(reviews.at(-1)?.text).toContain("间距应该是 24px");
    // The attempt budget does not cap a human reopening finished work.
    expect(reopened.status).not.toBe("BLOCKED");
  });

  // TASK-1242: RELEASED is the freeze point — shipped code is not reopened.
  it("refuses to reopen a task whose delivery is already released", async () => {
    const { tasks, runs } = await reviewedTask(1);
    await approveTaskCommand(tasks, "task-001", "looks good");
    const reviews = new ReviewService({
      tasks,
      runs,
      deliveryStatusForTask: async () => "RELEASED",
    });

    await expect(
      reviews.requestChanges("task-001", { channel: "feishu", userId: "ou_admin" }, "还要改"),
    ).rejects.toThrowError(/已发布/);
  });

  it("refuses to approve a task that is not in REVIEW", async () => {
    const tasks = new InMemoryTaskStore();
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "t",
      status: "INBOX",
    });
    await expect(approveTaskCommand(tasks, "task-001")).rejects.toBeInstanceOf(HarnessError);
  });
});
