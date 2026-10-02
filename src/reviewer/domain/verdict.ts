import type { AcceptanceEvidence } from "../../verification/acceptance.js";

export const REVIEW_VERDICTS = ["approve", "request_changes", "needs_human"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export type CriterionStatus = "met" | "not_met" | "unverifiable";

export interface CriterionFinding {
  index: number;
  status: CriterionStatus;
  evidence: string;
}

/** What the reviewer agent concluded, always structured (never prose-only). */
export interface ReviewerReport {
  verdict: ReviewVerdict;
  criteria: CriterionFinding[];
  risks: string[];
  notes: string;
}

export type ReviewerMode = "off" | "shadow" | "on";

export type ReviewAction =
  | "auto_approve"
  | "retry"
  | "human_review"
  | "human_acceptance";

/**
 * TASK-1221: who decides, given the reviewer's verdict and the acceptance
 * evidence. Kept as a pure function so the policy is testable without a worker,
 * an LLM or a container.
 *
 * The invariants that make auto-approval safe:
 *   - the reviewer must actually approve;
 *   - every acceptance criterion must have executable proof — a criterion the
 *     machine could not judge always keeps a human in the loop;
 *   - `shadow`/`off` never change the task's status.
 */
export function decideReviewAction(
  report: ReviewerReport | undefined,
  acceptance: AcceptanceEvidence | undefined,
  mode: ReviewerMode,
): ReviewAction {
  if (mode !== "on") {
    return "human_review";
  }
  if (!report) {
    return "human_review";
  }
  if (report.verdict === "request_changes") {
    return "retry";
  }
  if (report.verdict === "needs_human") {
    return "human_review";
  }
  if (acceptance?.requiresHumanAcceptance) {
    return "human_acceptance";
  }
  return "auto_approve";
}

/** Parses the model's JSON defensively: a bad payload is "no verdict". */
export function parseReviewerReport(raw: unknown): ReviewerReport | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const verdict = record.verdict;
  if (typeof verdict !== "string" || !isVerdict(verdict)) {
    return undefined;
  }
  const criteria: CriterionFinding[] = [];
  for (const entry of asArray(record.criteria)) {
    const item = asRecord(entry);
    const index = item?.index;
    const status = item?.status;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      typeof status !== "string" ||
      !["met", "not_met", "unverifiable"].includes(status)
    ) {
      continue;
    }
    criteria.push({
      index,
      status: status as CriterionStatus,
      evidence: typeof item?.evidence === "string" ? item.evidence.trim() : "",
    });
  }
  return {
    verdict,
    criteria,
    risks: asArray(record.risks)
      .filter((risk): risk is string => typeof risk === "string")
      .map((risk) => risk.trim())
      .filter(Boolean),
    notes: typeof record.notes === "string" ? record.notes.trim() : "",
  };
}

export function isVerdict(value: string): value is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly string[]).includes(value);
}

/** One-line summary for chat and history. */
export function describeReviewerReport(report: ReviewerReport): string {
  const label =
    report.verdict === "approve"
      ? "✅ 评审通过"
      : report.verdict === "request_changes"
        ? "🔁 评审要求返工"
        : "🙋 评审需要人判断";
  const parts = [label];
  if (report.notes) {
    parts.push(report.notes);
  }
  if (report.risks.length > 0) {
    parts.push(`风险：${report.risks.join("；")}`);
  }
  return parts.join(" —— ");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
