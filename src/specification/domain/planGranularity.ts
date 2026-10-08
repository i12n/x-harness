import type { SpecificationWorkItem } from "../../domain/specification.js";

/**
 * TASK-1232: what deserves to be a Task.
 *
 * A Task must be something a Run can *finish*: it has a change to make and a
 * way to prove it. Live evidence (dlv-487e422b44) showed what happens when the
 * planner turns scope constraints and acceptance criteria into Tasks — every
 * Run produces an empty diff, the reviewer asks for changes, retries are
 * exhausted and the Task ends BLOCKED, pinning its Delivery at IN_PROGRESS.
 *
 * The rules live here, in one deterministic place, so they are reproducible and
 * reviewable — the same principle as `reviewer/domain/risk.ts`.
 */

/** Phrasings that mark a *scope constraint* rather than a change to make. */
const CONSTRAINT_PATTERNS: RegExp[] = [
  /只(作用于|影响|针对|改|调整)/,
  /仅(作用于|影响|针对|限)/,
  /不(改变|影响|修改|动)/,
  /保持(不变|一致|原样)/,
  /不得|不允许|禁止/,
];

/** Phrasings that state a *judgement condition* (how we know it is done). */
const CRITERION_PATTERNS: RegExp[] = [
  /不(重叠|错位|报错|崩溃|丢|溢出|抖动)/,
  /(一致|一致地|稳定|正常|正确|可用|可访问)/,
  /(通过|不报错|无异常)/,
  /^(在|当|如果|若).*(时|下|后)/,
  /(大于|小于|不少于|不超过|达到|满足)/,
];

/**
 * A work item is deliverable when it asks for a change and can be proven.
 * Anything uncertain stays a Task (conservative: never swallow a deliverable).
 */
export function isDeliverable(item: SpecificationWorkItem): boolean {
  const text = `${item.title} ${item.description}`.trim();
  const hasChecks = item.checks.some((check) => check.trim().length > 0);
  const looksLikeConstraint = CONSTRAINT_PATTERNS.some((pattern) => pattern.test(text));
  const looksLikeCriterion = CRITERION_PATTERNS.some((pattern) => pattern.test(text));
  // A change with a way to prove it is the strongest signal there is — the
  // planner would not have attached executable checks to a mere constraint.
  if (hasChecks) {
    return true;
  }
  if (looksLikeConstraint || looksLikeCriterion) {
    return false;
  }
  // No checks and no explicit constraint wording: keep it (D5).
  return true;
}

export interface GranularityAdjustment {
  /** Items kept as Tasks. */
  items: SpecificationWorkItem[];
  /** What was merged away, for the audit event. */
  merged: { title: string; into: string }[];
}

/**
 * Merge non-deliverables into the nearest deliverable that precedes them, so
 * their wording is not lost — it becomes an acceptance criterion of the work
 * that actually has to happen. When no deliverable exists, everything is kept
 * (D5: never drop work because the classifier was unsure).
 */
export function mergeNonDeliverables(items: SpecificationWorkItem[]): GranularityAdjustment {
  const deliverableIdx = items
    .map((item, index) => (isDeliverable(item) ? index : -1))
    .filter((index) => index >= 0);
  if (deliverableIdx.length === 0) {
    return { items, merged: [] };
  }

  const merged: { title: string; into: string }[] = [];
  const targets = new Map<number, SpecificationWorkItem>(
    deliverableIdx.map((index) => [index, { ...items[index]! }]),
  );
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (isDeliverable(item)) {
      continue;
    }
    // The nearest deliverable before it, else the first one. Looked up by index
    // (not by object identity) because targets are replaced as they absorb text.
    const targetIndex =
      [...deliverableIdx].reverse().find((candidate) => candidate < index) ?? deliverableIdx[0]!;
    const target = targets.get(targetIndex)!;
    targets.set(targetIndex, {
      ...target,
      description: `${target.description}\n- ${item.description || item.title}`,
      acceptance: [...new Set([...target.acceptance, ...item.acceptance])],
      checks: [...new Set([...target.checks, ...item.checks])],
    });
    merged.push({ title: item.title, into: target.title });
  }
  return { items: deliverableIdx.map((index) => targets.get(index)!), merged };
}
