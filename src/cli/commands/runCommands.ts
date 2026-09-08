import type { AgentEngine, AgentResult } from "../../agent/types.js";
import { buildAgentContext } from "../../agent/contextBuilder.js";
import type { Repository } from "../../domain/repository.js";
import type { Task } from "../../domain/task.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { TaskStore } from "../../store/taskStore.js";
import { makeId } from "../../util/id.js";
import type { ManagedWorkspace, WorkspaceManager } from "../../workspace/manager.js";
import type { VerificationResult, Verifier } from "../../verification/runner.js";

export interface RunTaskOutcome {
  runId: string;
  task: Task;
  repository: Repository;
  workspace: ManagedWorkspace;
  result: AgentResult;
  verification: VerificationResult;
  succeeded: boolean;
}

export interface RunTaskParams {
  tasks: TaskStore;
  repositories: RepositoryStore;
  workspaceManager: WorkspaceManager;
  engine: AgentEngine;
  verifier: Verifier;
  taskId: string;
}

/**
 * Manual run (plan Phase 4, `ai run TASK-001`):
 * Task -> Workspace -> Context -> Codex -> Result.
 * Verification is intentionally not part of this phase.
 */
export async function runTaskCommand(params: RunTaskParams): Promise<RunTaskOutcome> {
  const task = await params.tasks.findTask(params.taskId);
  const repository = await params.repositories.findRepository(task.repositoryId);
  const runId = makeId("run");
  const workspace = await params.workspaceManager.createWorkspace({
    repositoryLocalPath: repository.localPath,
    taskId: task.id,
    runId,
  });
  const context = await buildAgentContext({
    runId,
    task,
    repository,
    workspacePath: workspace.path,
  });
  const result = await params.engine.execute(context);
  const verification = await params.verifier.run({
    workspacePath: workspace.path,
    commands: repository.verificationCommands,
  });
  return {
    runId,
    task,
    repository,
    workspace,
    result,
    verification,
    succeeded: verification.passed,
  };
}
