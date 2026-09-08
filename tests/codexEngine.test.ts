import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import type { AgentContext } from "../src/agent/types.js";

const FAKE_WRITE_CODE = [
  "const chunks = [];",
  "process.stdin.on('data', (c) => chunks.push(c));",
  "process.stdin.on('end', () => {",
  "  require('fs').writeFileSync('agent-marker.txt', 'phase4 ok');",
  "  console.log('fake codex stdin bytes: ' + Buffer.concat(chunks).length);",
  "});",
].join("");

const FAKE_SLEEP_CODE = "setTimeout(() => {}, 60000);";

function context(runId: string, workspacePath: string): AgentContext {
  return {
    runId,
    task: {
      id: "task-001",
      repositoryId: "repo-001",
      title: "t",
      description: "d",
      status: "READY",
      priority: 50,
      acceptance: ["a"],
      constraints: {},
      maxAttempts: 3,
      createdAt: "",
      updatedAt: "",
    },
    repository: {
      id: "repo-001",
      name: "r",
      url: "git@github.com:example/r.git",
      defaultBranch: "main",
      localPath: "/tmp",
      verificationCommands: [],
      createdAt: "",
      updatedAt: "",
    },
    workspacePath,
    prompt: "hello agent",
  };
}

describe("CodexEngine", () => {
  it("spawns the engine in the workspace and streams the prompt on stdin", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-harness-agent-"));
    const engine = new CodexEngine({
      executable: process.execPath,
      spawnArgs: () => ["-e", FAKE_WRITE_CODE],
    });

    const result = await engine.execute(context("run-001", workspace));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fake codex stdin bytes: 11");
    expect(existsSync(join(workspace, "agent-marker.txt"))).toBe(true);
  });

  it("cancel terminates a running agent", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-harness-agent-"));
    const engine = new CodexEngine({
      executable: process.execPath,
      spawnArgs: () => ["-e", FAKE_SLEEP_CODE],
    });

    const promise = engine.execute(context("run-002", workspace));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await engine.cancel("run-002");

    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });
});
