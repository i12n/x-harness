import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Verifier } from "../src/verification/runner.js";
import {
  TargetVerifier,
  type TargetVerificationRequest,
} from "../src/verification/targetVerifier.js";

describe("TargetVerifier (TASK-1008)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function workspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-target-verify-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  function request(
    overrides: Partial<TargetVerificationRequest> & {
      targetId: string;
      workdir: string;
      commands: string[];
    },
  ): TargetVerificationRequest {
    return {
      repositoryId: "repo-unknown",
      repositoryName: "unknown",
      role: "supporting",
      ...overrides,
    };
  }

  it("verifies each target independently and keeps its own repository config", async () => {
    const primary = workspace({
      "check.sh": "touch primary-ran.txt; echo primary-ok\n",
    });
    const supporting = workspace({
      "check.sh": "touch supporting-ran.txt; echo supporting-boom; exit 1\n",
    });
    const verifier = new TargetVerifier();

    const results = await verifier.verifyTargets([
      request({
        targetId: "tgt-rehelu",
        repositoryId: "repo-rehelu",
        repositoryName: "rehelu",
        role: "primary",
        workdir: primary,
        commands: ["sh check.sh"],
      }),
      request({
        targetId: "tgt-auth",
        repositoryId: "repo-auth",
        repositoryName: "auth",
        role: "supporting",
        workdir: supporting,
        commands: ["sh check.sh", "sh missing.sh"],
      }),
    ]);

    expect(results.map((result) => result.targetId)).toEqual([
      "tgt-rehelu",
      "tgt-auth",
    ]);
    expect(results[0]).toMatchObject({
      repositoryId: "repo-rehelu",
      repository: "rehelu",
      role: "primary",
      workdir: primary,
      commands: ["sh check.sh"],
      passed: true,
    });
    expect(results[0]?.checks[0]).toMatchObject({ status: "passed", exitCode: 0 });

    expect(results[1]).toMatchObject({
      repositoryId: "repo-auth",
      repository: "auth",
      role: "supporting",
      workdir: supporting,
      commands: ["sh check.sh", "sh missing.sh"],
      passed: false,
    });
    expect(results[1]?.checks.map((check) => check.status)).toEqual([
      "failed",
      "failed",
    ]);

    // Each verification ran in its own workdir (evidence markers).
    expect(existsSync(join(primary, "primary-ran.txt"))).toBe(true);
    expect(existsSync(join(supporting, "supporting-ran.txt"))).toBe(true);
    expect(existsSync(join(primary, "supporting-ran.txt"))).toBe(false);
  });

  it("does not aggregate: one failing target leaves the other result untouched", async () => {
    const good = workspace({ "check.sh": "exit 0\n" });
    const bad = workspace({ "check.sh": "exit 3\n" });
    const verifier = new TargetVerifier();

    const results = await verifier.verifyTargets([
      request({ targetId: "tgt-bad", workdir: bad, commands: ["sh check.sh"] }),
      request({ targetId: "tgt-good", workdir: good, commands: ["sh check.sh"] }),
    ]);

    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.checks[0]?.exitCode).toBe(3);
    expect(results[1]?.passed).toBe(true);
    expect(results[1]?.checks[0]?.exitCode).toBe(0);
  });

  it("captures per-target infrastructure errors without leaking to other targets", async () => {
    const good = workspace({ "check.sh": "exit 0\n" });
    const verifier = new TargetVerifier();

    const results = await verifier.verifyTargets([
      request({
        targetId: "tgt-broken",
        workdir: good,
        commands: ["sh check.sh"],
        exec: async () => {
          throw new Error("container exec unavailable");
        },
      }),
      request({
        targetId: "tgt-good",
        workdir: good,
        commands: ["sh check.sh"],
      }),
    ]);

    expect(results[0]).toMatchObject({ targetId: "tgt-broken", passed: false });
    expect(results[0]?.error).toContain("container exec unavailable");
    expect(results[0]?.checks).toEqual([]);
    expect(results[1]?.passed).toBe(true);
  });

  it("keeps single-target semantics identical to the Phase 5 Verifier", async () => {
    const workspaceDir = workspace({
      "ok.sh": "echo ok\n",
      "fail.sh": "echo boom; exit 2\n",
    });
    const commands = ["sh ok.sh", "sh fail.sh"];

    const legacy = await new Verifier().run({
      workspacePath: workspaceDir,
      commands,
    });
    const [target] = await new TargetVerifier().verifyTargets([
      request({
        targetId: "tgt-only",
        repositoryId: "repo-only",
        repositoryName: "only",
        role: "primary",
        workdir: workspaceDir,
        commands,
      }),
    ]);

    expect(target?.passed).toBe(legacy.passed);
    expect(target?.checks.map((check) => [check.command, check.status, check.exitCode])).toEqual(
      legacy.checks.map((check) => [check.command, check.status, check.exitCode]),
    );
    expect(target?.repositoryId).toBe("repo-only");
  });
});
