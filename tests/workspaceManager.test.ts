import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../src/workspace/manager.js";

describe("WorkspaceManager (git worktrees)", () => {
  let repoPath: string;
  let baseDir: string;
  const tempDirs: string[] = [];

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "ai-harness-repo-"));
    baseDir = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
    tempDirs.push(repoPath, baseDir);

    runGit(["init", "-b", "main"], repoPath);
    runGit(["config", "user.email", "test@example.com"], repoPath);
    runGit(["config", "user.name", "Test"], repoPath);
    writeFileSync(join(repoPath, "README.md"), "# fixture\n");
    runGit(["add", "."], repoPath);
    runGit(["commit", "-m", "init"], repoPath);
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      execFileSync("rm", ["-rf", dir]);
    }
    tempDirs.length = 0;
  });

  it("creates an independent worktree for each run", async () => {
    const manager = new WorkspaceManager({ baseDir });

    const runA = await manager.createWorkspace({
      repositoryLocalPath: repoPath,
      taskId: "task-001",
      runId: "run-001",
    });
    const runB = await manager.createWorkspace({
      repositoryLocalPath: repoPath,
      taskId: "task-001",
      runId: "run-002",
    });

    expect(runA.path).not.toBe(runB.path);
    expect(runA.branch).toBe("ai/task-001-run-001");
    expect(runB.branch).toBe("ai/task-001-run-002");
    expect(existsSync(runA.path)).toBe(true);
    expect(existsSync(runB.path)).toBe(true);

    const worktrees = await manager.listWorktrees(repoPath);
    expect(worktrees).toContain(runA.path);
    expect(worktrees).toContain(runB.path);

    expect(
      execFileSync("git", ["-C", runA.path, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(runA.branch);
  });

  it("removes a worktree without touching other runs", async () => {
    const manager = new WorkspaceManager({ baseDir });
    const runA = await manager.createWorkspace({
      repositoryLocalPath: repoPath,
      taskId: "task-001",
      runId: "run-001",
    });
    const runB = await manager.createWorkspace({
      repositoryLocalPath: repoPath,
      taskId: "task-001",
      runId: "run-002",
    });

    await manager.removeWorkspace(runA);

    expect(existsSync(runA.path)).toBe(false);
    expect(existsSync(runB.path)).toBe(true);
    const worktrees = await manager.listWorktrees(repoPath);
    expect(worktrees).not.toContain(runA.path);
    expect(worktrees).toContain(runB.path);
  });

  it("refuses to remove a path outside the workspaces base", async () => {
    const manager = new WorkspaceManager({ baseDir });
    await expect(
      manager.removeWorkspace({
        path: "/tmp/somewhere-else",
        repositoryLocalPath: repoPath,
      }),
    ).rejects.toThrow(/outside workspaces base/);
  });

  // TASK-1265: new files are untracked and invisible to `git diff`; the
  // reviewer must still see them.
  it("shows files the agent created but never added", async () => {
    const manager = new WorkspaceManager({ baseDir });
    const workspace = await manager.createWorkspace({
      repositoryLocalPath: repoPath,
      taskId: "task-001",
      runId: "run-001",
    });
    writeFileSync(join(workspace.path, "new-component.tsx"), "export const x = 1;\n");

    const diff = await manager.showDiff(workspace.path);

    expect(diff).toContain("new-component.tsx");
    expect(diff).toContain("export const x = 1;");
  });
});

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
