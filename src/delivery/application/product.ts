import type { Run } from "../../domain/run.js";
import type { Task } from "../../domain/task.js";
import { extractWorkspacesInfo } from "../../workspace/info.js";

/**
 * TASK-1267: the delivery as the user is looking at it — one Run's worktree.
 */
export interface DeliveryProduct {
  task: Task;
  run: Run;
  /** Host path of the worktree that Run left behind. */
  path: string;
  /** Branch that worktree was built on (`ai/<taskId>-<runId>`). */
  branch: string;
  /** Files the Round changed — the part a revision must not lose. */
  files: string[];
}

export interface DeliveryProductDeps {
  listRuns(filter: { taskId: string }): Promise<Run[]>;
}

/**
 * TASK-1267: "the delivery" is not an abstract aggregate — it is concrete
 * content, and the test branch is pushed from a Run's worktree. A revision has
 * to start from that same content, so both read the product from here.
 *
 * The **newest** SUCCEEDED Run wins. That used to be "the first task with a
 * worktree", which is wrong as soon as there is a revision chain: the newest
 * revision is the delivery, and pushing an older worktree would hide it.
 */
export async function latestDeliveryProduct(
  tasks: Task[],
  runs: DeliveryProductDeps,
): Promise<DeliveryProduct | undefined> {
  let best: DeliveryProduct | undefined;
  for (const task of tasks) {
    const history = await runs.listRuns({ taskId: task.id }).catch(() => []);
    for (const run of history) {
      if (run.status !== "SUCCEEDED") {
        continue;
      }
      const workspace = extractWorkspacesInfo(run)[0];
      if (!workspace?.path) {
        continue;
      }
      if (!best || isNewer(run, best.run)) {
        best = {
          task,
          run,
          path: workspace.path,
          branch: workspace.branch,
          files: changedFilesOf(run),
        };
      }
    }
  }
  return best;
}

function isNewer(candidate: Run, current: Run): boolean {
  const left = candidate.finishedAt ?? candidate.startedAt ?? candidate.createdAt;
  const right = current.finishedAt ?? current.startedAt ?? current.createdAt;
  // ISO-8601 timestamps compare correctly as strings. The id breaks ties so the
  // choice is stable across calls rather than dependent on iteration order.
  return left === right ? candidate.id > current.id : left > right;
}

/** The files a Run changed, from the diff evidence the harness collected. */
export function changedFilesOf(run: Run): string[] {
  const result = asRecord(run.result);
  const diff = asRecord(result?.diff);
  const files = diff?.files;
  return Array.isArray(files)
    ? files.filter((file): file is string => typeof file === "string" && file.length > 0)
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
