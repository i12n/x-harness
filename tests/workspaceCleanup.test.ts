import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import { cleanupWorkspacesCommand } from "../src/cli/commands/workspaceCommands.js";
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

describe("workspace cleanup", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("removes the worktree of a succeeded run", async () => {
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
      status: "READY",
      acceptance: ["Tests pass"],
    });
    const manager = new WorkspaceManager({ baseDir: workspaceBase });
    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager: manager,
      agentEngine: new CodexEngine({
        executable: process.execPath,
        spawnArgs: () => ["-e", WRITE_CODE],
      }),
      verifier: new Verifier(),
      workerId: "worker-cleanup",
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
    const outcome = await worker.executeRun("run-001");
    expect(existsSync(outcome.workspace.path)).toBe(true);

    const report = await cleanupWorkspacesCommand({
      runs,
      tasks,
      repositories,
      workspaceManager: manager,
    });

    expect(report.removed).toContain(outcome.workspace.path);
    expect(existsSync(outcome.workspace.path)).toBe(false);
    expect(await manager.listWorktrees(fixture.path)).not.toContain(outcome.workspace.path);
  });

  it("skips terminal runs without workspace evidence", async () => {
    const base = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const repositories = new InMemoryRepositoryStore();
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "t",
      status: "DONE",
    });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
      status: "SUCCEEDED",
      result: { ok: true },
    });

    const report = await cleanupWorkspacesCommand({
      runs,
      tasks,
      repositories,
      workspaceManager: new WorkspaceManager({ baseDir: base }),
    });
    expect(report.removed).toEqual([]);
    expect(report.skipped[0]?.reason).toBe("no workspace evidence");
  });
});
