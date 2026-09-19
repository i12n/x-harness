import type { Run } from "../domain/run.js";
import type { Task } from "../domain/task.js";

/** TASK-1011: `task show` target list (repository names resolved by caller). */
export function formatTaskTargets(
  task: Task,
  repositoryNames: Map<string, string> = new Map(),
): string[] {
  const lines = ["Targets:"];
  if (task.targets.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  for (const target of task.targets) {
    const name = repositoryNames.get(target.repositoryId) ?? target.repositoryId;
    lines.push(
      `  #${target.position}  ${target.role.padEnd(10)} repository: ${name} (${target.repositoryId})`,
    );
    lines.push(`      base_ref: ${target.baseRef ?? "(repository default)"}`);
    lines.push(`      branch: -    required: ${target.required}`);
  }
  return lines;
}

interface RunTargetResult {
  targetId: string;
  repositoryId: string;
  repository?: string;
  role?: string;
  passed: boolean;
  workdir?: string;
  error?: string;
  checks?: {
    command: string;
    status: string;
    exitCode?: number | null;
    output?: string;
  }[];
}

/**
 * TASK-1011: `run` / `task show` run details. Prefers the full per-target
 * evidence in run.result.targets[] and falls back to run.error.failingTargets[]
 * when only the failure summary was persisted.
 */
export function formatRunDetails(run: Run): string[] {
  const lines = [`Run: ${run.id}`, `Status: ${run.status}`];
  const result = asRecord(run.result);
  const error = asRecord(run.error);

  const workspaces = Array.isArray(result?.workspaces) ? result.workspaces : [];
  if (workspaces.length > 0) {
    lines.push("Workspaces:");
    for (const entry of workspaces) {
      const workspace = asRecord(entry);
      if (!workspace) {
        continue;
      }
      lines.push(
        `  - ${String(workspace.targetId ?? "primary")}  ${String(
          workspace.path ?? "",
        )} (${String(workspace.branch ?? "")})`,
      );
    }
  }

  const targets = collectTargets(result, error);
  if (targets.length > 0) {
    lines.push("Targets:");
    for (const target of targets) {
      lines.push(
        `  - ${target.targetId} [${target.role ?? "supporting"}] ${
          target.repository ?? target.repositoryId
        } ${target.passed ? "PASS" : "FAIL"}`,
      );
      if (target.workdir) {
        lines.push(`      workdir: ${target.workdir}`);
      }
      if (target.error) {
        lines.push(`      error: ${target.error}`);
      }
      for (const check of target.checks ?? []) {
        lines.push(
          `      check: ${check.command} ${check.status}` +
            (check.exitCode === undefined || check.exitCode === null
              ? ""
              : ` (exit ${check.exitCode})`),
        );
        if (check.status !== "passed" && check.output) {
          lines.push(`      output: ${truncate(check.output, 400)}`);
        }
      }
    }
  }
  return lines;
}

function collectTargets(
  result: Record<string, unknown> | undefined,
  error: Record<string, unknown> | undefined,
): RunTargetResult[] {
  const byId = new Map<string, RunTargetResult>();
  const resultTargets = Array.isArray(result?.targets) ? result.targets : [];
  for (const entry of resultTargets) {
    const target = asRecord(entry);
    if (!target || typeof target.targetId !== "string") {
      continue;
    }
    byId.set(target.targetId, {
      targetId: target.targetId,
      repositoryId: String(target.repositoryId ?? ""),
      repository: typeof target.repository === "string" ? target.repository : undefined,
      role: typeof target.role === "string" ? target.role : undefined,
      passed: target.passed === true,
      workdir: typeof target.workdir === "string" ? target.workdir : undefined,
      error: typeof target.error === "string" ? target.error : undefined,
      checks: normalizeChecks(target.checks),
    });
  }

  const failing = Array.isArray(error?.failingTargets) ? error.failingTargets : [];
  for (const entry of failing) {
    const target = asRecord(entry);
    if (!target || typeof target.targetId !== "string" || byId.has(target.targetId)) {
      continue;
    }
    byId.set(target.targetId, {
      targetId: target.targetId,
      repositoryId: String(target.repositoryId ?? ""),
      passed: false,
      error: typeof target.error === "string" ? target.error : undefined,
      checks: normalizeChecks(target.checks),
    });
  }
  return [...byId.values()];
}

function normalizeChecks(raw: unknown): RunTargetResult["checks"] {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const checks: NonNullable<RunTargetResult["checks"]> = [];
  for (const entry of raw) {
    const check = asRecord(entry);
    if (!check || typeof check.command !== "string") {
      continue;
    }
    checks.push({
      command: check.command,
      status: String(check.status ?? "failed"),
      exitCode:
        typeof check.exitCode === "number" || check.exitCode === null
          ? (check.exitCode as number | null)
          : undefined,
      output: typeof check.output === "string" ? check.output : undefined,
    });
  }
  return checks;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
