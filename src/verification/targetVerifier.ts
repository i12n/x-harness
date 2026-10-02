import type { ExecutionExec } from "../execution/manager.js";
import type { TargetRole } from "../domain/taskTarget.js";
import type { VerificationCheck } from "./runner.js";
import { Verifier } from "./runner.js";

export interface TargetVerificationRequest {
  targetId: string;
  repositoryId: string;
  /** Repository display name (evidence only). */
  repositoryName: string;
  role: TargetRole;
  /** Where to run this target's checks (ExecutionContext.workdirs[targetId]). */
  workdir: string;
  /** Commands come from THIS repository's config, never from the Task. */
  commands: string[];
  /**
   * TASK-1220: checks the Task itself brought (from its work item). They run
   * after the repository commands and are recorded separately, because they
   * prove this change rather than the repository's general health.
   */
  acceptanceChecks?: string[];
  exec?: ExecutionExec;
  timeoutMs?: number;
}

export interface TargetVerificationResult {
  targetId: string;
  repositoryId: string;
  repository: string;
  role: TargetRole;
  workdir: string;
  commands: string[];
  acceptanceChecks: string[];
  checks: VerificationCheck[];
  passed: boolean;
  durationSeconds: number;
  startedAt: string;
  finishedAt: string;
  /** Infrastructure failure while verifying this target (not a check failure). */
  error?: string;
}

/**
 * TASK-1008: verifies each target independently, against its own repository
 * config and its own workdir. It deliberately does NOT aggregate targets into
 * a Run verdict — that belongs to the Worker (TASK-1009).
 */
export class TargetVerifier {
  private readonly verifier: Verifier;

  constructor(verifier: Verifier = new Verifier()) {
    this.verifier = verifier;
  }

  /** Sequential and deterministic: results follow request order. */
  async verifyTargets(
    requests: TargetVerificationRequest[],
  ): Promise<TargetVerificationResult[]> {
    const results: TargetVerificationResult[] = [];
    for (const request of requests) {
      results.push(await this.verifyTarget(request));
    }
    return results;
  }

  async verifyTarget(
    request: TargetVerificationRequest,
  ): Promise<TargetVerificationResult> {
    const startedAt = new Date().toISOString();
    const acceptanceChecks = (request.acceptanceChecks ?? [])
      .map((check) => check.trim())
      .filter(Boolean);
    try {
      const result = await this.verifier.run({
        workspacePath: request.workdir,
        workdir: request.workdir,
        exec: request.exec,
        // Repository commands are the regression floor; the Task's own checks
        // are the proof for this change (TASK-1220).
        commands: [...request.commands, ...acceptanceChecks],
        timeoutMs: request.timeoutMs,
      });
      return {
        targetId: request.targetId,
        repositoryId: request.repositoryId,
        repository: request.repositoryName,
        role: request.role,
        workdir: request.workdir,
        commands: [...request.commands],
        acceptanceChecks,
        checks: result.checks,
        passed: result.passed,
        durationSeconds: result.durationSeconds,
        startedAt,
        finishedAt: result.finishedAt,
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      return {
        targetId: request.targetId,
        repositoryId: request.repositoryId,
        repository: request.repositoryName,
        role: request.role,
        workdir: request.workdir,
        commands: [...request.commands],
        acceptanceChecks,
        checks: [],
        passed: false,
        durationSeconds: Math.max(
          0,
          (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000,
        ),
        startedAt,
        finishedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
