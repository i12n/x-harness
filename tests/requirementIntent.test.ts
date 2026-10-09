import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIREMENT_ACTIONS } from "../src/command/types.js";
import { intentSystemPrompt } from "../src/command/llmIntentEngine.js";
import { decideFromIntentResult } from "../src/server/intentTriage.js";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "intentPhrasings.json"), "utf8"),
) as {
  cases: { text: string; expect: string; allowAlso?: string[] }[];
  $dangerous: string[];
};

/**
 * TASK-1244: the phrasing corpus is a release asset — the online run lives in
 * `scripts/eval-intent.mjs`, these tests keep it honest offline.
 */
describe("intent phrasing corpus", () => {
  it("only expects actions the model is allowed to produce", () => {
    for (const entry of fixture.cases) {
      expect(REQUIREMENT_ACTIONS).toContain(entry.expect);
      for (const alternative of entry.allowAlso ?? []) {
        expect(REQUIREMENT_ACTIONS).toContain(alternative);
      }
    }
  });

  it("documents the two dangerous misclassifications to guard against", () => {
    expect(fixture.$dangerous).toHaveLength(2);
    expect(fixture.$dangerous.join(" ")).toContain("疑问句");
    expect(fixture.$dangerous.join(" ")).toContain("短句");
  });

  it("teaches the model exactly the rules that made the corpus pass", () => {
    const prompt = intentSystemPrompt();
    expect(prompt).toContain("Questions first");
    expect(prompt).toContain("Bare short replies");
    expect(prompt).toContain("irreversible");
    expect(prompt).toContain("Stage decides meaning");
    expect(prompt).toContain("Never emit or ask for internal ids");
  });
});

describe("action classification", () => {
  const decide = (action: string, confidence = 0.9) =>
    decideFromIntentResult({ command: undefined, action: { type: action as never }, confidence });

  it("maps read-only and write actions to the right triage kind", () => {
    expect(decide("show").kind).toBe("query");
    expect(decide("deploy").kind).toBe("act");
    expect(decide("publish").kind).toBe("act");
    expect(decide("reject").kind).toBe("act");
    expect(decide("rerun").kind).toBe("act");
    expect(decide("create").kind).toBe("work");
    expect(decide("chat").kind).toBe("chat");
    expect(decide("clarify").kind).toBe("chat");
  });

  it("keeps the confirmation step for low-confidence new work", () => {
    expect(decide("create", 0.3).needsConfirmation).toBe(true);
    expect(decide("create", 0.95).needsConfirmation).toBe(false);
  });
});
