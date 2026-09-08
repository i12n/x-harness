#!/usr/bin/env node

// Phase 4 acceptance demo: harness -> workspace -> agent -> code changes -> result.
// The "agent" is a fake Codex engine (node -e) that writes a file, so the demo
// runs offline. Real usage: ai run <task-id> with the codex binary.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEngine } from "../dist/agent/codexEngine.js";
import { runTaskCommand } from "../dist/cli/commands/runCommands.js";
import { InMemoryRepositoryStore } from "../dist/store/inMemoryRepositoryStore.js";
import { InMemoryTaskStore } from "../dist/store/inMemoryTaskStore.js";
import { WorkspaceManager } from "../dist/workspace/manager.js";

// Inline lightweight fixture (mirrors tests/helpers/gitFixture.mjs semantics).
const { execFileSync } = await import("node:child_process");
const repoPath = mkdtempSync(join(tmpdir(), "ai-harness-repo-"));
execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
execFileSync("git", ["config", "user.email", "demo@example.com"], { cwd: repoPath, stdio: "ignore" });
execFileSync("git", ["config", "user.name", "Demo"], { cwd: repoPath, stdio: "ignore" });
const { writeFileSync } = await import("node:fs");
writeFileSync(join(repoPath, "README.md"), "# fixture\n");
execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

const workspaceBase = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
const fakeCode = [
  "process.stdin.resume();",
  "process.stdin.on('end', () => {",
  "  require('fs').writeFileSync('solution.txt', 'avatar upload implemented');",
  "  console.log('code changed in workspace');",
  "});",
].join("");

try {
  const repositories = new InMemoryRepositoryStore();
  const tasks = new InMemoryTaskStore();
  await repositories.createRepository({
    id: "repo-001",
    name: "my-app",
    url: "git@github.com:example/my-app.git",
    localPath: repoPath,
    verificationCommands: ["npm test"],
  });
  await tasks.createTask({
    id: "task-001",
    repositoryId: "repo-001",
    title: "Add user avatar",
    description: "Allow users to upload avatars.",
    status: "READY",
    acceptance: ["Tests pass"],
  });

  const outcome = await runTaskCommand({
    tasks,
    repositories,
    workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
    engine: new CodexEngine({
      executable: process.execPath,
      spawnArgs: () => ["-e", fakeCode],
    }),
    taskId: "task-001",
  });

  console.log(`run: ${outcome.runId}`);
  console.log(`task: ${outcome.task.id} (${outcome.task.title})`);
  console.log(`workspace: ${outcome.workspace.path} [${outcome.workspace.branch}]`);
  console.log(`agent exit code: ${outcome.result.exitCode}`);
  console.log(`agent output: ${outcome.result.stdout.trim()}`);
  const marker = join(outcome.workspace.path, "solution.txt");
  console.log(`code changed (${existsSync(marker) ? "yes" : "no"}): solution.txt`);
} finally {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(workspaceBase, { recursive: true, force: true });
}
