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
