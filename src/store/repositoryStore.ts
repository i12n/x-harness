import type { CreateRepositoryInput, Repository } from "../domain/repository.js";

/** Persistence contract for repositories. */
export interface RepositoryStore {
  createRepository(input: CreateRepositoryInput): Promise<Repository>;
  listRepositories(): Promise<Repository[]>;
  findRepository(id: string): Promise<Repository>;
}
