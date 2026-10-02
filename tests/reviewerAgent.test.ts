import { describe, expect, it } from "vitest";
import { renderRunMessage } from "../src/channel/rendering/run.js";
import type { MessageBlock } from "../src/channel/message.js";
import type { Run } from "../src/domain/run.js";
import { reviewerPrompt } from "../src/reviewer/application/reviewerAgent.js";
import {
  decideReviewAction,
  describeReviewerReport,
  parseReviewerReport,
} from "../src/reviewer/domain/verdict.js";
import type { ReviewerReport } from "../src/reviewer/domain/verdict.js";
import { buildAcceptanceEvidence } from "../src/verification/acceptance.js";
import { collectGitDiff } from "../src/verification/diff.js";
import { assessChangeRisk } from "../src/reviewer/domain/risk.js";

const report = (over: Partial<ReviewerReport> = {}): ReviewerReport => ({
  verdict: "approve",
  criteria: [{ index: 0, status: "met", evidence: "check output" }],
  risks: [],
  notes: "looks right",
  ...over,
});

const verified = buildAcceptanceEvidence(["criterion"], ["npm test"]);
const unverifiable = buildAcceptanceEvidence(["looks nicer"], []);

describe("review action policy (TASK-1221)", () => {
  it("auto-approves only when the reviewer approved and everything was provable", () => {
    expect(decideReviewAction(report(), verified, "on")).toBe("auto_approve");
  });

  it("keeps a human when a criterion has no executable proof", () => {
    expect(decideReviewAction(report(), unverifiable, "on")).toBe("human_acceptance");
  });

  it("sends a rejected change back for another attempt", () => {
    expect(decideReviewAction(report({ verdict: "request_changes" }), verified, "on")).toBe(
      "retry",
    );
  });

  it("escalates when the reviewer says it cannot judge", () => {
    expect(decideReviewAction(report({ verdict: "needs_human" }), verified, "on")).toBe(
      "human_review",
    );
  });

  it("never decides anything in shadow or off mode", () => {
    expect(decideReviewAction(report(), verified, "shadow")).toBe("human_review");
    expect(decideReviewAction(report(), verified, "off")).toBe("human_review");
    expect(decideReviewAction(undefined, verified, "on")).toBe("human_review");
  });

  it("forces a human when the change itself is risky (TASK-1222)", () => {
    const risky = assessChangeRisk(["migrations/013_x.sql"]);
    expect(risky.level).toBe("high");
    expect(decideReviewAction(report(), verified, "on", risky)).toBe("human_review");
    expect(decideReviewAction(report(), verified, "on")).toBe("auto_approve");
  });
});

describe("change risk (TASK-1222)", () => {
  it("flags migrations, deployment, config, secrets and CI", () => {
    for (const file of [
      "migrations/001_init.sql",
      "deploy/install.sh",
      "docker/execution/Dockerfile",
      ".github/workflows/ci.yml",
      "config/config.yaml",
      "app/.env.local",
    ]) {
      expect(assessChangeRisk([file])).toMatchObject({ level: "high" });
    }
  });

  it("keeps ordinary business changes low risk", () => {
    const risk = assessChangeRisk(["app/globals.css", "tests/mobile.spec.ts"]);
    expect(risk).toEqual({ level: "low", reasons: [] });
  });

  it("treats a very large change as risky and says why", () => {
    const files = Array.from({ length: 26 }, (_, index) => `src/f${index}.ts`);
    const risk = assessChangeRisk(files);
    expect(risk.level).toBe("high");
    expect(risk.reasons.join()).toContain("改动范围过大");
  });
});

describe("reviewer report parsing", () => {
  it("accepts a well-formed report", () => {
    const parsed = parseReviewerReport({
      verdict: "request_changes",
      criteria: [{ index: 0, status: "not_met", evidence: "no test added" }],
      risks: ["no regression test"],
      notes: "add a test",
    });
    expect(parsed).toMatchObject({ verdict: "request_changes", risks: ["no regression test"] });
  });

  it("returns nothing for malformed payloads instead of guessing", () => {
    expect(parseReviewerReport(undefined)).toBeUndefined();
    expect(parseReviewerReport({ verdict: "maybe" })).toBeUndefined();
    expect(parseReviewerReport("approve")).toBeUndefined();
  });

  it("summarises a verdict for chat and history", () => {
    expect(describeReviewerReport(report())).toContain("评审通过");
    expect(describeReviewerReport(report({ verdict: "needs_human", notes: "视觉" }))).toContain(
      "视觉",
    );
  });
});

describe("reviewer prompt", () => {
  it("carries the criteria, the evidence and the diff", () => {
    const prompt = reviewerPrompt({
      task: { id: "task-1", title: "t", description: "d", acceptance: ["可见空隙"] },
      acceptance: buildAcceptanceEvidence(["可见空隙"], ["npm test"]),
      verification: { passed: true, checks: [{ command: "npm test", status: "passed" }] },
      diff: { files: ["app/globals.css"], stat: "1 file changed", patch: "+margin-top: 16px" },
    });

    expect(prompt).toContain("0. 可见空隙");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("app/globals.css");
    expect(prompt).toContain("+margin-top: 16px");
  });
});

describe("diff evidence", () => {
  it("reads files, stat and a truncated patch through the driver", async () => {
    const exec = async (command: string[]) => {
      const joined = command.join(" ");
      if (joined.includes("--name-only")) {
        return { exitCode: 0, stdout: "a.ts\nb.ts\n", stderr: "" };
      }
      if (joined.includes("--stat")) {
        return { exitCode: 0, stdout: "2 files changed", stderr: "" };
      }
      return { exitCode: 0, stdout: "x".repeat(100), stderr: "" };
    };

    const diff = await collectGitDiff(exec as never, "/workspace", { maxPatchChars: 10 });
    expect(diff.files).toEqual(["a.ts", "b.ts"]);
    expect(diff.stat).toBe("2 files changed");
    expect(diff.patch).toContain("truncated");
  });

  it("returns an empty diff when git is unavailable", async () => {
    const exec = async () => {
      throw new Error("no git");
    };
    await expect(collectGitDiff(exec as never, "/workspace")).resolves.toEqual({
      files: [],
      stat: "",
      patch: "",
    });
  });
});

describe("run card reviewer block (TASK-1221)", () => {
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

  it("shows the verdict and the reason", () => {
    const text = textOf(
      renderRunMessage(
        run({
          review: {
            verdict: "request_changes",
            criteria: [{ index: 0, status: "not_met", evidence: "no test" }],
            risks: ["no regression test"],
            notes: "add a test",
          },
        }),
      ).blocks,
    );
    expect(text).toContain("Reviewer");
    expect(text).toContain("add a test");
    expect(text).toContain("no regression test");
  });
});
