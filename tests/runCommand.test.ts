import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import { runTaskCommand } from "../src/cli/commands/runCommands.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import {
  commitFile,
  createGitFixture,
  type GitFixture,
} from "./helpers/gitFixture.js";

const FAKE_CODE = [
  "process.stdin.resume();",
  "process.stdin.on('end', () => {",
  "  require('fs').writeFileSync('solution.txt', 'avatar upload implemented');",
  "  console.log('changes made');",
  "});",
].join("");

describe("runTaskCommand (manual run, Phase 4)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("goes task -> workspace -> context -> engine and returns the result", async () => {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(fixture.path, "checks.sh", "test -f solution.txt && echo ok\n");
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
    cleanups.push(() => {
      if (existsSync(workspaceBase)) {
        rmSync(workspaceBase, { recursive: true, force: true });
      }
    });

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
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
    });

    const outcome = await runTaskCommand({
      tasks,
      repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      engine: new CodexEngine({
        executable: process.execPath,
        spawnArgs: () => ["-e", FAKE_CODE],
      }),
      verifier: new Verifier(),
      taskId: "task-001",
    });

    expect(outcome.runId).toMatch(/^run-/);
    expect(outcome.task.id).toBe("task-001");
    expect(outcome.workspace.branch).toBe(`ai/task-001-${outcome.runId}`);
    expect(outcome.result.exitCode).toBe(0);
    expect(outcome.result.stdout).toContain("changes made");
    expect(
      existsSync(join(outcome.workspace.path, "solution.txt")),
    ).toBe(true);
    expect(outcome.verification.passed).toBe(true);
    expect(outcome.succeeded).toBe(true);
  });

  it("does not succeed when codex finishes but verification fails", async () => {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(fixture.path, "checks.sh", "test -f solution.txt && echo ok\n");
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
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
    });

    // Fake agent that claims to be done but writes nothing.
    const idleCode = "process.stdin.resume(); process.stdin.on('end', () => console.log('done'));";
    const outcome = await runTaskCommand({
      tasks,
      repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      engine: new CodexEngine({
        executable: process.execPath,
        spawnArgs: () => ["-e", idleCode],
      }),
      verifier: new Verifier(),
      taskId: "task-001",
    });

    expect(outcome.result.exitCode).toBe(0);
    expect(outcome.verification.passed).toBe(false);
    expect(outcome.succeeded).toBe(false);
  });
});
