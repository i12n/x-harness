import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Verifier } from "../src/verification/runner.js";

describe("Verifier", () => {
  it("passes when every check exits zero", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-verify-"));
    writeFileSync(join(workspace, "check-ok.sh"), "exit 0\n");

    const result = await new Verifier().run({
      workspacePath: workspace,
      commands: ["sh check-ok.sh"],
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ status: "passed", exitCode: 0 });
  });

  it("fails when any check exits non-zero and records each check", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-verify-"));
    writeFileSync(join(workspace, "check-ok.sh"), "exit 0\n");
    writeFileSync(join(workspace, "check-fail.sh"), "echo boom; exit 1\n");

    const result = await new Verifier().run({
      workspacePath: workspace,
      commands: ["sh check-ok.sh", "sh check-fail.sh"],
    });

    expect(result.passed).toBe(false);
    expect(result.checks.map((check) => check.status)).toEqual(["passed", "failed"]);
    expect(result.checks[1]).toMatchObject({ exitCode: 1 });
    expect(result.checks[1]?.output).toContain("boom");
  });

  it("fails when no verification commands are configured", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-verify-"));
    const result = await new Verifier().run({ workspacePath: workspace, commands: [] });

    expect(result.passed).toBe(false);
    expect(result.checks[0]?.output).toContain("no verification commands");
  });

  it("kills a check that exceeds its timeout", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-verify-"));
    const result = await new Verifier({ timeoutMs: 300 }).run({
      workspacePath: workspace,
      commands: ["node -e 'setTimeout(() => {}, 60000)'"],
    });

    expect(result.passed).toBe(false);
    expect(result.checks[0]?.status).toBe("failed");
    expect(result.checks[0]?.durationSeconds).toBeLessThan(10);
  });

  it("runs checks through execution.exec when provided (TASK-913)", async () => {
    const commands: string[][] = [];
    const result = await new Verifier().run({
      workspacePath: "/host/workspace",
      workdir: "/workspace",
      commands: ["npm test", "npm run build"],
      exec: async (command) => {
        commands.push(command);
        const failed = command.join(" ").includes("npm test");
        return {
          exitCode: failed ? 1 : 0,
          stdout: failed ? "boom" : "ok",
          stderr: "",
          durationSeconds: 0.1,
          timedOut: false,
        };
      },
    });

    expect(commands).toEqual([
      ["sh", "-lc", "npm test"],
      ["sh", "-lc", "npm run build"],
    ]);
    expect(result.passed).toBe(false);
    expect(result.checks.map((check) => check.status)).toEqual(["failed", "passed"]);
    expect(result.checks[0]?.output).toContain("boom");
  });
});
