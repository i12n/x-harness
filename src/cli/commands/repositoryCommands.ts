import type { CreateRepositoryInput, Repository } from "../../domain/repository.js";
import type { ExecutionProfile } from "../../domain/executionProfile.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";

export interface RepositoryCreateOptions {
  id?: string;
  name: string;
  url: string;
  defaultBranch?: string;
  localPath?: string;
  verify?: string[];
  executionProfile?: ExecutionProfile;
}

export async function createRepositoryCommand(
  store: RepositoryStore,
  options: RepositoryCreateOptions,
): Promise<Repository> {
  const input: CreateRepositoryInput = {
    id: options.id,
    name: options.name,
    url: options.url,
    defaultBranch: options.defaultBranch,
    localPath: options.localPath,
    verificationCommands: options.verify ?? [],
    executionProfile: options.executionProfile,
  };
  return store.createRepository(input);
}

export async function listRepositoriesCommand(
  store: RepositoryStore,
): Promise<Repository[]> {
  return store.listRepositories();
}

export async function showRepositoryCommand(
  store: RepositoryStore,
  id: string,
): Promise<Repository> {
  return store.findRepository(id);
}

export interface RepositoryUpdateOptions {
  /**
   * Replaces the verification commands. Omitted means "leave unchanged" —
   * TASK-1218 keeps partial updates partial so a flag typo cannot wipe a
   * profile that was already working.
   */
  verificationCommands?: string[];
  executionProfile?: ExecutionProfile;
}

/** TASK-1218: fix a registered repository without re-registering it. */
export async function updateRepositoryCommand(
  store: RepositoryStore,
  id: string,
  options: RepositoryUpdateOptions,
): Promise<Repository> {
  return store.updateRepository(id, {
    ...(options.verificationCommands !== undefined
      ? { verificationCommands: options.verificationCommands }
      : {}),
    ...(options.executionProfile !== undefined
      ? { executionProfile: options.executionProfile }
      : {}),
  });
}
