import { isExecutableCheck } from "../../domain/specification.js";
import type { SpecificationWorkItem } from "../../domain/specification.js";

/**
 * TASK-1224: the model proposes work items; the harness decides which of them
 * can become tasks. All rules here are mechanical on purpose — the point is
 * that a decomposition mistake (one change described three times) cannot turn
 * into three tasks just because a model wrote three paragraphs.
 *
 * Rules, in order:
 *   0. keep only executable checks; a work item whose checks were all prose is
 *      a check-less item (rule 2) instead of a Task that can never pass
 *   1. keep only in-range acceptance indices; drop items left with none
 *   2. an item without an executable check is not a deliverable — fold its
 *      acceptance into a neighbour instead of making a task out of it
 *   3. two items that prove exactly the same criteria are one deliverable
 *   4. every acceptance criterion must be covered; leftovers join the last item
 *   5. nothing survives -> an empty plan (the caller plans a single task)
 */
export function repairWorkItems(
  items: SpecificationWorkItem[],
  acceptanceCount: number,
): SpecificationWorkItem[] {
  const inRange = items
    .map((item) => ({
      ...item,
      acceptance: dedupeIndices(item.acceptance, acceptanceCount),
      checks: item.checks.filter(isExecutableCheck),
    }))
    .filter((item) => item.acceptance.length > 0);

  const merged = foldChecklessIntoNeighbours(inRange);
  const deduped = mergeSameAcceptance(merged);
  return coverRemaining(deduped, acceptanceCount)
    .map((item) => ({
      ...item,
      acceptance: dedupeIndices(item.acceptance, acceptanceCount),
    }))
    .filter((item) => item.acceptance.length > 0);
}

function dedupeIndices(indices: number[], count: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const index of indices) {
    if (index < 0 || index >= count || seen.has(index)) {
      continue;
    }
    seen.add(index);
    out.push(index);
  }
  return out.sort((a, b) => a - b);
}

/** Rule 2: a check-less item's criteria belong to a real deliverable. */
function foldChecklessIntoNeighbours(
  items: SpecificationWorkItem[],
): SpecificationWorkItem[] {
  const out: SpecificationWorkItem[] = [];
  let pending: number[] = [];
  for (const item of items) {
    if (item.checks.length === 0) {
      if (out.length > 0) {
        out[out.length - 1]!.acceptance.push(...item.acceptance);
      } else {
        pending.push(...item.acceptance);
      }
      continue;
    }
    out.push({ ...item, acceptance: [...pending, ...item.acceptance] });
    pending = [];
  }
  if (pending.length > 0) {
    if (out.length > 0) {
      out[out.length - 1]!.acceptance.push(...pending);
    } else {
      // Nothing had a check at all: one deliverable covering everything.
      out.push({
        title: "整体交付",
        description: "",
        acceptance: pending,
        checks: [],
      });
    }
  }
  return out;
}

/** Rule 3: identical proof sets are the same deliverable. */
function mergeSameAcceptance(items: SpecificationWorkItem[]): SpecificationWorkItem[] {
  const byKey = new Map<string, SpecificationWorkItem>();
  const order: string[] = [];
  for (const item of items) {
    const key = item.acceptance.join(",");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, acceptance: [...item.acceptance], checks: [...item.checks] });
      order.push(key);
      continue;
    }
    existing.checks = [...new Set([...existing.checks, ...item.checks])];
    if (!existing.description && item.description) {
      existing.description = item.description;
    }
  }
  return order.map((key) => byKey.get(key)!);
}

/** Rule 4: no criterion may be silently dropped. */
function coverRemaining(
  items: SpecificationWorkItem[],
  acceptanceCount: number,
): SpecificationWorkItem[] {
  const covered = new Set(items.flatMap((item) => item.acceptance));
  const missing: number[] = [];
  for (let index = 0; index < acceptanceCount; index += 1) {
    if (!covered.has(index)) {
      missing.push(index);
    }
  }
  if (missing.length === 0) {
    return items;
  }
  if (items.length === 0) {
    // Nothing to attach to: let the caller plan one task for the whole spec.
    return [];
  }
  const last = items[items.length - 1]!;
  last.acceptance = dedupeIndices([...last.acceptance, ...missing], acceptanceCount);
  return items;
}
