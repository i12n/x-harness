/**
 * TASK-1220: the acceptance half of a Run's evidence.
 *
 * A Run passing its checks proves the *repository* still works. It does not by
 * itself prove the criteria the work item promised. Those two facts are now
 * separated: the first gates the Run, the second decides whether a human still
 * has to accept the result.
 */

export type AcceptanceStatus = "verified" | "unverifiable";

export interface AcceptanceCriterion {
  criterion: string;
  status: AcceptanceStatus;
  /** Commands that stand behind a `verified` criterion. */
  checks: string[];
}

export interface AcceptanceEvidence {
  criteria: AcceptanceCriterion[];
  /** True when at least one criterion has no executable proof. */
  requiresHumanAcceptance: boolean;
}

/**
 * `checks` are the task's own executable checks (from the work item). When a
 * task brought none, the repository commands may still have proved the Run —
 * but nothing here proved the criteria, and saying so is the whole point.
 */
export function buildAcceptanceEvidence(
  criteria: string[],
  checks: string[],
): AcceptanceEvidence {
  const usable = checks.map((check) => check.trim()).filter(Boolean);
  const evaluated: AcceptanceCriterion[] = criteria
    .map((criterion) => criterion.trim())
    .filter(Boolean)
    .map((criterion) => ({
      criterion,
      status: usable.length > 0 ? ("verified" as const) : ("unverifiable" as const),
      checks: usable.length > 0 ? [...usable] : [],
    }));
  return {
    criteria: evaluated,
    requiresHumanAcceptance: evaluated.some(
      (entry) => entry.status === "unverifiable",
    ),
  };
}

/** Reads the task-level checks a work item contributed (TASK-1224). */
export function acceptanceChecksOf(
  constraints: Record<string, unknown> | undefined,
): string[] {
  const raw = constraints?.checks;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((check): check is string => typeof check === "string")
    .map((check) => check.trim())
    .filter(Boolean);
}
