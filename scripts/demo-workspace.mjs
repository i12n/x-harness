#!/usr/bin/env node

// Phase 3 acceptance demo: one Run = one independent git worktree.
// Requires git and a build first (npm run build).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../dist/workspace/manager.js";

const repoPath = mkdtempSync(join(tmpdir(), "ai-harness-repo-"));
const baseDir = mkdtempSync(join(tmpdir(), "ai-workspaces-"));

try {
  git(["init", "-b", "main"], repoPath);
  git(["config", "user.email", "demo@example.com"], repoPath);
  git(["config", "user.name", "Demo"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# fixture\n");
  git(["add", "."], repoPath);
  git(["commit", "-m", "init"], repoPath);

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

  console.log(`run-001 workspace: ${runA.path} (branch ${runA.branch})`);
  console.log(`run-002 workspace: ${runB.path} (branch ${runB.branch})`);
  console.log(`worktrees: ${(await manager.listWorktrees(repoPath)).length}`);

  await manager.removeWorkspace(runA);
  console.log(`removed run-001 workspace; remaining: ${(await manager.listWorktrees(repoPath)).length}`);
} finally {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
}

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
