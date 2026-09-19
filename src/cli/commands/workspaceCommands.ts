import type { RunStatus } from "../../domain/run.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { RunStore } from "../../store/runStore.js";
import type { TaskStore } from "../../store/taskStore.js";
import type { WorkspaceManager } from "../../workspace/manager.js";
import { extractWorkspacesInfo } from "../../workspace/info.js";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "LOST",
  "TIMED_OUT",
  "CANCELLED",
];

export interface CleanupWorkspacesParams {
  runs: RunStore;
  tasks: TaskStore;
  repositories: RepositoryStore;
  workspaceManager: WorkspaceManager;
}

export interface CleanupReport {
  removed: string[];
  skipped: { runId: string; reason: string }[];
}

/** Remove worktrees of terminal runs (evidence is in run result/error). */
export async function cleanupWorkspacesCommand(
  params: CleanupWorkspacesParams,
): Promise<CleanupReport> {
  const runs = await params.runs.listRuns({
    statuses: [...TERMINAL_RUN_STATUSES],
  });
  const report: CleanupReport = { removed: [], skipped: [] };

  for (const run of runs) {
    const workspaces = extractWorkspacesInfo(run);
    if (workspaces.length === 0) {
      report.skipped.push({ runId: run.id, reason: "no workspace evidence" });
      continue;
    }
    const task = await params.tasks.findTask(run.taskId);
    const targetById = new Map(task.targets.map((target) => [target.id, target]));
    for (const workspace of workspaces) {
      try {
        const repositoryId =
          (workspace.targetId ? targetById.get(workspace.targetId)?.repositoryId : undefined) ??
          task.repositoryId;
        const repository = await params.repositories.findRepository(repositoryId);
        await params.workspaceManager.removeWorkspace({
          path: workspace.path,
          repositoryLocalPath: repository.localPath,
        });
        report.removed.push(workspace.path);
      } catch (error) {
        report.skipped.push({
          runId: run.id,
          reason: `${workspace.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  }
  return report;
}
