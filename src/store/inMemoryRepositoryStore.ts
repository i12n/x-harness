import { applyRepositoryUpdate, buildRepository } from "../domain/repository.js";
import type {
  CreateRepositoryInput,
  Repository,
  UpdateRepositoryInput,
} from "../domain/repository.js";
import { DuplicateRepositoryError, RepositoryNotFoundError } from "../errors.js";
import type { RepositoryStore } from "./repositoryStore.js";

/** Non-persistent store, used by tests and `AI_STORAGE=memory` demos. */
export class InMemoryRepositoryStore implements RepositoryStore {
  private readonly repositories = new Map<string, Repository>();

  async createRepository(input: CreateRepositoryInput): Promise<Repository> {
    const repository = buildRepository(input);
    if (this.repositories.has(repository.id)) {
      throw new DuplicateRepositoryError(repository.id);
    }
    this.repositories.set(repository.id, repository);
    return repository;
  }

  async listRepositories(): Promise<Repository[]> {
    return [...this.repositories.values()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.id.localeCompare(b.id);
    });
  }

  async updateRepository(id: string, patch: UpdateRepositoryInput): Promise<Repository> {
    const current = await this.findRepository(id);
    const updated = applyRepositoryUpdate(current, patch);
    this.repositories.set(id, updated);
    return updated;
  }

  async findRepository(id: string): Promise<Repository> {
    const repository = this.repositories.get(id);
    if (!repository) {
      throw new RepositoryNotFoundError(id);
    }
    return repository;
  }
}
