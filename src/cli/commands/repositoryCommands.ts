import type { CreateRepositoryInput, Repository } from "../../domain/repository.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";

export interface RepositoryCreateOptions {
  id?: string;
  name: string;
  url: string;
  defaultBranch?: string;
  localPath?: string;
  verify?: string[];
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
