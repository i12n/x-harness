import type { Task } from "./task.js";

/**
 * TASK-1267: a revision is what an acceptance-stage opinion becomes — one more
 * round of work on top of the delivery the user is looking at, instead of
 * sending finished tasks back to be implemented again.
 *
 * The record lives in `task.constraints.revision`, next to `reviews`, so it
 * needs no migration and travels with the task.
 */
const REVISION_KEY = "revision";

export interface RevisionRecord {
  /** Revision this one builds on, when a revision is itself revised. */
  baseRef?: string;
  baseRunId?: string;
  /** Files the previous round changed — the part that must not be lost. */
  previousFiles: string[];
}

export interface BuildRevisionInput {
  baseRef?: string;
  baseRunId?: string;
  previousFiles: string[];
}

export function buildRevision(input: BuildRevisionInput): Record<string, unknown> {
  const revision: RevisionRecord = {
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    ...(input.baseRunId ? { baseRunId: input.baseRunId } : {}),
    previousFiles: [...new Set(input.previousFiles)].sort(),
  };
  return { [REVISION_KEY]: revision };
}

export function readRevision(task: Pick<Task, "constraints">): RevisionRecord | undefined {
  const raw = task.constraints?.[REVISION_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const files = record.previousFiles;
  return {
    ...(typeof record.baseRef === "string" ? { baseRef: record.baseRef } : {}),
    ...(typeof record.baseRunId === "string" ? { baseRunId: record.baseRunId } : {}),
    previousFiles: Array.isArray(files)
      ? files.filter((file): file is string => typeof file === "string")
      : [],
  };
}

/**
 * The invariant that makes "the accepted part is frozen" real: a revision
 * starts from the previous content, so it must not end up deleting it. Returns
 * the sentence for the reviewer, or nothing when the run kept everything.
 */
export function describeRevisionRegression(
  task: Pick<Task, "constraints">,
  changedFiles: string[],
): string | undefined {
  const revision = readRevision(task);
  if (!revision || revision.previousFiles.length === 0) {
    return undefined;
  }
  const present = new Set(changedFiles);
  const lost = revision.previousFiles.filter((file) => !present.has(file));
  if (lost.length === 0) {
    return undefined;
  }
  const shown = lost.slice(0, 5).join("、");
  const more = lost.length > 5 ? ` 等 ${lost.length} 个` : "";
  return (
    `上一轮的改动被回退：${shown}${more} —— ` +
    "这一轮是对现有交付的修订，不能删掉已经验收通过的内容"
  );
}
