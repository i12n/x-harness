import type { RunStatus } from "../../domain/run.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { RunStore } from "../../store/runStore.js";
import type { TaskStore } from "../../store/taskStore.js";
import type { WorkspaceManager } from "../../workspace/manager.js";
import { extractWorkspaceInfo } from "../../workspace/info.js";

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
    const info = extractWorkspaceInfo(run);
    if (!info) {
      report.skipped.push({ runId: run.id, reason: "no workspace evidence" });
      continue;
    }
    try {
      const task = await params.tasks.findTask(run.taskId);
      const repository = await params.repositories.findRepository(task.repositoryId);
      await params.workspaceManager.removeWorkspace({
        path: info.path,
        repositoryLocalPath: repository.localPath,
      });
      report.removed.push(info.path);
    } catch (error) {
      report.skipped.push({
        runId: run.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
