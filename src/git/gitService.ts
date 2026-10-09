import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Repository } from "../domain/repository.js";
import { HarnessError } from "../errors.js";

const execFileAsync = promisify(execFile);

export class GitError extends HarnessError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

export interface GitServiceOptions {
  /** AI_GIT_BIN */
  gitBinary?: string;
  /** AI_GIT_AUTHOR_NAME / AI_GIT_AUTHOR_EMAIL; passed per commit, never global. */
  authorName?: string;
  authorEmail?: string;
  /** Only branches under this prefix may be pushed (AI_GIT_PUSH_PREFIX). */
  pushPrefix?: string;
  timeoutMs?: number;
}

export interface SyncOutcome {
  repositoryId: string;
  branch: string;
  previousHead: string;
  head: string;
  updated: boolean;
  /** Set when the sync was intentionally not performed. */
  skipped?: "dirty_worktree" | "not_on_default_branch" | "no_remote";
  message: string;
}

/** TASK-1245: which commit a Run's worktree should start from. */
export interface BaseRefOutcome {
  /** Ref handed to `git worktree add` (prefers `origin/<branch>`). */
  ref: string;
  /** Resolved commit, when it could be read. */
  sha?: string;
  /** True when the remote was fetched in this call. */
  fetched: boolean;
  /** Set when the fetch failed (offline, auth) and the local ref is used. */
  note?: string;
  /**
   * TASK-1248: the base checkout itself was fast-forwarded, so a human reading
   * the machine sees the same code a Run would use.
   */
  advanced?: { branch: string; from: string; to: string };
}

export interface PublishOutcome {
  repositoryId: string;
  targetId?: string;
  branch: string;
  remote: string;
  commit?: string;
  filesChanged: number;
  committed: boolean;
  pushed: boolean;
  /** Machine-readable reason when nothing was pushed. */
  skipped?:
    | "push_disabled"
    | "branch_prefix_not_allowed"
    | "protected_branch"
    | "nothing_to_publish"
    | "no_workspace"
    | "error";
  message: string;
}

/**
 * GitHub/repository plumbing, host-side only.
 *
 * The agent never touches this: inside a Run container git cannot even read the
 * worktree's gitdir (the worktree's `.git` points at a host path that is not
 * mounted), and the container deliberately holds no repository credentials.
 * Fetch, commit and push therefore happen here, in the harness process, under
 * explicit policy.
 */
export class GitService {
  private readonly gitBinary: string;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly pushPrefix: string;
  /** TASK-1230: several allowed prefixes (e.g. `ai/,test/`). */
  private readonly pushPrefixes: string[];
  private readonly timeoutMs: number;

  constructor(options: GitServiceOptions = {}) {
    this.gitBinary = options.gitBinary ?? process.env.AI_GIT_BIN ?? "git";
    this.authorName = options.authorName ?? process.env.AI_GIT_AUTHOR_NAME ?? "AI Harness";
    this.authorEmail =
      options.authorEmail ?? process.env.AI_GIT_AUTHOR_EMAIL ?? "ai-harness@localhost";
    this.pushPrefix = options.pushPrefix ?? process.env.AI_GIT_PUSH_PREFIX ?? "ai/";
    this.pushPrefixes = this.pushPrefix
      .split(",")
      .map((prefix) => prefix.trim())
      .filter(Boolean);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * Bring the base checkout up to date before worktrees are created from it.
   * Task branches are cut from a *local* ref, so without this every task would
   * start from whatever the base checkout last fetched.
   */
  /**
   * TASK-1245: the ref a Run's worktree must be cut from.
   *
   * Live evidence: `/srv/repos/x-music` sat at `beecba7` while `origin/main` was
   * at `aebca08`, because nothing in the Run path ever fetched — worktrees were
   * built from a stale local branch, and a test branch even "reverted" the newer
   * commits. So: fetch best-effort, then prefer `origin/<branch>` — which is
   * correct even when the base checkout is dirty, on another branch, or mid-work.
   */
  async prepareBaseRef(
    repository: Repository,
    baseRef?: string,
  ): Promise<BaseRefOutcome> {
    const cwd = repository.localPath;
    const branch = baseRef?.trim() || repository.defaultBranch;
    let fetched = false;
    let note: string | undefined;
    try {
      await this.run(["fetch", "--prune", "origin"], cwd);
      fetched = true;
    } catch (error) {
      // Offline or auth trouble must not block work: fall back to what we have.
      note = `fetch 失败，沿用本地 ${branch}：${describeGitError(error)}`;
    }
    // TASK-1248: keep the base checkout current too — a human reading the
    // machine should see the code a Run would use. Best effort, and only when it
    // is safe: the checkout is clean and still on the default branch.
    const advanced =
      fetched && branch === repository.defaultBranch
        ? await this.advanceBaseCheckout(repository, cwd)
        : undefined;
    for (const ref of [`origin/${branch}`, branch]) {
      const sha = (
        await this.tryRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)
      )?.trim();
      if (sha) {
        return {
          ref,
          sha,
          fetched,
          ...(note ? { note } : {}),
          ...(advanced ? { advanced } : {}),
        };
      }
    }
    // Nothing resolvable yet — let `git worktree add` fail loudly with its own text.
    return {
      ref: branch,
      fetched,
      ...(note ? { note } : {}),
      ...(advanced ? { advanced } : {}),
    };
  }

  /**
   * TASK-1248: fast-forward the base checkout when nothing would be lost.
   * A dirty checkout or a checkout parked on another branch is left alone — that
   * state usually means a human is working in it.
   */
  private async advanceBaseCheckout(
    repository: Repository,
    cwd: string,
  ): Promise<{ branch: string; from: string; to: string } | undefined> {
    try {
      if (await this.isDirty(cwd)) {
        return undefined;
      }
      const branch = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      if (branch !== repository.defaultBranch) {
        return undefined;
      }
      const from = (await this.run(["rev-parse", "HEAD"], cwd)).trim();
      // ff-only: a diverged base checkout must never get a merge commit here.
      await this.run(["merge", "--ff-only", `origin/${repository.defaultBranch}`], cwd);
      const to = (await this.run(["rev-parse", "HEAD"], cwd)).trim();
      return from === to ? undefined : { branch, from, to };
    } catch {
      // Diverged, no upstream, ... — the Run still starts from origin/<branch>.
      return undefined;
    }
  }

  async syncRepository(repository: Repository): Promise<SyncOutcome> {
    const cwd = repository.localPath;
    const remote = "origin";
    const branch = repository.defaultBranch;

    const remoteUrl = await this.tryRun(["remote", "get-url", remote], cwd);
    if (!remoteUrl) {
      return {
        repositoryId: repository.id,
        branch,
        previousHead: "",
        head: "",
        updated: false,
        skipped: "no_remote",
        message: `${cwd} 没有名为 ${remote} 的远端（先 git clone 出真正的基仓）`,
      };
    }

    if (await this.isDirty(cwd)) {
      return {
        repositoryId: repository.id,
        branch,
        previousHead: "",
        head: "",
        updated: false,
        skipped: "dirty_worktree",
        message: `${cwd} 有未提交改动，已跳过（避免覆盖）`,
      };
    }

    const currentBranch = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    if (currentBranch !== branch) {
      return {
        repositoryId: repository.id,
        branch,
        previousHead: "",
        head: "",
        updated: false,
        skipped: "not_on_default_branch",
        message: `${cwd} 当前在 ${currentBranch}，不是 ${branch}，已跳过`,
      };
    }

    const previousHead = (await this.run(["rev-parse", "HEAD"], cwd)).trim();
    await this.run(["fetch", "--prune", remote], cwd);
    // ff-only: never create a merge commit in the base checkout.
    await this.run(["merge", "--ff-only", `${remote}/${branch}`], cwd);
    const head = (await this.run(["rev-parse", "HEAD"], cwd)).trim();

    return {
      repositoryId: repository.id,
      branch,
      previousHead,
      head,
      updated: previousHead !== head,
      message:
        previousHead === head
          ? `已是最新（${head.slice(0, 8)}）`
          : `${previousHead.slice(0, 8)} → ${head.slice(0, 8)}`,
    };
  }

  /**
   * Commit the agent's file changes in one worktree and push that branch.
   *
   * Two hard guards, independent of what a Task or the model asks for:
   *   - the repository profile must allow pushing at all (`gitPush: allow`);
   *   - only branches under `pushPrefix` are ever pushed, and never the
   *     repository's default branch.
   */
  async publishWorkspace(input: {
    repository: Repository;
    workspacePath: string;
    targetId?: string;
    message: string;
  }): Promise<PublishOutcome> {
    const { repository, workspacePath } = input;
    const base = {
      repositoryId: repository.id,
      targetId: input.targetId,
      remote: "origin",
    };

    if (repository.executionProfile.policy.gitPush !== "allow") {
      return {
        ...base,
        branch: "",
        filesChanged: 0,
        committed: false,
        pushed: false,
        skipped: "push_disabled",
        // TASK-1239: this is the one outcome an operator can fix in a single
        // command, so say which one. Default profiles stay restrictive; the
        // message is what stops the operator from having to read the source.
        message:
          `仓库 ${repository.id} 的执行档案是 gitPush=deny，未推送` +
          `（审批后的改动要推 ai/ 分支需先放开：ai repository update ${repository.id} --git-push allow）`,
      };
    }

    try {
      const branch = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)).trim();
      if (branch === repository.defaultBranch || branch === "main" || branch === "master") {
        return {
          ...base,
          branch,
          filesChanged: 0,
          committed: false,
          pushed: false,
          skipped: "protected_branch",
          message: `拒绝推送到受保护分支 ${branch}`,
        };
      }
      if (!this.pushPrefixes.some((prefix) => branch.startsWith(prefix))) {
        return {
          ...base,
          branch,
          filesChanged: 0,
          committed: false,
          pushed: false,
          skipped: "branch_prefix_not_allowed",
          message: `分支 ${branch} 不在 ${this.pushPrefix} 前缀内，拒绝推送`,
        };
      }

      const status = await this.run(["status", "--porcelain"], workspacePath);
      const filesChanged = status.split("\n").filter((line) => line.trim()).length;
      let commit: string | undefined;

      if (filesChanged > 0) {
        await this.run(["add", "-A"], workspacePath);
        await this.run(
          [
            "-c",
            `user.name=${this.authorName}`,
            "-c",
            `user.email=${this.authorEmail}`,
            "commit",
            "-m",
            input.message,
          ],
          workspacePath,
        );
        commit = (await this.run(["rev-parse", "HEAD"], workspacePath)).trim();
      }

      const ahead = await this.countCommitsAhead(
        workspacePath,
        base.remote,
        repository.defaultBranch,
      );
      if (filesChanged === 0 && ahead === 0) {
        return {
          ...base,
          branch,
          filesChanged: 0,
          committed: false,
          pushed: false,
          skipped: "nothing_to_publish",
          message: `分支 ${branch} 没有可推送的改动`,
        };
      }

      await this.run(["push", base.remote, `${branch}:${branch}`], workspacePath);
      return {
        ...base,
        branch,
        commit,
        filesChanged,
        committed: filesChanged > 0,
        pushed: true,
        message: `已推送 ${base.remote}/${branch}${commit ? ` (${commit.slice(0, 8)})` : ""}`,
      };
    } catch (error) {
      return {
        ...base,
        branch: "",
        filesChanged: 0,
        committed: false,
        pushed: false,
        skipped: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Commits this worktree has on top of the remote's default branch.
   *
   * Comparing against the remote *default* branch (not against
   * `remote/<branch>`) is what keeps an untouched worktree from creating an
   * empty branch on the remote: a branch that does not exist there yet would
   * otherwise look like "1 commit ahead".
   */
  private async countCommitsAhead(
    cwd: string,
    remote: string,
    defaultBranch: string,
  ): Promise<number> {
    const baseRevision = `refs/remotes/${remote}/${defaultBranch}`;
    const exists = await this.tryRun(
      ["rev-parse", "--verify", "--quiet", baseRevision],
      cwd,
    );
    if (exists === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    const out = await this.run(["rev-list", "--count", `${baseRevision}..HEAD`], cwd);
    return Number(out.trim()) || 0;
  }

  private async isDirty(cwd: string): Promise<boolean> {
    const status = await this.run(["status", "--porcelain"], cwd);
    return status.split("\n").some((line) => line.trim().length > 0);
  }

  private async run(args: string[], cwd: string): Promise<string> {
    // Run containers write worktrees as uid 1000 while the harness runs as
    // root, which trips git's "dubious ownership" guard (CVE-2022-24765).
    // Trust exactly the directory we are operating on — it is either a
    // registered base checkout or a workspace the harness itself created —
    // instead of mutating the host's global git config.
    const trusted = ["-c", `safe.directory=${resolve(cwd)}`];
    try {
      const { stdout } = await execFileAsync(this.gitBinary, [...trusted, ...args], {
        cwd,
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout;
    } catch (error) {
      throw new GitError(
        "git_command_failed",
        `git ${args.join(" ")} failed in ${cwd}: ${describeGitError(error)}`,
      );
    }
  }

  /** Same as `run` but returns undefined instead of throwing. */
  private async tryRun(args: string[], cwd: string): Promise<string | undefined> {
    try {
      return await this.run(args, cwd);
    } catch {
      return undefined;
    }
  }
}

function describeGitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) {
    return stderr.trim().split("\n").slice(0, 3).join(" | ");
  }
  return error instanceof Error ? error.message : String(error);
}
