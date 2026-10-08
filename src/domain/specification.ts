import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";
import { dedupeNonEmpty } from "../util/strings.js";
import type { TargetRole } from "./taskTarget.js";

export const SPECIFICATION_STATUSES = [
  "DRAFT",
  "READY",
  "PLANNED",
  "SUPERSEDED",
] as const;
export type SpecificationStatus = (typeof SPECIFICATION_STATUSES)[number];

export interface SpecificationTarget {
  repositoryId: string;
  role: TargetRole;
  position: number;
  baseRef?: string;
}

/** One engineering specification derived from a confirmed Problem. */
export interface Specification {
  id: string;
  problemId: string;
  title: string;
  summary: string;
  requirements: string[];
  acceptance: string[];
  constraints: Record<string, unknown>;
  targets: SpecificationTarget[];
  status: SpecificationStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * TASK-1224: a work item is the unit that becomes one Task. Unlike a
 * requirement (which states what must be true), a work item must be an
 * independently verifiable change: it carries its own acceptance subset and at
 * least one executable check. Stored in `constraints.workItems` so no migration
 * is needed.
 */
export interface SpecificationWorkItem {
  title: string;
  description: string;
  /** Indices into {@link Specification.acceptance}. */
  acceptance: number[];
  /** Executable checks that prove this item (consumed by TASK-1220). */
  checks: string[];
}

const WORK_ITEMS_KEY = "workItems";

/**
 * A work item's `checks` are shell commands the harness runs verbatim
 * (`sh -lc` in the repository worktree) — never a description of a manual step.
 *
 * The model is asked for commands and the catalog says to write the rest of the
 * spec in the problem's language, so it occasionally writes a sentence in that
 * language instead of a command. That sentence then dies with a shell syntax
 * error and burns the Task's attempts (live evidence: task-spec-e13a0f2517-0).
 *
 * Commands are ASCII, so the tells are cheap and high-confidence: CJK /
 * full-width text, a multi-line blob, or a sentence terminator at the end.
 */
export function isExecutableCheck(check: string): boolean {
  const value = check.trim();
  if (!value || value.includes("\n")) {
    return false;
  }
  if (/[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/.test(value)) {
    return false;
  }
  return !/[.!?]$/.test(value);
}

/** Reads work items defensively; malformed entries are dropped, never thrown. */
export function readWorkItems(
  specification: Pick<Specification, "constraints">,
): SpecificationWorkItem[] {
  const raw = specification.constraints?.[WORK_ITEMS_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: SpecificationWorkItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) {
      continue;
    }
    const acceptance = Array.isArray(record.acceptance)
      ? record.acceptance.filter(
          (index): index is number => Number.isInteger(index) && (index as number) >= 0,
        )
      : [];
    const checks = Array.isArray(record.checks)
      ? record.checks
          .filter((check): check is string => typeof check === "string")
          .map((check) => check.trim())
          .filter(Boolean)
      : [];
    items.push({
      title,
      description: typeof record.description === "string" ? record.description.trim() : "",
      acceptance,
      checks,
    });
  }
  return items;
}

export function withWorkItems(
  constraints: Record<string, unknown>,
  items: SpecificationWorkItem[],
): Record<string, unknown> {
  return { ...constraints, [WORK_ITEMS_KEY]: items };
}

export interface CreateSpecificationTargetInput {
  repositoryId: string;
  role?: TargetRole;
  position?: number;
  baseRef?: string;
}

export interface CreateSpecificationInput {
  id?: string;
  problemId: string;
  title: string;
  summary?: string;
  requirements?: string[];
  acceptance?: string[];
  constraints?: Record<string, unknown>;
  targets?: CreateSpecificationTargetInput[];
  status?: SpecificationStatus;
}

/** Editable fields of a DRAFT specification. */
export interface UpdateSpecificationInput {
  title?: string;
  summary?: string;
  requirements?: string[];
  acceptance?: string[];
  constraints?: Record<string, unknown>;
  targets?: CreateSpecificationTargetInput[];
}

export function isSpecificationStatus(value: unknown): value is SpecificationStatus {
  return (
    typeof value === "string" &&
    (SPECIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Only DRAFT specifications are editable; READY/PLANNED are frozen inputs. */
export function isSpecificationEditable(status: SpecificationStatus): boolean {
  return status === "DRAFT";
}

export function buildSpecification(input: CreateSpecificationInput): Specification {
  const problemId = input.problemId?.trim();
  if (!problemId) {
    throw new ValidationError("specification problem id is required");
  }
  const title = input.title?.trim();
  if (!title) {
    throw new ValidationError("specification title is required");
  }
  const status = input.status ?? "DRAFT";
  if (!isSpecificationStatus(status)) {
    throw new ValidationError(`invalid specification status: ${String(status)}`);
  }
  const now = new Date().toISOString();
  return {
    id: input.id?.trim() || makeId("spec"),
    problemId,
    title,
    summary: input.summary?.trim() ?? "",
    requirements: dedupeNonEmpty(input.requirements ?? []),
    acceptance: dedupeNonEmpty(input.acceptance ?? []),
    constraints: input.constraints ?? {},
    targets: normalizeTargets(input.targets ?? []),
    status,
    createdAt: now,
    updatedAt: now,
  };
}

export interface SpecificationAssessment {
  ok: boolean;
  issues: string[];
}

/** Pure edit helper; the caller owns the "only DRAFT is editable" rule. */
export function applySpecificationUpdate(
  specification: Specification,
  patch: UpdateSpecificationInput,
): Specification {
  const title = patch.title === undefined ? specification.title : patch.title.trim();
  if (!title) {
    throw new ValidationError("specification title is required");
  }
  return {
    ...specification,
    title,
    summary:
      patch.summary === undefined ? specification.summary : patch.summary.trim(),
    requirements:
      patch.requirements === undefined
        ? specification.requirements
        : dedupeNonEmpty(patch.requirements),
    acceptance:
      patch.acceptance === undefined
        ? specification.acceptance
        : dedupeNonEmpty(patch.acceptance),
    constraints: patch.constraints ?? specification.constraints,
    targets:
      patch.targets === undefined
        ? specification.targets
        : normalizeTargets(patch.targets),
    updatedAt: new Date().toISOString(),
  };
}

/** READY requires acceptance criteria and at least one target. */
export function assessSpecification(
  specification: Pick<Specification, "acceptance" | "targets" | "title">,
): SpecificationAssessment {
  const issues: string[] = [];
  if (!specification.title.trim()) {
    issues.push("specification has no title");
  }
  if (specification.acceptance.length === 0) {
    issues.push("specification has no acceptance criteria");
  }
  if (specification.targets.length === 0) {
    issues.push("specification has no targets");
  }
  return { ok: issues.length === 0, issues };
}

function normalizeTargets(
  targets: CreateSpecificationTargetInput[],
): SpecificationTarget[] {
  const seen = new Set<string>();
  const normalized: SpecificationTarget[] = [];
  targets.forEach((target, index) => {
    const repositoryId = target.repositoryId?.trim();
    if (!repositoryId) {
      throw new ValidationError("specification target requires a repository id");
    }
    if (seen.has(repositoryId)) {
      throw new ValidationError(
        `specification targets must not repeat a repository: ${repositoryId}`,
      );
    }
    seen.add(repositoryId);
    normalized.push({
      repositoryId,
      role: target.role ?? (index === 0 ? "primary" : "supporting"),
      position: target.position ?? index,
      baseRef: target.baseRef?.trim() || undefined,
    });
  });
  const primaries = normalized.filter((target) => target.role === "primary");
  if (normalized.length > 0 && primaries.length !== 1) {
    throw new ValidationError(
      `specification must have exactly one primary target (found ${primaries.length})`,
    );
  }
  return normalized.sort((a, b) => a.position - b.position);
}
