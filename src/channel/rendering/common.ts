import type { Run } from "../../domain/run.js";
import type { MessageBlock } from "../message.js";

export const MAX_OUTPUT_CHARS = 400;

export interface RenderedCheck {
  command: string;
  status: string;
  exitCode?: number | null;
  output?: string;
}

/** Business facts extracted from a Run, shared by run/review renderers. */
export interface RenderedTarget {
  targetId: string;
  repositoryId: string;
  repository?: string;
  role?: string;
  passed: boolean;
  workdir?: string;
  error?: string;
  checks: RenderedCheck[];
}

export function truncateOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function sectionBlock(title: string, text: string): MessageBlock {
  return { type: "section", title, text };
}

export function markdownBlock(text: string): MessageBlock {
  return { type: "markdown", text };
}

export function statusMark(passed: boolean): string {
  return passed ? "✓" : "✗";
}

export function testCounts(targets: RenderedTarget[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const target of targets) {
    for (const check of target.checks) {
      if (check.status === "passed") {
        passed += 1;
      } else {
        failed += 1;
      }
    }
  }
  return { passed, failed };
}

/** Reads per-target facts from run.result.targets[] or error.failingTargets[]. */
export function collectRunTargets(
  run: Pick<Run, "result" | "error">,
): RenderedTarget[] {
  const result = asRecord(run.result);
  const error = asRecord(run.error);
  const targets = new Map<string, RenderedTarget>();

  const resultTargets = Array.isArray(result?.targets) ? result.targets : [];
  for (const entry of resultTargets) {
    const target = asRecord(entry);
    if (!target || typeof target.targetId !== "string") {
      continue;
    }
    targets.set(target.targetId, {
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
    if (!target || typeof target.targetId !== "string" || targets.has(target.targetId)) {
      continue;
    }
    targets.set(target.targetId, {
      targetId: target.targetId,
      repositoryId: String(target.repositoryId ?? ""),
      passed: false,
      error: typeof target.error === "string" ? target.error : undefined,
      checks: normalizeChecks(target.checks),
    });
  }
  return [...targets.values()];
}

function normalizeChecks(raw: unknown): RenderedCheck[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const checks: RenderedCheck[] = [];
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
