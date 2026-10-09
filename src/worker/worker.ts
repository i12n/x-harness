import { looksEnvironmental } from "../agent/types.js";
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
import { parseAgentUsage, type AgentUsage } from "../agent/usage.js";
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
  /**
   * TASK-1245: resolves the freshest base ref for a Run's worktrees (fetch +
   * `origin/<branch>`). Absent keeps the pre-1245 behaviour (local branch).
   */
  baseRefs?: BaseRefResolver;
  /** TASK-1247: in-session repair turns after a failed verification (default 2). */
  repairRounds?: number;
}

/** Narrow port so the worker never depends on git plumbing details. */
export interface BaseRefResolver {
  prepareBaseRef(
    repository: Repository,
    baseRef?: string,
  ): Promise<{ ref: string; sha?: string; fetched: boolean; note?: string }>;
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
  private readonly baseRefs: BaseRefResolver | undefined;
  /** TASK-1247: how many in-session repair turns a failed verification may use. */
  private readonly repairRounds: number;
  /** Per-run usage totals (a repair turn adds to, not replaces, the total). */
  private readonly usageTotals = new Map<string, AgentUsage>();

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
    this.baseRefs = options.baseRefs;
    this.repairRounds =
      options.repairRounds ?? Number(process.env.AI_REPAIR_ROUNDS ?? 2);
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

      // TASK-1245: never start a Run from a stale base. Each target's base is
      // resolved (fetch + origin/<branch>) right before the worktree is cut.
      const baseByTarget = new Map<string, string>();
      if (this.baseRefs) {
        for (const { target, repository } of orderedTargets) {
          try {
            const base = await this.baseRefs.prepareBaseRef(repository, target.baseRef);
            baseByTarget.set(target.id, base.ref);
            await this.emit("WorkspaceBaseResolved", {
              taskId: task.id,
              runId,
              payload: {
                targetId: target.id,
                repositoryId: repository.id,
                ref: base.ref,
                ...(base.sha ? { sha: base.sha } : {}),
                fetched: base.fetched,
                ...(base.note ? { note: base.note } : {}),
              },
            });
          } catch (error) {
            // A base that cannot be resolved is not fatal: fall back to what the
            // Task asked for and let git report the real problem.
            await this.emit("WorkspaceBaseUnresolved", {
              taskId: task.id,
              runId,
              payload: { repositoryId: repository.id, reason: String(error) },
            });
          }
        }
      }

      const workspaces = await this.workspaceManager.createRunWorkspaces({
        taskId: task.id,
        runId,
        targets: orderedTargets.map(({ target, repository }) => ({
          targetId: target.id,
          repositoryLocalPath: repository.localPath,
          position: target.position,
          baseRef: baseByTarget.get(target.id) ?? target.baseRef,
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
        await this.recoverTask(task, claimed, undefined, `agent ${agentOutcome}`);
        await this.cleanupRunWorkspaces(runId, task.id, runWorkspaces, runTargets);
        throw new WorkerExecutionError(
          `run ${runId} ${agentOutcome.toLowerCase()}`,
        );
      }
      let agentResult = agentOutcome;
      await this.emit("AgentFinished", {
        taskId: task.id,
        runId,
        payload: { exitCode: agentResult.exitCode, signal: agentResult.signal },
      });

      await this.runStore.updateRunStatus(runId, "VERIFYING");
      await this.taskStore.updateTaskStatus(task.id, "VERIFYING");
      await this.emit("VerificationStarted", { taskId: task.id, runId });
      const verifyTargets = async (): Promise<TargetVerificationResult[]> =>
        this.targetVerifier.verifyTargets(
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
      let targetResults = await verifyTargets();
      let verification = aggregateVerification(targetResults);

      // TASK-1247: a failed verification is not the end while the agent can
      // still fix it *in the same session* — same conversation, same workspace,
      // same context (the follow-up turn reuses the provider's prompt cache).
      // Environmental failures (missing binary, permissions) are not repair
      // material: retrying them only burns attempts.
      const repairs: RepairRecord[] = [];
      for (let round = 1; round <= this.repairRounds && !verification.passed; round += 1) {
        const brief = repairBrief(targetResults);
        if (!brief) {
          break;
        }
        if (looksEnvironmental(brief.text)) {
          await this.emit("RepairSkipped", {
            taskId: task.id,
            runId,
            payload: { round, reason: "environmental", detail: truncate(brief.text, 400) },
          });
          break;
        }
        if (!this.agentEngine.continue) {
          break;
        }
        await this.emit("RepairStarted", {
          taskId: task.id,
          runId,
          payload: { round, commands: brief.commands },
        });
        const repaired = await this.agentEngine.continue(context, brief.prompt, {
          ...(agentResult.sessionId ? { sessionId: agentResult.sessionId } : {}),
        });
        await this.collectUsage(task.id, runId, repaired.stdout);
        agentResult = repaired;
        targetResults = await verifyTargets();
        verification = aggregateVerification(targetResults);
        repairs.push({
          round,
          commands: brief.commands,
          exitCode: repaired.exitCode,
          passed: verification.passed,
        });
        await this.emit("RepairFinished", {
          taskId: task.id,
          runId,
          payload: { round, passed: verification.passed, exitCode: repaired.exitCode },
        });
      }
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
      const usage = await this.collectUsage(task.id, runId, agentResult.stdout);
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
            ...(repairs.length > 0 ? { repairs } : {}),
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
          repairs,
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
        await this.recoverTask(task, claimed, undefined, message);
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
      // TASK-1247: the usage total belongs to this Run only.
      this.usageTotals.delete(runId);
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
    repairs: RepairRecord[] = [],
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
        ...(repairs.length > 0 ? { repairs } : {}),
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
    await this.recoverTask(task, run, targets);
  }

  /**
   * FAILED -> READY while attempts remain, otherwise -> BLOCKED.
   *
   * TASK-1246: the failure itself is written onto the Task, so a *fresh* attempt
   * (new Run, new worktree) still knows which command failed and why — the
   * context builder renders the newest review entry into the prompt.
   */
  private async recoverTask(
    task: Task,
    run: Run,
    targets?: TargetVerificationResult[],
    fallback?: string,
  ): Promise<void> {
    const attempt = run.attempt;
    const next: Task["status"] = attempt >= task.maxAttempts ? "BLOCKED" : "READY";
    await this.taskStore.updateTaskStatus(task.id, next);
    const brief = targets ? repairBrief(targets) : undefined;
    const detail = brief?.text ?? fallback?.trim();
    if (detail) {
      try {
        await this.taskStore.appendTaskReview(task.id, {
          at: new Date().toISOString(),
          runId: run.id,
          text: `VERIFICATION FAILED (attempt ${attempt}/${task.maxAttempts})\n${truncate(detail, 2_000)}`,
        });
      } catch {
        // The failure record must never mask the run status already persisted.
      }
    }
  }

  /**
   * TASK-1215: usage is reported per turn; a repair turn adds to the Run's total
   * instead of replacing it.
   */
  private async collectUsage(
    taskId: string,
    runId: string,
    stdout: string | undefined,
  ): Promise<AgentUsage | undefined> {
    const usage = parseAgentUsage(stdout);
    if (!usage) {
      return undefined;
    }
    this.usageTotals.set(
      runId,
      addUsage(this.usageTotals.get(runId), usage),
    );
    const total = this.usageTotals.get(runId)!;
    await this.emit("RunUsage", { taskId, runId, payload: total });
    return total;
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

/** TASK-1247: one in-session repair turn, recorded on the Run result. */
export interface RepairRecord {
  round: number;
  /** The failing commands the agent was asked to fix. */
  commands: string[];
  exitCode: number | null;
  passed: boolean;
}

/**
 * TASK-1247: what to tell the agent after a failed verification.
 *
 * Short on purpose: the repair turn re-sends the whole accumulated session, so
 * the brief carries the failing commands and a trimmed tail of their output —
 * enough to fix, not a second copy of the build log.
 */
export function repairBrief(targets: TargetVerificationResult[]): {
  commands: string[];
  text: string;
  prompt: string;
} | undefined {
  const failing = targets.flatMap((target) =>
    target.checks
      .filter((check) => check.status !== "passed")
      .map((check) => ({
        command: check.command || "(no command configured)",
        exitCode: check.exitCode,
        output: check.output ?? "",
      })),
  );
  if (failing.length === 0) {
    return undefined;
  }
  const shown = failing.slice(0, 5);
  const text = shown
    .map((check) => `${check.command} → exit ${check.exitCode ?? "?"}\n${check.output}`)
    .join("\n\n");
  const prompt = [
    "验证失败。请修复下面这个失败，然后停下；不要改动与它无关的文件。",
    "",
    ...shown.map(
      (check) =>
        `- \`${check.command}\` → exit ${check.exitCode ?? "?"}\n${truncate(
          check.output.trim(),
          1_200,
        )}`,
    ),
  ].join("\n");
  return { commands: shown.map((check) => check.command), text, prompt };
}

/** TASK-1215: sum the usage of every turn in one Run. */
export function addUsage(
  current: AgentUsage | undefined,
  next: AgentUsage,
): AgentUsage {
  if (!current) {
    return next;
  }
  const inputTokens = current.inputTokens + next.inputTokens;
  const outputTokens = current.outputTokens + next.outputTokens;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
