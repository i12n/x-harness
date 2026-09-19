import type { Run, RunStatus } from "./run.js";

/**
 * TASK-1207: a factual summary of why a Run failed. Every field comes from
 * evidence the Worker already persisted (`run.error` / `run.result` / status);
 * nothing here is inferred or generated.
 */
export interface FailureEvidence {
  kind: "verification" | "agent" | "timeout" | "cancelled" | "lost" | "unknown";
  command?: string;
  exitCode?: number | null;
  /** Truncated check output. */
  output?: string;
  message?: string;
  targets?: {
    targetId?: string;
    repositoryId?: string;
    error?: string;
  }[];
}

export interface FailureEvidenceOptions {
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 400;

/**
 * Source priority (first hit wins):
 *
 *   run.error.failingTargets[].checks[]  → run.error.verification[]
 *   → run.result.targets[].checks[]      → terminal status (TIMED_OUT/…)
 */
export function extractFailureEvidence(
  run: Pick<Run, "status" | "exitCode" | "result" | "error"> | undefined,
  options: FailureEvidenceOptions = {},
): FailureEvidence | undefined {
  if (!run) {
    return undefined;
  }
  const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const error = asRecord(run.error);
  const result = asRecord(run.result);

  const failingTargets = asArray(error?.failingTargets);
  for (const entry of failingTargets) {
    const target = asRecord(entry);
    const checks = asArray(target?.checks);
    for (const checkEntry of checks) {
      const check = asRecord(checkEntry);
      if (!check || check.status !== "failed") {
        continue;
      }
      return {
        kind: "verification",
        command: asString(check.command),
        exitCode: asExitCode(check.exitCode),
        output: truncate(asString(check.output), maxOutput),
        targets: targetSummary(failingTargets),
      };
    }
  }

  for (const entry of asArray(error?.verification)) {
    const check = asRecord(entry);
    if (!check || check.status !== "failed") {
      continue;
    }
    return {
      kind: "verification",
      command: asString(check.command),
      exitCode: asExitCode(check.exitCode),
      output: truncate(asString(check.output), maxOutput),
      targets: targetSummary(failingTargets),
    };
  }

  for (const entry of asArray(result?.targets)) {
    const target = asRecord(entry);
    for (const checkEntry of asArray(target?.checks)) {
      const check = asRecord(checkEntry);
      if (!check || check.status !== "failed") {
        continue;
      }
      return {
        kind: "verification",
        command: asString(check.command),
        exitCode: asExitCode(check.exitCode),
        output: truncate(asString(check.output), maxOutput),
      };
    }
  }

  const status = run.status as RunStatus;
  if (status === "TIMED_OUT") {
    return { kind: "timeout", message: messageOf(run, error, "run timed out") };
  }
  if (status === "CANCELLED") {
    return { kind: "cancelled", message: messageOf(run, error, "run cancelled") };
  }
  if (status === "LOST") {
    return { kind: "lost", message: messageOf(run, error, "run lost") };
  }
  if (status === "FAILED") {
    const message = messageOf(run, error, "run failed");
    const kind = agentFailure(error, result) ? "agent" : "unknown";
    return {
      kind,
      message,
      exitCode: run.exitCode ?? undefined,
      targets: targetSummary(failingTargets),
    };
  }
  return undefined;
}

function agentFailure(
  error: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): boolean {
  if (error?.verification !== undefined || error?.failingTargets !== undefined) {
    return false;
  }
  return asString(result?.agentStderr) !== undefined;
}

function messageOf(
  run: Pick<Run, "exitCode">,
  error: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const message = asString(error?.message) ?? asString(error?.reason);
  if (message) {
    return message;
  }
  return run.exitCode === undefined || run.exitCode === null
    ? fallback
    : `${fallback} (exit ${run.exitCode})`;
}

function targetSummary(
  failingTargets: unknown[],
): FailureEvidence["targets"] {
  if (failingTargets.length === 0) {
    return undefined;
  }
  const targets: NonNullable<FailureEvidence["targets"]> = [];
  for (const entry of failingTargets) {
    const target = asRecord(entry);
    if (!target) {
      continue;
    }
    targets.push({
      targetId: asString(target.targetId),
      repositoryId: asString(target.repositoryId),
      error: asString(target.error),
    });
  }
  return targets.length > 0 ? targets : undefined;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function asExitCode(value: unknown): number | null | undefined {
  return typeof value === "number" || value === null ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
