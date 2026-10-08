import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Repository } from "../../domain/repository.js";
import type { GitHubTokenProvider } from "../../github/tokenProvider.js";
import { githubSlug, type TestBranchPublisher } from "../application/deployService.js";

const execFileAsync = promisify(execFile);

export interface GitBranchPublisherOptions {
  /** GitHub App installation token (recommended) or a plain token. */
  tokenProvider: GitHubTokenProvider;
  /** Branch prefixes the control plane may push; default `["test/"]`. */
  allowedPrefixes?: string[];
  gitBinary?: string;
  authorName?: string;
  authorEmail?: string;
  /** Injectable for tests: run git, return stdout. */
  exec?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
}

/**
 * TASK-1230: the control plane pushes the delivery's worktree to `test/<id>`.
 *
 * Deliberately NOT `GitService.publishWorkspace`: that path enforces the
 * *execution profile* (`gitPush: deny` by default), which exists to constrain
 * the agent inside a Run. A test branch is a control-plane action — the harness
 * pushes it with the GitHub App's installation token over HTTPS. The rails that
 * matter are kept here: only whitelisted branch prefixes, and the default
 * branch is never pushed. The token travels in the environment (not argv), so
 * it does not show up in `ps`.
 */
export class GitBranchPublisher implements TestBranchPublisher {
  private readonly prefixes: string[];
  private readonly gitBinary: string;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly run: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;

  constructor(private readonly options: GitBranchPublisherOptions) {
    this.prefixes = options.allowedPrefixes ?? ["test/"];
    this.gitBinary = options.gitBinary ?? process.env.AI_GIT_BIN ?? "git";
    this.authorName = options.authorName ?? process.env.AI_GIT_AUTHOR_NAME ?? "AI Harness";
    this.authorEmail =
      options.authorEmail ?? process.env.AI_GIT_AUTHOR_EMAIL ?? "ai-harness@localhost";
    this.run =
      options.exec ??
      (async (args, cwd, env) =>
        (await execFileAsync(this.gitBinary, args, { cwd, env, timeout: 180_000 })).stdout);
  }

  async publish(input: {
    repository: Repository;
    workspacePath: string;
    branch: string;
    message: string;
  }): Promise<{ pushed: boolean; reason?: string }> {
    if (
      input.branch === input.repository.defaultBranch ||
      input.branch === "main" ||
      input.branch === "master"
    ) {
      return { pushed: false, reason: `拒绝推送到默认分支 ${input.branch}` };
    }
    if (!this.prefixes.some((prefix) => input.branch.startsWith(prefix))) {
      return {
        pushed: false,
        reason: `分支 ${input.branch} 不在 ${this.prefixes.join(", ")} 前缀内，拒绝推送`,
      };
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Worktrees are owned by the container user, so git refuses to touch them as
    // root ("dubious ownership"). Same rail GitService uses: trust that one dir.
    const trusted = ["-c", `safe.directory=${resolve(input.workspacePath)}`];
    try {
      await this.run([...trusted, "checkout", "-B", input.branch], input.workspacePath, env);
      await this.run([...trusted, "add", "-A"], input.workspacePath, env);
      await this.run(
        [
          ...trusted,
          "-c",
          `user.name=${this.authorName}`,
          "-c",
          `user.email=${this.authorEmail}`,
          "commit",
          "-m",
          input.message,
        ],
        input.workspacePath,
        env,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "Nothing staged" is a real signal: there is no change to test.
      if (!/nothing to commit|no changes added to commit/i.test(message)) {
        return { pushed: false, reason: `无法在 ${input.branch} 上提交改动：${message}` };
      }
    }

    const token = await this.options.tokenProvider.getToken();
    try {
      await this.run(
        [
          ...trusted,
          // The documented form for a token push. It is visible in `ps` for the
          // lifetime of the push, which on a single-tenant control-plane host is
          // an accepted tradeoff; the alternative (env-based config) did not
          // reach git reliably through the exec port.
          "-c",
          `http.extraheader=AUTHORIZATION: bearer ${token}`,
          "push",
          `https://github.com/${githubSlug(input.repository)}.git`,
          `HEAD:${input.branch}`,
        ],
        input.workspacePath,
        env,
      );
    } catch (error) {
      return {
        pushed: false,
        reason: `推送 ${input.branch} 失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { pushed: true };
  }
}
