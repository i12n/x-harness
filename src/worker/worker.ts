import type { AgentEngine, AgentResult } from "../agent/types.js";
import { buildAgentContext } from "../agent/contextBuilder.js";
import type { Repository } from "../domain/repository.js";
import { defaultExecutionProfile } from "../domain/executionProfile.js";
import type { TaskTarget } from "../domain/taskTarget.js";
import type { Run } from "../domain/run.js";
import type { Task, TaskStatus } from "../domain/task.js";
import {
  ExecutionCancelledError,
  ExecutionTimeoutError,
  WorkerExecutionError,
} from "../errors.js";
import { acceptanceChecksOf, buildAcceptanceEvidence } from "../verification/acceptance.js";
import type { AcceptanceEvidence } from "../verification/acceptance.js";
import { collectGitDiff } from "../verification/diff.js";
import type { CollectedDiff } from "../verification/diff.js";
import type { ReviewerAgent } from "../reviewer/application/reviewerAgent.js";
import type { ReviewerMode, ReviewerReport } from "../reviewer/domain/verdict.js";
import { decideReviewAction, describeReviewerReport } from "../reviewer/domain/verdict.js";
import { assessChangeRisk } from "../reviewer/domain/risk.js";
import type { ChangeRisk } from "../reviewer/domain/risk.js";
import { assessTestEvidence, describeTestEvidence } from "../reviewer/domain/testEvidence.js";
import type { TestEvidence } from "../reviewer/domain/testEvidence.js";
import { parseAgentUsage } from "../agent/usage.js";
import type { ReviewService } from "../review/application/reviewService.js";

/** TASK-1219: default Run cap; `AI_RUN_TIMEOUT_MS=0` disables it. */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000;
import type { ExecutionStatus } from "../domain/execution.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
  toExecutionContext,
} from "../execution/manager.js";
import type { ExecutionEnvironment } from "../execution/manager.js";
import {
  CONTAINER_PRIMARY_WORKSPACE,
  CONTAINER_TARGETS_ROOT,
} from "../execution/mounts.js";
import type { ExecutionMount } from "../execution/mounts.js";
import type { EventStore } from "../store/eventStore.js";
import type { RepositoryStore } from "../store/repositoryStore.js";
import type { RunStore } from "../store/runStore.js";
import type { TaskStore } from "../store/taskStore.js";
import type { VerificationResult, Verifier } from "../verification/runner.js";
import {
  TargetVerifier,
  type TargetVerificationResult,
} from "../verification/targetVerifier.js";
import type { ManagedWorkspace, WorkspaceManager } from "../workspace/manager.js";
import type { ContextTarget } from "../agent/contextBuilder.js";

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
  executionTimeoutMs?: number;
  /**
   * TASK-1221: the reviewer agent and the review transitions it may trigger.
   * Absent (or `reviewerMode: "off"`) keeps the pre-1221 behaviour: every
   * passing Run waits for a human.
   */
  reviewer?: ReviewerAgent;
  reviewerMode?: ReviewerMode;
  reviews?: ReviewService;
}

export interface ExecuteRunOutcome {
  run: Run;
  task: Task;
  agentResult: AgentResult;
  verification: VerificationResult;
  /** Primary workspace (kept for backward compatibility). */
  workspace: ManagedWorkspace;
  workspaces: ManagedWorkspace[];
  targets: TargetVerificationResult[];
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
  private readonly targetVerifier: TargetVerifier;
  private readonly executionManager: ExecutionManager;
  private readonly events: EventStore | undefined;
  private readonly workerId: string;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly executionTimeoutMs: number;
  private readonly reviewer: ReviewerAgent | undefined;
  private readonly reviewerMode: ReviewerMode;
  private readonly reviews: ReviewService | undefined;

  constructor(options: WorkerOptions) {
    this.runStore = options.runStore;
    this.taskStore = options.taskStore;
    this.repositoryStore = options.repositoryStore;
    this.workspaceManager = options.workspaceManager;
    this.agentEngine = options.agentEngine;
    this.verifier = options.verifier;
    this.targetVerifier = new TargetVerifier(options.verifier);
    this.executionManager =
      options.executionManager ?? new ExecutionManager(new LocalExecutionDriver());
    this.events = options.eventStore;
    this.workerId =
      options.workerId ?? process.env.AI_WORKER_ID ?? `worker-${process.pid}`;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.leaseMs = (options.leaseSeconds ?? 30) * 1000;
    this.executionTimeoutMs =
      options.executionTimeoutMs ??
      // TASK-1219: auto-start multiplies the cost of a runaway Run, so the
      // default is a 30-minute cap instead of "no timeout". Set 0 to disable.
      Number(process.env.AI_RUN_TIMEOUT_MS ?? DEFAULT_EXECUTION_TIMEOUT_MS);
    this.reviewer = options.reviewer;
    this.reviewerMode = options.reviewerMode ?? "off";
    this.reviews = options.reviews;
  }

  async executeRun(
    runId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExecuteRunOutcome> {
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
    let terminalStatus: "TIMED_OUT" | "CANCELLED" | undefined;
    let runWorkspaces: ManagedWorkspace[] = [];
    let runTargets: { target: TaskTarget; repository: Repository }[] = [];
    // Cancellation is a persisted control intent; the heartbeat polls it and
    // aborts the in-process execution when a request appears.
    const cancelController = new AbortController();
    const forwardAbort = (): void => cancelController.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    const heartbeat = this.startHeartbeat(runId, () => cancelController.abort());
    try {
      const task = await this.taskStore.findTask(claimed.taskId);
      await this.taskStore.updateTaskStatus(task.id, "RUNNING");
      await this.runStore.markRunning(runId);

      // Phase 10 / TASK-1009: one Run executes every target once — one
      // execution, N workspaces, one agent, N target verifications.
      const orderedTargets: { target: TaskTarget; repository: Repository }[] = [];
      for (const target of [...task.targets].sort((a, b) => a.position - b.position)) {
        orderedTargets.push({
          target,
          repository: await this.repositoryStore.findRepository(target.repositoryId),
        });
      }
      const primaryTarget =
        orderedTargets.find(({ target }) => target.role === "primary") ??
        orderedTargets[0];
      if (!primaryTarget) {
        throw new WorkerExecutionError(`task ${task.id} has no targets`);
      }
      runTargets = orderedTargets;

      const workspaces = await this.workspaceManager.createRunWorkspaces({
        taskId: task.id,
        runId,
        targets: orderedTargets.map(({ target, repository }) => ({
          targetId: target.id,
          repositoryLocalPath: repository.localPath,
          position: target.position,
          baseRef: target.baseRef,
        })),
      });
      runWorkspaces = workspaces;
      const workspaceByTarget = new Map(
        workspaces.map((workspace) => [workspace.targetId ?? "primary", workspace]),
      );
      const primaryWorkspace = workspaceByTarget.get(primaryTarget.target.id);
      if (!primaryWorkspace) {
        throw new WorkerExecutionError(
          `primary workspace missing for target ${primaryTarget.target.id}`,
        );
      }

      const mounts: ExecutionMount[] = orderedTargets.map(({ target }) => {
        const workspace = workspaceByTarget.get(target.id);
        if (!workspace) {
          throw new WorkerExecutionError(`workspace missing for target ${target.id}`);
        }
        return {
          targetId: target.id,
          source: workspace.path,
          target:
            target.role === "primary"
              ? CONTAINER_PRIMARY_WORKSPACE
              : `${CONTAINER_TARGETS_ROOT}/${target.id}`,
          primary: target.role === "primary",
        };
      });

      environment = await this.executionManager.prepare({
        runId,
        profile:
          primaryTarget.repository.executionProfile ?? defaultExecutionProfile(),
        mounts,
        primaryTargetId: primaryTarget.target.id,
        // TASK-1238: reuse this repository's npm/build caches across Runs.
        cacheKey: primaryTarget.repository.id,
      });
      const preparedEnvironment = environment;
      const exec = (
        command: string[],
        options?: Parameters<ExecutionManager["exec"]>[2],
      ) => this.executionManager.exec(preparedEnvironment, command, options);
      const execution = toExecutionContext(preparedEnvironment, exec);

      const contextTargets: ContextTarget[] = orderedTargets.map(
        ({ target, repository }) => {
          const workspace = workspaceByTarget.get(target.id)!;
          return {
            targetId: target.id,
            repository,
            role: target.role,
            branch: workspace.branch,
            workdir: execution.workdirs?.[target.id] ?? execution.workdir,
            hostWorkspacePath: workspace.path,
          };
        },
      );
      const context = {
        ...(await buildAgentContext({
          runId,
          task,
          targets: contextTargets,
          primaryTargetId: primaryTarget.target.id,
        })),
        execution,
      };
      await this.emit("AgentStarted", {
        taskId: task.id,
        runId,
        payload: {
          agent: "codex",
          engine: "codex",
          workspaces: workspaces.map((workspace) => workspace.path),
        },
      });
      const agentOutcome = await this.runAgent(runId, context, cancelController.signal);
      if (agentOutcome === "TIMED_OUT" || agentOutcome === "CANCELLED") {
        terminalStatus = agentOutcome;
        await this.executionManager.stop(environment);
        await this.executionManager.finish(environment, agentOutcome, agentOutcome);
        await this.runStore.completeRun(runId, {
          status: agentOutcome,
          result: {
            workspace: {
              path: primaryWorkspace.path,
              branch: primaryWorkspace.branch,
            },
            workspaces: workspaces.map((workspace) => ({
              targetId: workspace.targetId,
              path: workspace.path,
              branch: workspace.branch,
            })),
          },
          error: {
            reason: agentOutcome === "TIMED_OUT" ? "timeout" : "cancel",
            message: `execution ${agentOutcome.toLowerCase()}`,
          },
          finishedAt: new Date().toISOString(),
        });
        await this.emit(agentOutcome === "TIMED_OUT" ? "RunTimedOut" : "RunCancelled", {
          taskId: task.id,
          runId,
        });
        await this.recoverTask(task, claimed.attempt);
        await this.cleanupRunWorkspaces(runId, task.id, runWorkspaces, runTargets);
        throw new WorkerExecutionError(
          `run ${runId} ${agentOutcome.toLowerCase()}`,
        );
      }
      const agentResult = agentOutcome;
      await this.emit("AgentFinished", {
        taskId: task.id,
        runId,
        payload: { exitCode: agentResult.exitCode, signal: agentResult.signal },
      });

      await this.runStore.updateRunStatus(runId, "VERIFYING");
      await this.taskStore.updateTaskStatus(task.id, "VERIFYING");
      await this.emit("VerificationStarted", { taskId: task.id, runId });
      const targetResults = await this.targetVerifier.verifyTargets(
        orderedTargets.map(({ target, repository }) => ({
          targetId: target.id,
          repositoryId: repository.id,
          repositoryName: repository.name,
          role: target.role,
          workdir: execution.workdirs?.[target.id] ?? execution.workdir,
          commands: repository.verificationCommands,
          // TASK-1220: the Task's own checks (from its work item) run too.
          acceptanceChecks: acceptanceChecksOf(task.constraints),
          exec,
        })),
      );
      const verification = aggregateVerification(targetResults);
      const acceptance = buildAcceptanceEvidence(
        task.acceptance,
        acceptanceChecksOf(task.constraints),
      );
      // TASK-1221: review the change against the criteria, using evidence the
      // harness collected itself. TASK-1235: read the diff from the host-side
      // worktree — the container cannot see the worktree's gitdir.
      const diff = await collectGitDiff(execution.workspacePath);
      // TASK-1222: some changes must not be waved through, whatever the
      // reviewer thinks of them.
      const risk = assessChangeRisk(diff.files);
      // TASK-1225: production code changed without a single test change is a
      // risk the reviewer easily misses, so it is stated, not left implicit.
      const testEvidence = assessTestEvidence(diff.files);
      const testEvidenceReason = describeTestEvidence(testEvidence);
      if (testEvidenceReason && primaryTarget.repository.verificationCommands.length > 0) {
        risk.level = "high";
        risk.reasons.push(testEvidenceReason);
      }
      const review = await this.runReviewer(
        { task, acceptance, verification, diff, testEvidence },
        runId,
      );
      // TASK-1215 (①): keep the usage codex reported, so cost is answerable.
      const usage = parseAgentUsage(agentResult.stdout);
      if (usage) {
        await this.emit("RunUsage", {
          taskId: task.id,
          runId,
          payload: usage,
        });
      }
      await this.emit(
        verification.passed ? "VerificationPassed" : "VerificationFailed",
        {
          taskId: task.id,
          runId,
          payload: {
            passed: verification.passed,
            targets: targetResults.map((result) => ({
              targetId: result.targetId,
              repositoryId: result.repositoryId,
              passed: result.passed,
              checks: result.checks.map((check) => ({
                command: check.command,
                status: check.status,
              })),
            })),
          },
        },
      );

      const finishedAt = new Date().toISOString();
      if (verification.passed) {
        await this.executionManager.finish(environment, "SUCCEEDED");
        await this.runStore.completeRun(runId, {
          status: "SUCCEEDED",
          exitCode: agentResult.exitCode,
          result: {
            workspace: {
              path: primaryWorkspace.path,
              branch: primaryWorkspace.branch,
            },
            workspaces: workspaces.map((workspace) => ({
              targetId: workspace.targetId,
              path: workspace.path,
              branch: workspace.branch,
            })),
            targets: targetResults,
            agentStdout: truncate(agentResult.stdout, 100_000),
            agentStderr: truncate(agentResult.stderr, 100_000),
            verification,
            acceptance,
            diff,
            review,
            risk,
            ...(usage ? { usage } : {}),
          },
          finishedAt,
        });
        await this.emit("RunSucceeded", { taskId: task.id, runId });
        await this.settleAfterReview({
          task,
          runId,
          attempt: claimed.attempt,
          review,
          acceptance,
          risk,
        });
      } else {
        await this.executionManager.finish(environment, "FAILED", "verification failed");
        await this.failRun(
          runId,
          task,
          claimed,
          primaryTarget.repository,
          agentResult,
          verification,
          primaryWorkspace,
          workspaces,
          targetResults,
          finishedAt,
        );
        await this.emit("RunFailed", {
          taskId: task.id,
          runId,
          payload: { reason: "verification failed" },
        });
        await this.cleanupRunWorkspaces(runId, task.id, runWorkspaces, runTargets);
      }

      const finalRun = await this.runStore.findRun(runId);
      const finalTask = await this.taskStore.findTask(task.id);
      return {
        run: finalRun,
        task: finalTask,
        agentResult,
        verification,
        workspace: primaryWorkspace,
        workspaces,
        targets: targetResults,
      };
    } catch (error) {
      if (terminalStatus) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      try {
        const task = await this.taskStore.findTask(claimed.taskId);
        if (environment) {
          await this.executionManager.finish(environment, "FAILED", message);
        }
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
        await this.cleanupRunWorkspaces(runId, claimed.taskId, runWorkspaces, runTargets);
      } catch {
        // Persisting the failure must not hide the original error.
      }
      throw new WorkerExecutionError(`worker failed run ${runId}: ${message}`);
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
      if (environment) {
        try {
          await this.executionManager.cleanup(environment);
        } catch {
          // Cleanup is best-effort; lease recovery handles leftovers.
        }
      }
      clearInterval(heartbeat);
    }
  }

  /**
   * TASK-1221: a structured verdict from the reviewer agent. A failure here
   * never fails the Run — the human path is still available.
   */
  private async runReviewer(input: {
    task: Task;
    acceptance: AcceptanceEvidence;
    verification: VerificationResult;
    diff: CollectedDiff;
    testEvidence?: TestEvidence;
  }, runId: string): Promise<ReviewerReport | undefined> {
    if (!this.reviewer || this.reviewerMode === "off") {
      return undefined;
    }
    try {
      return await this.reviewer.review({
        task: {
          id: input.task.id,
          title: input.task.title,
          description: input.task.description,
          acceptance: input.task.acceptance,
        },
        acceptance: input.acceptance,
        verification: {
          passed: input.verification.passed,
          checks: input.verification.checks.map((check) => ({
            command: check.command,
            status: check.status,
          })),
        },
        diff: input.diff,
        ...(input.testEvidence ? { testEvidence: input.testEvidence } : {}),
      });
    } catch (error) {
      await this.emit("ReviewerFailed", {
        taskId: input.task.id,
        runId,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      return undefined;
    }
  }

  /**
   * TASK-1221: turn the verdict into a task status. Auto-approval happens only
   * when the policy allows it; **publishing is deliberately not part of it** —
   * pushing stays a human action (review.approve).
   */
  private async settleAfterReview(input: {
    task: Task;
    runId: string;
    attempt: number;
    review?: ReviewerReport;
    acceptance: AcceptanceEvidence;
    risk?: ChangeRisk;
  }): Promise<void> {
    const { task, runId, review, acceptance } = input;
    await this.taskStore.updateTaskStatus(task.id, "REVIEW");
    const risk = input.risk ?? { level: "low" as const, reasons: [] };
    const action = decideReviewAction(review, acceptance, this.reviewerMode, risk);
    if (review) {
      try {
        await this.taskStore.appendTaskReview(task.id, {
          at: new Date().toISOString(),
          runId,
          text: describeReviewerReport(review),
        });
      } catch {
        // History must never break the Run.
      }
    }
    await this.emit("TaskReview", {
      taskId: task.id,
      runId,
      payload: { action, verdict: review?.verdict ?? null, risk },
    });

    if (action === "auto_approve" && this.reviews) {
      await this.reviews.approve(
        task.id,
        { channel: "reviewer-agent", userId: "reviewer-agent" },
        review?.notes,
      );
      await this.emit("ReviewAutoApproved", { taskId: task.id, runId });
      return;
    }
    if (action === "retry") {
      const next: TaskStatus = input.attempt >= task.maxAttempts ? "BLOCKED" : "READY";
      await this.taskStore.updateTaskStatus(task.id, next);
      await this.emit("ReviewRequestedChanges", {
        taskId: task.id,
        runId,
        payload: { next, notes: review?.notes ?? "" },
      });
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
    workspaces: ManagedWorkspace[],
    targets: TargetVerificationResult[],
    finishedAt: string,
  ): Promise<void> {
    await this.runStore.completeRun(runId, {
      status: "FAILED",
      exitCode: agentResult.exitCode,
      result: {
        workspace: { path: workspace.path, branch: workspace.branch },
        workspaces: workspaces.map((item) => ({
          targetId: item.targetId,
          path: item.path,
          branch: item.branch,
        })),
        targets,
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
        failingTargets: targets
          .filter((target) => !target.passed)
          .map((target) => ({
            targetId: target.targetId,
            repositoryId: target.repositoryId,
            error: target.error,
            checks: target.checks.map((check) => ({
              command: check.command,
              status: check.status,
              exitCode: check.exitCode,
              output: truncate(check.output, 20_000),
            })),
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

  private startHeartbeat(runId: string, onCancel?: () => void): NodeJS.Timeout {
    return setInterval(() => {
      this.runStore.touchLease(runId, isoIn(this.leaseMs)).catch(() => {
        // A failed heartbeat is surfaced later by lease recovery.
      });
      if (onCancel) {
        this.runStore
          .findRun(runId)
          .then((run) => {
            if (run.cancelRequestedAt) {
              onCancel();
            }
          })
          .catch(() => {
            // Lease recovery handles vanished runs.
          });
      }
    }, this.heartbeatMs);
  }

  /**
   * TASK-1010: failed / timed-out / cancelled runs must not leave workspaces
   * behind. Best-effort: cleanup problems are reported as an event and never
   * mask the run status that was already persisted.
   */
  private async cleanupRunWorkspaces(
    runId: string,
    taskId: string,
    workspaces: ManagedWorkspace[],
    targets: { target: TaskTarget; repository: Repository }[],
  ): Promise<void> {
    if (workspaces.length === 0) {
      return;
    }
    const repositoryByTarget = new Map(
      targets.map(({ target, repository }) => [target.id, repository]),
    );
    const removed: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const workspace of workspaces) {
      const repository =
        repositoryByTarget.get(workspace.targetId ?? "") ?? targets[0]?.repository;
      if (!repository) {
        skipped.push({ path: workspace.path, reason: "no repository for target" });
        continue;
      }
      try {
        await this.workspaceManager.removeWorkspace({
          path: workspace.path,
          repositoryLocalPath: repository.localPath,
        });
        removed.push(workspace.path);
      } catch (error) {
        skipped.push({
          path: workspace.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.emit("workspaces.cleaned", {
      taskId,
      runId,
      payload: { removed, skipped },
    });
  }

  /**
   * TASK-901: timeout / cancellation share one path — stop the execution,
   * then let the finally-block cleanup obligation run.
   */
  private async runAgent(
    runId: string,
    context: Parameters<AgentEngine["execute"]>[0],
    signal?: AbortSignal,
  ): Promise<AgentResult | "TIMED_OUT" | "CANCELLED"> {
    const guards: Promise<never>[] = [];
    let timeout: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    if (this.executionTimeoutMs > 0) {
      guards.push(
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new ExecutionTimeoutError(runId)),
            this.executionTimeoutMs,
          );
        }),
      );
    }
    if (signal) {
      guards.push(
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new ExecutionCancelledError(runId));
            return;
          }
          onAbort = () => reject(new ExecutionCancelledError(runId));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }

    try {
      if (guards.length === 0) {
        return await this.agentEngine.execute(context);
      }
      return await Promise.race([this.agentEngine.execute(context), ...guards]);
    } catch (error) {
      if (error instanceof ExecutionTimeoutError) {
        await this.agentEngine.cancel(runId).catch(() => undefined);
        return "TIMED_OUT";
      }
      if (error instanceof ExecutionCancelledError) {
        await this.agentEngine.cancel(runId).catch(() => undefined);
        return "CANCELLED";
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
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

/**
 * TASK-1009 Run aggregation: a Run succeeds only when every target passed.
 * The per-target detail lives in `run.result.targets[]`; this aggregate keeps
 * the Phase 5 `VerificationResult` shape for backward compatibility.
 */
function aggregateVerification(
  results: TargetVerificationResult[],
): VerificationResult {
  const checks = results.flatMap((result) => result.checks);
  const startedAt = results[0]?.startedAt ?? new Date().toISOString();
  const finishedAt = results[results.length - 1]?.finishedAt ?? startedAt;
  return {
    passed: results.length > 0 && results.every((result) => result.passed),
    checks,
    startedAt,
    finishedAt,
    durationSeconds: results.reduce(
      (total, result) => total + result.durationSeconds,
      0,
    ),
  };
}
