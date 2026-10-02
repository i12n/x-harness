import { describe, expect, it } from "vitest";
import { reviewerPrompt } from "../src/reviewer/application/reviewerAgent.js";
import {
  assessTestEvidence,
  describeTestEvidence,
} from "../src/reviewer/domain/testEvidence.js";
import { buildAcceptanceEvidence } from "../src/verification/acceptance.js";

describe("test evidence meta-check (TASK-1225)", () => {
  it("accepts a change that brings its own test", () => {
    const evidence = assessTestEvidence(["app/globals.css", "tests/mobile.spec.ts"]);
    expect(evidence.missingTestChange).toBe(false);
    expect(evidence.testFiles).toEqual(["tests/mobile.spec.ts"]);
  });

  it("flags production code that came without any test change", () => {
    const evidence = assessTestEvidence(["app/page.tsx", "src/util.ts"]);
    expect(evidence.missingTestChange).toBe(true);
    expect(evidence.sourceFiles).toEqual(["app/page.tsx", "src/util.ts"]);
    expect(describeTestEvidence(evidence)).toContain("没有测试变更");
  });

  it("does not treat documentation-only changes as code", () => {
    expect(assessTestEvidence(["docs/04-delivery/changelog.md"]).missingTestChange).toBe(false);
  });

  it("recognises the usual test layouts", () => {
    for (const file of [
      "tests/a.ts",
      "test/b.js",
      "__tests__/c.tsx",
      "e2e/flow.spec.ts",
      "src/thing.test.ts",
      "spec/thing_spec.rb",
    ]) {
      expect(assessTestEvidence([file]).testFiles).toEqual([file]);
    }
  });

  it("has nothing to say when a test change is present", () => {
    expect(
      describeTestEvidence(assessTestEvidence(["src/a.ts", "tests/a.test.ts"])),
    ).toBeUndefined();
  });
});

describe("reviewer is told about the test evidence (TASK-1225)", () => {
  it("includes the conclusion in the prompt", () => {
    const prompt = reviewerPrompt({
      task: { id: "task-1", title: "t", description: "d", acceptance: ["a"] },
      acceptance: buildAcceptanceEvidence(["a"], ["npm test"]),
      verification: { passed: true, checks: [{ command: "npm test", status: "passed" }] },
      diff: { files: ["app/page.tsx"], stat: "", patch: "" },
      testEvidence: assessTestEvidence(["app/page.tsx"]),
    });
    expect(prompt).toContain("没有测试变更");
  });
});
