import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import { sessionIdOf } from "../src/agent/codexEngine.js";
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
  // TASK-1247: the session id is what lets a failed verification be repaired in
  // the same conversation instead of starting over.
  it("reads the session id out of the JSONL stream", () => {
    const stdout = [
      "Reading additional input from stdin...",
      '{"type":"thread.started","thread_id":"01a11eda-478f-7271-9b8c-1064638824dd"}',
      '{"type":"turn.started"}',
    ].join("\n");

    expect(sessionIdOf(stdout)).toEqual({
      sessionId: "01a11eda-478f-7271-9b8c-1064638824dd",
    });
    expect(sessionIdOf("no json here")).toEqual({});
    expect(sessionIdOf(undefined)).toEqual({});
  });

  it("resumes the session with `resume --last` and keeps the sandbox config", async () => {
    const calls: string[][] = [];
    const engine = new CodexEngine({ sandbox: "workspace-write" });
    const runId = "run-301";
    await engine.continue(
      {
        ...context(runId, "/tmp"),
        execution: {
          runId,
          executionId: "exec-1",
          workspacePath: "/tmp",
          workdir: "/workspace",
          driver: "docker",
          exec: async (command: string[]) => {
            calls.push(command);
            return {
              exitCode: 0,
              signal: undefined,
              stdout: '{"type":"thread.started","thread_id":"resumed-id"}',
              stderr: "",
            };
          },
        },
      },
      "验证失败：请修复",
    );

    expect(calls[0]).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "workspace-write",
      "--json",
      "resume",
      "--last",
      "-",
    ]);
  });

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

  it("runs through execution.exec instead of spawning locally (TASK-913)", async () => {
    const calls: { command: string[]; stdin?: string; cwd?: string }[] = [];
    const engine = new CodexEngine({
      executable: "codex",
      spawnArgs: () => ["exec", "--json", "-"],
    });
    const executionContext = {
      runId: "run-009",
      executionId: "exec-1",
      workspacePath: "/host/workspace",
      workdir: "/workspace",
      driver: "docker",
      exec: async (
        command: string[],
        options?: { stdin?: string; cwd?: string },
      ) => {
        calls.push({ command, stdin: options?.stdin, cwd: options?.cwd });
        return {
          exitCode: 0,
          stdout: "agent done",
          stderr: "",
          durationSeconds: 0.1,
          timedOut: false,
        };
      },
    };
    const base = context("run-009", "/host/workspace");

    const result = await engine.execute({ ...base, execution: executionContext });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual(["codex", "exec", "--json", "-"]);
    expect(calls[0]?.stdin).toBe("hello agent");
    expect(calls[0]?.cwd).toBe("/workspace");
    expect(result.stdout).toBe("agent done");
    expect(result.exitCode).toBe(0);
  });
});
