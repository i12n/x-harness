import type { ChatClient } from "../../llm/chatClient.js";
import { parseJsonObject } from "../../llm/text.js";
import type { AcceptanceEvidence } from "../../verification/acceptance.js";
import type { CollectedDiff } from "../../verification/diff.js";
import type { ReviewerReport } from "../domain/verdict.js";
import { parseReviewerReport } from "../domain/verdict.js";
import { describeTestEvidence, type TestEvidence } from "../domain/testEvidence.js";

export interface ReviewerInput {
  task: {
    id: string;
    title: string;
    description: string;
    acceptance: string[];
  };
  /** What the harness could prove on its own (TASK-1220). */
  acceptance: AcceptanceEvidence;
  verification: { passed: boolean; checks: { command: string; status: string }[] };
  /** What actually changed, collected by the harness (never self-reported). */
  diff: CollectedDiff;
  /** TASK-1225: whether production code changed without any test change. */
  testEvidence?: TestEvidence;
}

export interface ReviewerAgent {
  review(input: ReviewerInput): Promise<ReviewerReport | undefined>;
}

const SYSTEM_PROMPT = [
  "You are the code reviewer for an automated engineering harness.",
  "You judge ONE task: did it do what it promised, and is it safe to approve?",
  "You see the task, the acceptance criteria, the harness's own acceptance",
  "evidence, the verification result and the diff the harness collected.",
  "Return JSON only:",
  '{"verdict":"approve|request_changes|needs_human",',
 ' "criteria":[{"index":0,"status":"met|not_met|unverifiable","evidence":"..."}],',
 ' "risks":["..."],"notes":"..."}',
 "Rules:",
 "- approve only when every acceptance criterion is met and the diff matches the task.",
 "- request_changes when the change is wrong, incomplete, or breaks the stated constraints.",
 "- needs_human when you cannot judge from the evidence (visual/UX/opinion) or the",
  "  change is risky (migrations, config, secrets, production paths).",
 "- cite the diff or the check output as evidence; never invent one.",
].join("\n");

/** The exact prompt contract, exported for tests. */
export function reviewerPrompt(input: ReviewerInput): string {
  const criteria = input.task.acceptance
    .map((criterion, index) => `${index}. ${criterion}`)
    .join("\n");
  const evidence = input.acceptance.criteria
    .map(
      (entry, index) =>
        `- [${index}] ${entry.status}: ${entry.criterion}` +
        (entry.checks.length > 0 ? ` (checks: ${entry.checks.join(", ")})` : " (no check)"),
    )
    .join("\n");
  const checks = input.verification.checks
    .map((check) => `- [${check.status}] ${check.command || "(no command)"}`)
    .join("\n");
  return [
    `Task: ${input.task.id} — ${input.task.title}`,
    input.task.description,
    "",
    "Acceptance criteria (index them from 0):",
    criteria || "(none)",
    "",
    "Harness acceptance evidence:",
    evidence || "(none)",
    "",
    `Verification: ${input.verification.passed ? "passed" : "failed"}`,
    checks || "(no checks ran)",
    "",
    "Changed files:",
    input.diff.files.join("\n") || "(none)",
    ...(input.testEvidence ? [describeTestEvidence(input.testEvidence) ?? "测试证据：有测试变更"] : []),
    "",
    "Diff stat:",
    input.diff.stat || "(none)",
    "",
    "Diff:",
    input.diff.patch || "(empty)",
  ].join("\n");
}

export class LlmReviewerAgent implements ReviewerAgent {
  constructor(private readonly chat: ChatClient) {}

  async review(input: ReviewerInput): Promise<ReviewerReport | undefined> {
    const text = await this.chat.complete({
      json: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: reviewerPrompt(input) },
      ],
    });
    return parseReviewerReport(parseJsonObject(text));
  }
}
