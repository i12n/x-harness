import type {
  CreateSpecificationInput,
  Specification,
  SpecificationStatus,
  UpdateSpecificationInput,
} from "../domain/specification.js";

export interface SpecificationListFilter {
  problemId?: string;
  status?: SpecificationStatus;
}

/**
 * Persistence contract for Specification (Phase 12 / TASK-1201).
 * Lifecycle rules (derived from a CONFIRMED problem, DRAFT-only edits) live in
 * the specification application service, not here.
 */
export interface SpecificationStore {
  createSpecification(input: CreateSpecificationInput): Promise<Specification>;
  listSpecifications(filter?: SpecificationListFilter): Promise<Specification[]>;
  findSpecification(id: string): Promise<Specification>;
  /** Newest specification of a problem, if any. */
  findSpecificationByProblem(problemId: string): Promise<Specification | undefined>;
  updateSpecification(
    id: string,
    patch: UpdateSpecificationInput,
  ): Promise<Specification>;
  updateSpecificationStatus(
    id: string,
    status: SpecificationStatus,
  ): Promise<Specification>;
}
