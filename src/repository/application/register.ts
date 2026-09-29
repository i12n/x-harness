import { dirname, join, resolve } from "node:path";
import {
  buildExecutionProfile,
  type ExecutionNetworkMode,
  type ExecutionProfile,
} from "../../domain/executionProfile.js";
import { assertValidRepositoryUrl, type Repository } from "../../domain/repository.js";
import { HarnessError } from "../../errors.js";
import type { CloneOutcome, GitService } from "../../git/gitService.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import { slugify } from "../../util/id.js";
import { dedupeNonEmpty } from "../../util/strings.js";

/** Registration failures that are the user's to fix, not the harness's. */
export class RepositoryRegistrationError extends HarnessError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RepositoryRegistrationError";
    this.code = code;
  }
}

export interface RegisterRepositoryInput {
  url: string;
  id?: string;
  name?: string;
  defaultBranch?: string;
  verificationCommands?: string[];
  executionImage?: string;
  networkMode?: ExecutionNetworkMode;
  allowedHosts?: string[];
  secrets?: string[];
  gitPush?: "allow" | "deny";
}

export interface RegisterRepositoryOutcome {
  repository: Repository;
  /** Absent when the repository was already registered (nothing was cloned). */
  clone?: CloneOutcome;
  created: boolean;
  /** Host directory the checkout lives in. */
  localPath: string;
}

/** Transports we are willing to hand to `git clone` from a chat message. */
const ALLOWED_URL_SCHEMES = ["https", "http", "ssh", "git", "file"];
const SCP_LIKE_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+$/;

/**
 * Registering a repository: resolve its identity, clone the base checkout the
 * worktrees are cut from, then persist the record. Two host-side effects, so
 * it is deliberately reachable only from the admin command path.
 */
export class RepositoryRegistrationService {
  private readonly repositories: RepositoryStore;
  private readonly git: GitService;
  private readonly reposDir: string;

  constructor(deps: { repositories: RepositoryStore; git: GitService; reposDir: string }) {
    this.repositories = deps.repositories;
    this.git = deps.git;
    this.reposDir = resolve(deps.reposDir);
  }

  async register(input: RegisterRepositoryInput): Promise<RegisterRepositoryOutcome> {
    const url = assertAllowedRepositoryUrl(input.url);
    const name = input.name?.trim() || deriveRepositoryName(url);
    const id = input.id?.trim() || `repo-${slugify(name)}`;
    const localPath = join(this.reposDir, slugify(name));

    const existing = await this.repositories.listRepositories();
    const byId = existing.find((repository) => repository.id === id);
    if (byId) {
      if (byId.url !== url) {
        throw new RepositoryRegistrationError(
          "repository_id_taken",
          `仓库 id ${id} 已被 ${byId.url} 占用；换一个 id 或名字再注册`,
        );
      }
      return { repository: byId, created: false, localPath: byId.localPath };
    }
    const byPath = existing.find((repository) => resolve(repository.localPath) === localPath);
    if (byPath) {
      throw new RepositoryRegistrationError(
        "repository_path_taken",
        `本地目录 ${localPath} 已经是 ${byPath.id} 的检出；换一个名字再注册`,
      );
    }

    const clone = await this.git.cloneRepository({
      url,
      path: localPath,
      defaultBranch: input.defaultBranch,
    });

    const repository = await this.repositories.createRepository({
      id,
      name,
      url,
      defaultBranch: input.defaultBranch,
      localPath,
      verificationCommands: dedupeNonEmpty(input.verificationCommands ?? []),
      executionProfile: buildRegistrationProfile(input),
    });
    return { repository, clone, created: true, localPath };
  }
}

/**
 * Reject anything we would not want `git clone` to interpret as a transport.
 * The domain only checks "looks like a URL"; this narrows the *schemes* so a
 * chat message can never reach git's more exotic transports (`ext::…`).
 */
export function assertAllowedRepositoryUrl(value: string): string {
  const url = value.trim();
  assertValidRepositoryUrl(url);
  if (SCP_LIKE_URL.test(url)) {
    return url;
  }
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  if (!ALLOWED_URL_SCHEMES.includes(scheme)) {
    throw new RepositoryRegistrationError(
      "unsupported_url_scheme",
      `不支持的仓库地址协议 ${scheme}://（只允许 https/ssh/git/file 或 user@host:path）`,
    );
  }
  return url;
}

/** `git@github.com:i12n/x-music.git` → `x-music`. */
export function deriveRepositoryName(url: string): string {
  const tail = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return tail.replace(/\.git$/i, "").trim() || "repository";
}

/**
 * Host directory new checkouts are cloned into: the explicit setting wins,
 * otherwise the parent of the repositories already registered (so a chat
 * registration lands next to them instead of somewhere surprising).
 */
export function inferReposDir(repositories: Repository[]): string | undefined {
  const counts = new Map<string, number>();
  for (const repository of repositories) {
    const parent = dirname(resolve(repository.localPath));
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let winner: string | undefined;
  let winnerCount = 0;
  for (const [dir, count] of counts) {
    if (count > winnerCount || (count === winnerCount && winner !== undefined && dir < winner)) {
      winner = dir;
      winnerCount = count;
    }
  }
  return winner;
}

function buildRegistrationProfile(input: RegisterRepositoryInput): ExecutionProfile | undefined {
  const allowedHosts = dedupeNonEmpty(input.allowedHosts ?? []);
  const secrets = dedupeNonEmpty(input.secrets ?? []);
  const image = input.executionImage?.trim();
  if (!image && !input.networkMode && allowedHosts.length === 0 && secrets.length === 0 && !input.gitPush) {
    return undefined;
  }
  return buildExecutionProfile({
    name: "default",
    image: image || "harness/execution:base",
    network: {
      mode: input.networkMode ?? (allowedHosts.length > 0 ? "restricted" : "none"),
      allow: allowedHosts,
    },
    secrets,
    policy: input.gitPush ? { gitPush: input.gitPush } : undefined,
  });
}
