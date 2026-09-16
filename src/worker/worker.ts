import type { AgentEngine, AgentResult } from "../agent/types.js";
import { buildAgentContext } from "../agent/contextBuilder.js";
import type { Repository } from "../domain/repository.js";
import { defaultExecutionProfile } from "../domain/executionProfile.js";
import type { Run } from "../domain/run.js";
import type { Task } from "../domain/task.js";
import { HarnessError, WorkerExecutionError } from "../errors.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
  toExecutionContext,
} from "../execution/manager.js";
import type { ExecutionEnvironment } from "../execution/manager.js";
import type { EventStore } from "../store/eventStore.js";
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
  executionManager?: ExecutionManager;
  eventStore?: EventStore;
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
  private readonly executionManager: ExecutionManager;
  private readonly events: EventStore | undefined;
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
    this.executionManager =
      options.executionManager ?? new ExecutionManager(new LocalExecutionDriver());
    this.events = options.eventStore;
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
    await this.emit("RunStarted", {
      taskId: claimed.taskId,
      runId,
      payload: { workerId: this.workerId, attempt: claimed.attempt },
    });
    let environment: ExecutionEnvironment | undefined;
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
      environment = await this.executionManager.prepare({
        runId,
        workspacePath: workspace.path,
        profile: repository.executionProfile ?? defaultExecutionProfile(),
      });
      if (environment.containerId) {
        throw new HarnessError(
          `containerized execution requires a container-aware AgentEngine ` +
            `(execution ${environment.id}); see TASK-910`,
        );
      }
      const execution = toExecutionContext(environment);
      await this.emit("execution.prepared", {
        taskId: task.id,
        runId,
        payload: { executionId: execution.executionId, driver: execution.driver },
      });

      const context = {
        ...(await buildAgentContext({
          runId,
          task,
          repository,
          workspacePath: workspace.path,
        })),
        execution,
      };
      await this.emit("AgentStarted", {
        taskId: task.id,
        runId,
        payload: { agent: "codex", engine: "codex", workspace: workspace.path },
      });
      const agentResult = await this.agentEngine.execute(context);
      await this.emit("AgentFinished", {
        taskId: task.id,
        runId,
        payload: { exitCode: agentResult.exitCode, signal: agentResult.signal },
      });

      await this.runStore.updateRunStatus(runId, "VERIFYING");
      await this.taskStore.updateTaskStatus(task.id, "VERIFYING");
      await this.emit("VerificationStarted", { taskId: task.id, runId });
      const verification = await this.verifier.run({
        workspacePath: workspace.path,
        workdir: execution.workdir,
        commands: repository.verificationCommands,
      });
      await this.emit(
        verification.passed ? "VerificationPassed" : "VerificationFailed",
        {
          taskId: task.id,
          runId,
          payload: {
            passed: verification.passed,
            checks: verification.checks.map((check) => ({
              command: check.command,
              status: check.status,
            })),
          },
        },
      );

      const finishedAt = new Date().toISOString();
      if (verification.passed) {
        await this.runStore.completeRun(runId, {
          status: "SUCCEEDED",
          exitCode: agentResult.exitCode,
          result: {
            workspace: { path: workspace.path, branch: workspace.branch },
            agentStdout: truncate(agentResult.stdout, 100_000),
            agentStderr: truncate(agentResult.stderr, 100_000),
            verification,
          },
          finishedAt,
        });
        await this.taskStore.updateTaskStatus(task.id, "REVIEW");
        await this.emit("RunSucceeded", { taskId: task.id, runId });
        await this.emit("TaskReview", { taskId: task.id, runId });
      } else {
        await this.failRun(
          runId,
          task,
          claimed,
          repository,
          agentResult,
          verification,
          workspace,
          finishedAt,
        );
        await this.emit("RunFailed", {
          taskId: task.id,
          runId,
          payload: { reason: "verification failed" },
        });
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
        await this.emit("RunFailed", {
          taskId: claimed.taskId,
          runId,
          payload: { reason: message },
        });
        await this.recoverTask(task, claimed.attempt);
      } catch {
        // Persisting the failure must not hide the original error.
      }
      throw new WorkerExecutionError(`worker failed run ${runId}: ${message}`);
    } finally {
      if (environment) {
        try {
          await this.executionManager.cleanup(environment);
          await this.emit("execution.cleaned", {
            taskId: claimed.taskId,
            runId,
            payload: { executionId: environment.id, driver: environment.driver },
          });
        } catch {
          // Cleanup is best-effort; lease recovery handles leftovers.
        }
      }
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
    workspace: ManagedWorkspace,
    finishedAt: string,
  ): Promise<void> {
    await this.runStore.completeRun(runId, {
      status: "FAILED",
      exitCode: agentResult.exitCode,
      result: {
        workspace: { path: workspace.path, branch: workspace.branch },
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

  private async emit(
    type: string,
    input: { taskId: string; runId: string; payload?: unknown },
  ): Promise<void> {
    if (!this.events) {
      return;
    }
    try {
      await this.events.record({ type, taskId: input.taskId, runId: input.runId, payload: input.payload });
    } catch {
      // History must never break execution.
    }
  }
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}
