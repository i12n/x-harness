import { describe, expect, it } from "vitest";
import { renderRunMessage } from "../src/channel/rendering/run.js";
import type { MessageBlock } from "../src/channel/message.js";
import type { Run } from "../src/domain/run.js";
import {
  acceptanceChecksOf,
  buildAcceptanceEvidence,
} from "../src/verification/acceptance.js";
import { TargetVerifier } from "../src/verification/targetVerifier.js";
import type { VerificationResult } from "../src/verification/runner.js";

describe("acceptance evidence (TASK-1220)", () => {
  it("marks criteria verified when the task brought checks", () => {
    const evidence = buildAcceptanceEvidence(
      ["按钮与标签之间有可见空隙", "桌面端不变"],
      ["node scripts/check-docs.mjs"],
    );
    expect(evidence.criteria.map((entry) => entry.status)).toEqual([
      "verified",
      "verified",
    ]);
    expect(evidence.requiresHumanAcceptance).toBe(false);
  });

  it("says a criterion is unverifiable when nothing can prove it", () => {
    const evidence = buildAcceptanceEvidence(["截图看起来更好"], []);
    expect(evidence.criteria[0]).toMatchObject({ status: "unverifiable", checks: [] });
    expect(evidence.requiresHumanAcceptance).toBe(true);
  });

  it("reads the task-level checks a work item contributed", () => {
    expect(acceptanceChecksOf({ checks: ["a", "  ", 3, "b"] })).toEqual(["a", "b"]);
    expect(acceptanceChecksOf(undefined)).toEqual([]);
  });

  it("does not count a manual step as proof, and says so", () => {
    const checks = acceptanceChecksOf({
      checks: [
        "npm test",
        "在运行应用的开发者工具中选取面包屑 sep 元素，断言间距为 16px",
      ],
    });
    expect(checks).toEqual(["npm test"]);

    // A task whose only "check" was prose proves nothing — a human must look.
    const evidence = buildAcceptanceEvidence(["sep 左右各 16px"], acceptanceChecksOf({
      checks: ["在运行应用的开发者工具中选取面包屑 sep 元素，断言间距为 16px"],
    }));
    expect(evidence.criteria[0]).toMatchObject({ status: "unverifiable", checks: [] });
    expect(evidence.requiresHumanAcceptance).toBe(true);
  });
});

describe("task checks run alongside the repository's (TASK-1220)", () => {
  it("runs repository commands first, then the task's own checks", async () => {
    const seen: string[][] = [];
    const verifier = {
      run: async (params: { commands: string[] }): Promise<VerificationResult> => {
        seen.push(params.commands);
        return {
          passed: true,
          checks: [],
          startedAt: "",
          finishedAt: "",
          durationSeconds: 0,
        };
      },
    };
    const targetVerifier = new TargetVerifier(verifier as never);

    const [result] = await targetVerifier.verifyTargets([
      {
        targetId: "t1",
        repositoryId: "repo-1",
        repositoryName: "x",
        role: "primary",
        workdir: "/tmp",
        commands: ["npm test"],
        acceptanceChecks: ["node scripts/check-docs.mjs"],
      },
    ]);

    expect(seen[0]).toEqual(["npm test", "node scripts/check-docs.mjs"]);
    expect(result!.acceptanceChecks).toEqual(["node scripts/check-docs.mjs"]);
  });
});

describe("run card acceptance block (TASK-1220)", () => {
  const run = (result: unknown): Run => ({
    id: "run-1",
    taskId: "task-1",
    status: "SUCCEEDED",
    attempt: 1,
    agent: "codex",
    engine: "codex",
    createdAt: "",
    result,
  });

  const textOf = (blocks: MessageBlock[] | undefined): string =>
    (blocks ?? []).map((block) => JSON.stringify(block)).join("\n");

  it("lists the criteria and flags the ones a human must judge", () => {
    const text = textOf(
      renderRunMessage(
        run({
          acceptance: {
            requiresHumanAcceptance: true,
            criteria: [
              { criterion: "可见空隙", status: "verified", checks: ["c"] },
              { criterion: "看起来更舒服", status: "unverifiable", checks: [] },
            ],
          },
        }),
      ).blocks,
    );

    expect(text).toContain("Acceptance");
    expect(text).toContain("可见空隙");
    expect(text).toContain("需要人验收");
  });

  it("stays out of the way when a run has no acceptance evidence", () => {
    expect(textOf(renderRunMessage(run(undefined)).blocks)).not.toContain("Acceptance");
  });
});
