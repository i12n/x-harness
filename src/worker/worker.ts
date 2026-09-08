import type { AgentEngine, AgentResult } from "../agent/types.js";
import { buildAgentContext } from "../agent/contextBuilder.js";
import type { Repository } from "../domain/repository.js";
import type { Run } from "../domain/run.js";
import type { Task } from "../domain/task.js";
import { WorkerExecutionError } from "../errors.js";
import type { RepositoryStore } from "../store/repositoryStore.js";
import type { RunStore } from "../store/runStore.js";
import type { TaskStore } from "../store/taskStore.js";
import type { VerificationResult, Verifier } from "../verification/runner.js";
import type { ManagedWorkspace, WorkspaceManager } from "../workspace/manager.js";

export interface WorkerOptions {
  runStore: RunStore;
  taskStore: TaskStore;
  repositoryStore: RepositoryStore;
  workspaceManager: WorkspaceManager;
  agentEngine: AgentEngine;
  verifier: Verifier;
  workerId?: string;
  heartbeatMs?: number;
  leaseSeconds?: number;
}

export interface ExecuteRunOutcome {
  run: Run;
  task: Task;
  agentResult: AgentResult;
  verification: VerificationResult;
  workspace: ManagedWorkspace;
}

/**
 * Worker (plan section 十三): claim Run -> create Workspace -> build Context
 * -> run Codex -> Verification -> save Result. Keeps the lease alive with
 * heartbeats while executing.
 */
export class Worker {
  private readonly runStore: RunStore;
  private readonly taskStore: TaskStore;
  private readonly repositoryStore: RepositoryStore;
  private readonly workspaceManager: WorkspaceManager;
  private readonly agentEngine: AgentEngine;
  private readonly verifier: Verifier;
  private readonly workerId: string;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;

  constructor(options: WorkerOptions) {
    this.runStore = options.runStore;
    this.taskStore = options.taskStore;
    this.repositoryStore = options.repositoryStore;
    this.workspaceManager = options.workspaceManager;
    this.agentEngine = options.agentEngine;
    this.verifier = options.verifier;
    this.workerId =
      options.workerId ?? process.env.AI_WORKER_ID ?? `worker-${process.pid}`;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.leaseMs = (options.leaseSeconds ?? 30) * 1000;
  }

  async executeRun(runId: string): Promise<ExecuteRunOutcome> {
    const claimed = await this.runStore.claimRun(
      runId,
      this.workerId,
      isoIn(this.leaseMs),
    );
    const heartbeat = this.startHeartbeat(runId);
    try {
      const task = await this.taskStore.findTask(claimed.taskId);
      await this.taskStore.updateTaskStatus(task.id, "RUNNING");
      await this.runStore.markRunning(runId);

      const repository = await this.repositoryStore.findRepository(task.repositoryId);
      const workspace = await this.workspaceManager.createWorkspace({
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
      const agentResult = await this.agentEngine.execute(context);

      await this.runStore.updateRunStatus(runId, "VERIFYING");
      await this.taskStore.updateTaskStatus(task.id, "VERIFYING");
      const verification = await this.verifier.run({
        workspacePath: workspace.path,
        commands: repository.verificationCommands,
      });

      const finishedAt = new Date().toISOString();
      if (verification.passed) {
        await this.runStore.completeRun(runId, {
          status: "SUCCEEDED",
          exitCode: agentResult.exitCode,
          result: {
            agentStdout: truncate(agentResult.stdout, 100_000),
            agentStderr: truncate(agentResult.stderr, 100_000),
            verification,
          },
          finishedAt,
        });
        await this.taskStore.updateTaskStatus(task.id, "REVIEW");
      } else {
        await this.failRun(
          runId,
          task,
          claimed,
          repository,
          agentResult,
          verification,
          finishedAt,
        );
      }

      const finalRun = await this.runStore.findRun(runId);
      const finalTask = await this.taskStore.findTask(task.id);
      return {
        run: finalRun,
        task: finalTask,
        agentResult,
        verification,
        workspace,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const task = await this.taskStore.findTask(claimed.taskId);
        await this.runStore.completeRun(runId, {
          status: "FAILED",
          error: { message },
          finishedAt: new Date().toISOString(),
        });
        await this.recoverTask(task, claimed.attempt);
      } catch {
        // Persisting the failure must not hide the original error.
      }
      throw new WorkerExecutionError(`worker failed run ${runId}: ${message}`);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async failRun(
    runId: string,
    task: Task,
    run: Run,
    repository: Repository,
    agentResult: AgentResult,
    verification: VerificationResult,
    finishedAt: string,
  ): Promise<void> {
    await this.runStore.completeRun(runId, {
      status: "FAILED",
      exitCode: agentResult.exitCode,
      result: {
        agentStdout: truncate(agentResult.stdout, 100_000),
        agentStderr: truncate(agentResult.stderr, 100_000),
      },
      error: {
        verification: verification.checks.map((check) => ({
          command: check.command,
          status: check.status,
          exitCode: check.exitCode,
          output: truncate(check.output, 20_000),
        })),
        repository: repository.id,
      },
      finishedAt,
    });
    await this.recoverTask(task, run.attempt);
  }

  /** FAILED -> READY while attempts remain, otherwise -> BLOCKED. */
  private async recoverTask(task: Task, attempt: number): Promise<void> {
    const next: Task["status"] = attempt >= task.maxAttempts ? "BLOCKED" : "READY";
    await this.taskStore.updateTaskStatus(task.id, next);
  }

  private startHeartbeat(runId: string): NodeJS.Timeout {
    return setInterval(() => {
      this.runStore.touchLease(runId, isoIn(this.leaseMs)).catch(() => {
        // A failed heartbeat is surfaced later by lease recovery.
      });
    }, this.heartbeatMs);
  }
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}
