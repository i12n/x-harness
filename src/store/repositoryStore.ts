import type {
  CreateRepositoryInput,
  Repository,
  UpdateRepositoryInput,
} from "../domain/repository.js";

/** Persistence contract for repositories. */
export interface RepositoryStore {
  createRepository(input: CreateRepositoryInput): Promise<Repository>;
  /** TASK-1218: patch in place; unknown fields are left untouched. */
  updateRepository(id: string, patch: UpdateRepositoryInput): Promise<Repository>;
  listRepositories(): Promise<Repository[]>;
  findRepository(id: string): Promise<Repository>;
}
