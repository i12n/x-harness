#!/usr/bin/env node

// Phase 6 acceptance demo: Worker claim -> workspace -> agent -> verification
// -> complete, with heartbeat/lease. Stub agent writes the solution; checks.sh
// in the fixture proves the change, so the run SUCCEEDED and task -> REVIEW.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEngine } from "../dist/agent/codexEngine.js";
import { InMemoryRepositoryStore } from "../dist/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../dist/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../dist/store/inMemoryTaskStore.js";
import { Verifier } from "../dist/verification/runner.js";
import { Worker } from "../dist/worker/worker.js";
import { WorkspaceManager } from "../dist/workspace/manager.js";

const repoPath = mkdtempSync(join(tmpdir(), "ai-harness-repo-"));
const workspaceBase = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
const fakeCode = [
  "process.stdin.resume();",
  "process.stdin.on('end', () => {",
  "  require('fs').writeFileSync('solution.txt', 'avatar upload implemented');",
  "  console.log('code changed');",
  "});",
].join("");

try {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "demo@example.com"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Demo"], { cwd: repoPath, stdio: "ignore" });
  writeFileSync(join(repoPath, "checks.sh"), "test -f solution.txt && echo ok\n");
  execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

  const repositories = new InMemoryRepositoryStore();
  const tasks = new InMemoryTaskStore();
  const runs = new InMemoryRunStore();
  await repositories.createRepository({
    id: "repo-001",
    name: "my-app",
    url: "git@github.com:example/my-app.git",
    localPath: repoPath,
    verificationCommands: ["sh checks.sh"],
  });
  await tasks.createTask({
    id: "task-001",
    repositoryId: "repo-001",
    title: "Add user avatar",
    description: "Allow users to upload avatars.",
    status: "READY",
    acceptance: ["Tests pass"],
    maxAttempts: 3,
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
      spawnArgs: () => ["-e", fakeCode],
    }),
    verifier: new Verifier(),
    workerId: "worker-demo",
    heartbeatMs: 50,
    leaseSeconds: 1,
  });

  const outcome = await worker.executeRun("run-001");
  console.log(`run: ${outcome.run.id} status=${outcome.run.status} worker=${outcome.run.workerId}`);
  console.log(`workspace: ${outcome.workspace.path} [${outcome.workspace.branch}]`);
  console.log(`verification: ${outcome.verification.passed ? "PASSED" : "FAILED"}`);
  console.log(`task: ${outcome.task.id} -> ${outcome.task.status}`);
} finally {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(workspaceBase, { recursive: true, force: true });
}
