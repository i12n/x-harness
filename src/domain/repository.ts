import { homedir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.js";
import { makeId, slugify } from "../util/id.js";

/** A registered source repository the harness can drive tasks against. */
export interface Repository {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
  localPath: string;
  verificationCommands: string[];
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
}

const SCP_LIKE_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+$/;
const URI_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/;

export function assertValidRepositoryUrl(url: string): void {
  if (!SCP_LIKE_URL.test(url) && !URI_URL.test(url)) {
    throw new ValidationError(`invalid repository url: ${url}`);
  }
}

function dedupeNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const command = value.trim();
    if (command && !seen.has(command)) {
      seen.add(command);
      result.push(command);
    }
  }
  return result;
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
    createdAt: now,
    updatedAt: now,
  };
}
