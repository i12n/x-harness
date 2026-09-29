import { isTerminalRunStatus } from "../domain/run.js";
import type { Run } from "../domain/run.js";
import type { EventStore } from "../store/eventStore.js";
import type { RepositoryStore } from "../store/repositoryStore.js";
import type { RunStore } from "../store/runStore.js";
import type { TaskStore } from "../store/taskStore.js";
import { extractWorkspacesInfo } from "../workspace/info.js";
import type { GitService, PublishOutcome } from "./gitService.js";

export interface GitPublishServiceDeps {
  tasks: TaskStore;
  runs: RunStore;
  repositories: RepositoryStore;
  git: GitService;
  events?: EventStore;
}

/**
 * Task → latest succeeded Run → its worktrees → commit + push.
 *
 * Only a *succeeded* Run is publishable: a failed verification is not evidence
 * that the change is worth putting on the remote.
 */
export class GitPublishService {
  constructor(private readonly deps: GitPublishServiceDeps) {}

  async publishTask(taskId: string): Promise<PublishOutcome[]> {
    const task = await this.deps.tasks.findTask(taskId);
    const runs = await this.deps.runs.listRuns({ taskId });
    const run = runs[runs.length - 1];
    if (!run || !isTerminalRunStatus(run.status) || run.status !== "SUCCEEDED") {
      return [
        {
          repositoryId: "-",
          branch: "",
          remote: "origin",
          filesChanged: 0,
          committed: false,
          pushed: false,
          skipped: "no_workspace",
          message: `task ${taskId} 没有成功的 Run 可发布`,
        },
      ];
    }

    const workspaces = extractWorkspacesInfo(run);
    if (workspaces.length === 0) {
      return [
        {
          repositoryId: "-",
          branch: "",
          remote: "origin",
          filesChanged: 0,
          committed: false,
          pushed: false,
          skipped: "no_workspace",
          message: `run ${run.id} 没有记录 workspace 证据`,
        },
      ];
    }

    const message = publishMessage(taskId, task.title, run);
    const outcomes: PublishOutcome[] = [];
    for (const workspace of workspaces) {
      const target = task.targets.find((entry) => entry.id === workspace.targetId);
      const repositoryId = target?.repositoryId ?? task.repositoryId;
      const repository = await this.deps.repositories.findRepository(repositoryId);
      outcomes.push(
        await this.deps.git.publishWorkspace({
          repository,
          workspacePath: workspace.path,
          targetId: workspace.targetId,
          message,
        }),
      );
    }

    await this.audit(taskId, run, outcomes);
    return outcomes;
  }

  private async audit(
    taskId: string,
    run: Run,
    outcomes: PublishOutcome[],
  ): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    try {
      await this.deps.events.record({
        type: "git.published",
        taskId,
        runId: run.id,
        payload: outcomes.map((outcome) => ({
          repositoryId: outcome.repositoryId,
          targetId: outcome.targetId,
          branch: outcome.branch,
          commit: outcome.commit,
          pushed: outcome.pushed,
          skipped: outcome.skipped,
        })),
      });
    } catch {
      // Publishing already happened; history must not undo it.
    }
  }
}

/** Commit message; includes the harness ids so GitHub links back to a Task. */
export function publishMessage(taskId: string, title: string, run: Run): string {
  const lines = [
    `${title}`,
    "",
    `AI Harness task: ${taskId}`,
    `Run: ${run.id} (attempt ${run.attempt})`,
  ];
  if (typeof run.exitCode === "number") {
    lines.push(`Agent exit code: ${run.exitCode}`);
  }
  return lines.join("\n");
}
