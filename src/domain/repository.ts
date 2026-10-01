import { homedir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.js";
import { makeId, slugify } from "../util/id.js";
import { dedupeNonEmpty } from "../util/strings.js";
import { defaultExecutionProfile } from "./executionProfile.js";
import type { ExecutionProfile } from "./executionProfile.js";

/** A registered source repository the harness can drive tasks against. */
export interface Repository {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
  localPath: string;
  verificationCommands: string[];
  executionProfile: ExecutionProfile;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepositoryInput {
  id?: string;
  name: string;
  url: string;
  defaultBranch?: string;
  localPath?: string;
  verificationCommands?: string[];
  executionProfile?: ExecutionProfile;
}

export interface UpdateRepositoryInput {
  name?: string;
  url?: string;
  defaultBranch?: string;
  localPath?: string;
  verificationCommands?: string[];
  executionProfile?: ExecutionProfile;
}

const SCP_LIKE_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+$/;
const URI_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/;

export function assertValidRepositoryUrl(url: string): void {
  if (!SCP_LIKE_URL.test(url) && !URI_URL.test(url)) {
    throw new ValidationError(`invalid repository url: ${url}`);
  }
}

/** Build a fully-populated Repository from create input, applying defaults. */
export function buildRepository(input: CreateRepositoryInput): Repository {
  const name = input.name.trim();
  if (!name) {
    throw new ValidationError("repository name is required");
  }
  const url = input.url.trim();
  assertValidRepositoryUrl(url);

  const id = input.id?.trim() || makeId("repo");
  const defaultBranch = input.defaultBranch?.trim() || "main";
  const localPath =
    input.localPath?.trim() || join(homedir(), "ai-repos", slugify(name));
  const verificationCommands = dedupeNonEmpty(input.verificationCommands ?? []);
  const now = new Date().toISOString();

  return {
    id,
    name,
    url,
    defaultBranch,
    localPath,
    verificationCommands,
    executionProfile: input.executionProfile ?? defaultExecutionProfile(),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * TASK-1218: patch an existing Repository. Absent fields keep their current
 * value — an update can only state what changes, so a partial edit can never
 * silently wipe the execution profile or the verification commands. (That
 * mattered in production: `repo-x-music` was registered with every default,
 * and there was no way to fix the profile short of re-registering.)
 */
export function applyRepositoryUpdate(
  repository: Repository,
  patch: UpdateRepositoryInput,
): Repository {
  const name = patch.name?.trim() || repository.name;
  const url = patch.url?.trim() || repository.url;
  assertValidRepositoryUrl(url);
  return {
    ...repository,
    name,
    url,
    defaultBranch: patch.defaultBranch?.trim() || repository.defaultBranch,
    localPath: patch.localPath?.trim() || repository.localPath,
    verificationCommands:
      patch.verificationCommands !== undefined
        ? dedupeNonEmpty(patch.verificationCommands)
        : repository.verificationCommands,
    executionProfile: patch.executionProfile ?? repository.executionProfile,
    updatedAt: new Date().toISOString(),
  };
}
