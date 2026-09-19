import type { Problem } from "../../domain/problem.js";
import {
  assessSpecification,
  isSpecificationEditable,
} from "../../domain/specification.js";
import type {
  CreateSpecificationTargetInput,
  Specification,
  UpdateSpecificationInput,
} from "../../domain/specification.js";
import { HarnessError } from "../../errors.js";
import type { EventStore } from "../../store/eventStore.js";
import type { ProblemStore } from "../../store/problemStore.js";
import type {
  SpecificationListFilter,
  SpecificationStore,
} from "../../store/specificationStore.js";

/** Domain rejections of the specification lifecycle (status rules, gaps). */
export class SpecificationError extends HarnessError {
  readonly code: string;
  readonly issues: string[];

  constructor(code: string, message: string, issues: string[] = []) {
    super(message);
    this.name = "SpecificationError";
    this.code = code;
    this.issues = issues;
  }
}

export interface CreateSpecificationFromProblemInput {
  problemId: string;
  title?: string;
  summary?: string;
  requirements?: string[];
  acceptance?: string[];
  constraints?: Record<string, unknown>;
  targets?: CreateSpecificationTargetInput[];
}

export interface SpecificationServiceDeps {
  specifications: SpecificationStore;
  problems: ProblemStore;
  events?: EventStore;
}

/**
 * TASK-1201: Specification application service. It owns the lifecycle rules
 * (derive from a CONFIRMED Problem, DRAFT is the only editable status, READY
 * requires acceptance criteria and targets) and delegates all persistence to
 * the specification store. Planning (Specification → Task) is TASK-1202.
 */
export class SpecificationService {
  constructor(private readonly deps: SpecificationServiceDeps) {}

  /**
   * Create a DRAFT specification from a confirmed Problem. Fields the caller
   * does not supply are derived from `problem.confirmedSpec`, so the confirmed
   * understanding is not retyped by the caller.
   */
  async createFromProblem(
    input: CreateSpecificationFromProblemInput,
  ): Promise<Specification> {
    const problem = await this.deps.problems.findProblem(input.problemId);
    if (problem.status !== "CONFIRMED") {
      throw new SpecificationError(
        "problem_not_confirmed",
        `problem ${problem.id} must be CONFIRMED to create a specification ` +
          `(status is ${problem.status})`,
      );
    }

    const spec = problem.confirmedSpec;
    const specification = await this.deps.specifications.createSpecification({
      problemId: problem.id,
      title: input.title?.trim() || problem.title,
      summary: input.summary?.trim() || spec?.expected?.trim() || problem.statement,
      requirements: input.requirements ?? (spec?.problem ? [spec.problem] : []),
      acceptance: input.acceptance ?? [],
      constraints: input.constraints ?? deriveConstraints(problem),
      targets: input.targets ?? defaultTargets(problem),
      status: "DRAFT",
    });
    await this.emit("specification.created", specification, {
      status: specification.status,
      problemId: specification.problemId,
      targets: specification.targets,
    });
    return specification;
  }

  /** Edit a DRAFT specification; READY/PLANNED/SUPERSEDED are frozen. */
  async update(
    specificationId: string,
    patch: UpdateSpecificationInput,
  ): Promise<Specification> {
    const specification = await this.deps.specifications.findSpecification(
      specificationId,
    );
    if (!isSpecificationEditable(specification.status)) {
      throw new SpecificationError(
        "specification_not_editable",
        `specification ${specificationId} is ${specification.status} and cannot be edited`,
      );
    }
    return this.deps.specifications.updateSpecification(specificationId, patch);
  }

  /**
   * DRAFT → READY. READY means "planning may consume this": acceptance
   * criteria exist, at least one target exists, the title is set.
   */
  async markReady(specificationId: string): Promise<Specification> {
    const specification = await this.deps.specifications.findSpecification(
      specificationId,
    );
    if (specification.status !== "DRAFT") {
      throw new SpecificationError(
        "specification_not_draft",
        `specification ${specificationId} must be DRAFT to become READY ` +
          `(status is ${specification.status})`,
      );
    }
    const assessment = assessSpecification(specification);
    if (!assessment.ok) {
      throw new SpecificationError(
        "specification_incomplete",
        `specification ${specificationId} is not ready: ${assessment.issues.join("; ")}`,
        assessment.issues,
      );
    }
    const ready = await this.deps.specifications.updateSpecificationStatus(
      specificationId,
      "READY",
    );
    await this.emit("specification.ready", ready, { status: ready.status });
    return ready;
  }

  /** Replace this specification with a newer one (idempotent). */
  async supersede(specificationId: string): Promise<Specification> {
    const specification = await this.deps.specifications.findSpecification(
      specificationId,
    );
    if (specification.status === "SUPERSEDED") {
      return specification;
    }
    const superseded = await this.deps.specifications.updateSpecificationStatus(
      specificationId,
      "SUPERSEDED",
    );
    await this.emit("specification.superseded", superseded, {
      previousStatus: specification.status,
    });
    return superseded;
  }

  async get(specificationId: string): Promise<Specification> {
    return this.deps.specifications.findSpecification(specificationId);
  }

  async list(filter: SpecificationListFilter = {}): Promise<Specification[]> {
    return this.deps.specifications.listSpecifications(filter);
  }

  async findForProblem(problemId: string): Promise<Specification | undefined> {
    return this.deps.specifications.findSpecificationByProblem(problemId);
  }

  private async emit(
    type: string,
    specification: Specification,
    payload: unknown,
  ): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    try {
      await this.deps.events.record({
        type,
        problemId: specification.problemId,
        payload: { specificationId: specification.id, ...(payload as object) },
      });
    } catch {
      // History must never break the specification lifecycle.
    }
  }
}

/** A single-repository problem yields a single primary target. */
function defaultTargets(problem: Problem): CreateSpecificationTargetInput[] {
  return problem.repositoryId ? [{ repositoryId: problem.repositoryId }] : [];
}

/** Carry the confirmed scope/investigation notes into `constraints`. */
function deriveConstraints(problem: Problem): Record<string, unknown> {
  const spec = problem.confirmedSpec;
  const constraints: Record<string, unknown> = {};
  if (spec?.scope) {
    constraints.scope = spec.scope;
  }
  if (spec?.investigation) {
    constraints.investigation = spec.investigation;
  }
  return constraints;
}
