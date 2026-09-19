import { describe, expect, it } from "vitest";
import { extractFailureEvidence } from "../src/domain/failureEvidence.js";

describe("Failure evidence (TASK-1207)", () => {
  it("prefers the failing target checks of a failed run", () => {
    const evidence = extractFailureEvidence({
      status: "FAILED",
      exitCode: 1,
      result: { targets: [] },
      error: {
        failingTargets: [
          {
            targetId: "tgt-b",
            repositoryId: "repo-b",
            error: "verification failed",
            checks: [
              { command: "npm run build", status: "passed", exitCode: 0, output: "" },
              {
                command: "npm test",
                status: "failed",
                exitCode: 1,
                output: "3 tests failed",
              },
            ],
          },
        ],
      },
    });

    expect(evidence).toEqual({
      kind: "verification",
      command: "npm test",
      exitCode: 1,
      output: "3 tests failed",
      targets: [{ targetId: "tgt-b", repositoryId: "repo-b", error: "verification failed" }],
    });
  });

  it("falls back to error.verification and then run.result targets", () => {
    const fromVerification = extractFailureEvidence({
      status: "FAILED",
      exitCode: 1,
      error: {
        verification: [
          { command: "cargo test", status: "failed", exitCode: 101, output: "boom" },
        ],
      },
    });
    expect(fromVerification).toMatchObject({
      kind: "verification",
      command: "cargo test",
      exitCode: 101,
      output: "boom",
    });

    const fromResult = extractFailureEvidence({
      status: "FAILED",
      exitCode: 1,
      result: {
        targets: [
          {
            targetId: "tgt-a",
            repositoryId: "repo-a",
            checks: [{ command: "pnpm test", status: "failed", exitCode: 2, output: "nope" }],
          },
        ],
      },
    });
    expect(fromResult).toMatchObject({ command: "pnpm test", exitCode: 2, output: "nope" });
  });

  it("truncates long output", () => {
    const evidence = extractFailureEvidence(
      {
        status: "FAILED",
        exitCode: 1,
        error: {
          verification: [
            { command: "npm test", status: "failed", exitCode: 1, output: "x".repeat(50) },
          ],
        },
      },
      { maxOutputChars: 10 },
    );

    expect(evidence?.output).toBe("xxxxxxxxxx…");
  });

  it("reports terminal statuses without check evidence", () => {
    expect(extractFailureEvidence({ status: "TIMED_OUT", error: {} })).toEqual({
      kind: "timeout",
      message: "run timed out",
    });
    expect(
      extractFailureEvidence({
        status: "CANCELLED",
        result: { reason: "cancel requested" },
        error: {},
      }),
    ).toEqual({ kind: "cancelled", message: "run cancelled" });
    expect(extractFailureEvidence({ status: "LOST", error: {} })).toEqual({
      kind: "lost",
      message: "run lost",
    });
  });

  it("distinguishes an agent failure from an unknown failure", () => {
    const agent = extractFailureEvidence({
      status: "FAILED",
      exitCode: 2,
      result: { agentStderr: "codex crashed" },
      error: {},
    });
    expect(agent).toMatchObject({
      kind: "agent",
      message: "run failed (exit 2)",
      exitCode: 2,
    });

    expect(extractFailureEvidence({ status: "FAILED", error: {} })).toMatchObject({
      kind: "unknown",
      message: "run failed",
    });
  });

  it("returns nothing for missing or non-failed runs", () => {
    expect(extractFailureEvidence(undefined)).toBeUndefined();
    expect(extractFailureEvidence({ status: "SUCCEEDED", exitCode: 0 })).toBeUndefined();
    expect(extractFailureEvidence({ status: "QUEUED" })).toBeUndefined();
  });
});
