import {
  applySpecificationUpdate,
  buildSpecification,
} from "../domain/specification.js";
import type {
  CreateSpecificationInput,
  Specification,
  SpecificationStatus,
  UpdateSpecificationInput,
} from "../domain/specification.js";
import {
  DuplicateSpecificationError,
  SpecificationNotFoundError,
} from "../errors.js";
import type {
  SpecificationListFilter,
  SpecificationStore,
} from "./specificationStore.js";

/** Non-persistent specification store, used by tests and memory-mode demos. */
export class InMemorySpecificationStore implements SpecificationStore {
  private readonly specifications = new Map<string, Specification>();

  async createSpecification(input: CreateSpecificationInput): Promise<Specification> {
    const specification = buildSpecification(input);
    if (this.specifications.has(specification.id)) {
      throw new DuplicateSpecificationError(specification.id);
    }
    this.specifications.set(specification.id, specification);
    return specification;
  }

  async listSpecifications(
    filter: SpecificationListFilter = {},
  ): Promise<Specification[]> {
    return [...this.specifications.values()]
      .filter(
        (specification) =>
          (filter.problemId === undefined ||
            specification.problemId === filter.problemId) &&
          (filter.status === undefined || specification.status === filter.status),
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }

  async findSpecification(id: string): Promise<Specification> {
    const specification = this.specifications.get(id);
    if (!specification) {
      throw new SpecificationNotFoundError(id);
    }
    return specification;
  }

  async findSpecificationByProblem(
    problemId: string,
  ): Promise<Specification | undefined> {
    const matches = await this.listSpecifications({ problemId });
    return matches[matches.length - 1];
  }

  async updateSpecification(
    id: string,
    patch: UpdateSpecificationInput,
  ): Promise<Specification> {
    const current = await this.findSpecification(id);
    const updated = applySpecificationUpdate(current, patch);
    this.specifications.set(id, updated);
    return updated;
  }

  async updateSpecificationStatus(
    id: string,
    status: SpecificationStatus,
  ): Promise<Specification> {
    const current = await this.findSpecification(id);
    const updated: Specification = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.specifications.set(id, updated);
    return updated;
  }

  async updateSpecificationStatusIf(
    id: string,
    expected: SpecificationStatus,
    status: SpecificationStatus,
  ): Promise<Specification | undefined> {
    const current = await this.findSpecification(id);
    if (current.status !== expected) {
      return undefined;
    }
    return this.updateSpecificationStatus(id, status);
  }
}
