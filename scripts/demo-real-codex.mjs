#!/usr/bin/env node

// Real-codex end-to-end (requires `codex login` first):
//
//   npm run build
//   npm run demo:codex
//
// Creates a throwaway git repo + worktree, drives a READY task through the
// Loop with the real Codex CLI (sandbox: workspace-write), verifies the
// change, then removes the workspace.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEngine } from "../dist/agent/codexEngine.js";
import { Loop } from "../dist/loop/loop.js";
import { Scheduler } from "../dist/scheduler/scheduler.js";
import { InMemoryEventStore } from "../dist/store/inMemoryEventStore.js";
import { InMemoryRepositoryStore } from "../dist/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../dist/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../dist/store/inMemoryTaskStore.js";
import { Verifier } from "../dist/verification/runner.js";
import { Worker } from "../dist/worker/worker.js";
import { WorkspaceManager } from "../dist/workspace/manager.js";

const repoPath = mkdtempSync(join(tmpdir(), "ai-codex-repo-"));
const workspaceBase = mkdtempSync(join(tmpdir(), "ai-workspaces-"));

try {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "demo@example.com"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Demo"], { cwd: repoPath, stdio: "ignore" });
  writeFileSync(join(repoPath, "README.md"), "# fixture\n");
  writeFileSync(
    join(repoPath, "checks.sh"),
    "test -f solution.txt && grep -qx 'avatar upload implemented' solution.txt && echo ok\n",
  );
  execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

  const repositories = new InMemoryRepositoryStore();
  const tasks = new InMemoryTaskStore();
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
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
    description:
      "Create a file named solution.txt in the repository root whose content is exactly " +
      "'avatar upload implemented'. Do not modify any other file.",
    status: "READY",
    acceptance: ["solution.txt exists", "content is exactly 'avatar upload implemented'", "checks pass"],
    maxAttempts: 1,
  });

  const workspaceManager = new WorkspaceManager({ baseDir: workspaceBase });
  const worker = new Worker({
    runStore: runs,
    taskStore: tasks,
    repositoryStore: repositories,
    workspaceManager,
    agentEngine: new CodexEngine(), // real `codex exec`
    verifier: new Verifier(),
    eventStore: events,
    workerId: "worker-codex",
    heartbeatMs: 5_000,
    leaseSeconds: 120,
  });
  const loop = new Loop({
    scheduler: new Scheduler({ taskStore: tasks, runStore: runs, eventStore: events }),
    worker,
    runStore: runs,
    taskStore: tasks,
    eventStore: events,
    maxConcurrency: 1,
  });

  console.log("running real codex exec (this can take a minute)...");
  const report = await loop.tick();
  const run = (await runs.listRuns({ taskId: "task-001" }))[0];
  const task = await tasks.findTask("task-001");
  console.log(`scheduled=${report.scheduled.length} executed=${report.executed.length}`);
  console.log(`run: ${run?.id} status=${run?.status}`);
  console.log(`task: ${task.id} -> ${task.status}`);
  console.log(`events: ${(await events.listEvents()).length}`);

  if (run?.status === "SUCCEEDED") {
    const evidence = join(workspaceBase, "task-001", run.id, "solution.txt");
    console.log(`solution exists in workspace: ${existsSync(evidence)}`);
  } else {
    const failed = run && (run.result ?? run.error);
    console.log("verification/agent output:", JSON.stringify(failed)?.slice(0, 2000));
    process.exitCode = 1;
  }
} finally {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(workspaceBase, { recursive: true, force: true });
}
