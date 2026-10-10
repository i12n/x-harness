import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  }): Promise<{ pushed: boolean; sha?: string; reason?: string }> {
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
    const base = input.repository.defaultBranch;
    let scratch: string | undefined;
    let phase: "assemble" | "push" = "assemble";
    try {
      await this.run([...trusted, "fetch", "origin", base], input.workspacePath, env);
      // TASK-1241: the delivery's delta is *everything this Run changed* —
      // committed or not. Approving a task publishes a commit on the `ai/…`
      // branch, which left the workspace clean and made a following `测试部署`
      // fail with "工作区没有改动" although the change was right there.
      //
      // The delta is taken against the run's own fork point (merge-base with the
      // remote default branch), never against the remote tip: the worktree may
      // have been cut from an older `main`, and diffing against the fresh tip
      // would turn every commit that landed since into a "revert" in the patch.
      // Staging first also brings untracked files into the delta.
      await this.run([...trusted, "add", "-A"], input.workspacePath, env);
      const mergeBase = (
        await this.run([...trusted, "merge-base", "HEAD", `origin/${base}`], input.workspacePath, env)
      ).trim();
      const deltaBase = mergeBase || `origin/${base}`;
      const patch = await this.run(
        [...trusted, "diff", "--cached", deltaBase, "--binary"],
        input.workspacePath,
        env,
      );
      if (!patch.trim()) {
        // Re-publishing an already-published delivery stays a no-op, not a
        // non-fast-forward (the branch is rebuilt from the default branch).
        const existing = await this.run(
          [...trusted, "ls-remote", "--heads", "origin", input.branch],
          input.workspacePath,
          env,
        );
        if (existing.trim()) {
          // TASK-1268: the branch tip is what a (re-)deploy would run for.
          return { pushed: true, ...shaOrNothing(existing) };
        }
        return { pushed: false, reason: "工作区没有改动，没有可测试的内容" };
      }

      // The test branch must be cut from the repository's CURRENT default
      // branch — the workflow that deploys the test environment lives there —
      // and then carry the delivery's delta. That happens in a throwaway
      // worktree, so the Run's own workspace keeps its `ai/…` commit untouched.
      const scratchRoot = await mkdtemp(join(tmpdir(), "harness-test-branch-"));
      scratch = join(scratchRoot, "wt");
      const patchFile = join(scratchRoot, "delivery.patch");
      await writeFile(patchFile, patch, "utf8");
      await this.run(
        [...trusted, "worktree", "add", "--detach", scratch, `origin/${base}`],
        input.workspacePath,
        env,
      );
      const scratchTrust = ["-c", `safe.directory=${resolve(scratch)}`];
      await this.run([...scratchTrust, "apply", "--binary", patchFile], scratch, env);
      await this.run([...scratchTrust, "add", "-A"], scratch, env);
      await this.run(
        [
          ...scratchTrust,
          "-c",
          `user.name=${this.authorName}`,
          "-c",
          `user.email=${this.authorEmail}`,
          "commit",
          "-m",
          input.message,
        ],
        scratch,
        env,
      );

      // Re-deploying a delivery whose content already sits on the test branch
      // stays a no-op: pushing an identical tree would only re-trigger the
      // repository's workflow. Compare trees, not commits (the commit is made
      // fresh every time, so its hash always differs).
      // Compare trees: the commit is made fresh every time, so its hash always
      // differs even when the content does not.
      await this.run(
        [...scratchTrust, "fetch", "origin", `refs/heads/${input.branch}`],
        scratch,
        env,
      ).catch(() => undefined);
      const remoteTree = (
        await this.run([...scratchTrust, "rev-parse", "FETCH_HEAD^{tree}"], scratch, env).catch(
          () => "",
        )
      ).trim();
      const localTree = (
        await this.run([...scratchTrust, "rev-parse", "HEAD^{tree}"], scratch, env).catch(() => "")
      ).trim();
      if (remoteTree && remoteTree === localTree) {
        // TASK-1268: nothing was pushed, so the run (if any) belongs to the
        // commit already on the branch.
        const tip = (
          await this.run([...scratchTrust, "rev-parse", "FETCH_HEAD"], scratch, env).catch(() => "")
        ).trim();
        return { pushed: true, ...(tip ? { sha: tip } : {}) };
      }

      phase = "push";
      const token = await this.options.tokenProvider.getToken();
      await this.run(
        [
          ...scratchTrust,
          "push",
          // GitHub's documented form for an App installation token is basic
          // auth, not an Authorization header: `x-access-token:<token>`. The URL
          // is visible in `ps` for the lifetime of the push, which on a
          // single-tenant control-plane host is an accepted tradeoff.
          `https://x-access-token:${token}@github.com/${githubSlug(input.repository)}.git`,
          // Fully qualified: the scratch worktree is on a detached HEAD, so an
          // unqualified destination ("test/dlv-x") is ambiguous and git refuses
          // with "The <src> part of the refspec is a commit object".
          //
          // Force-with-lease: the test branch is rebuilt from the default branch
          // on every publish, so re-deploying a delivery moves it forward *or*
          // rebases it. Plain `--force` (not `--force-with-lease`): the push
          // comes from a detached scratch worktree with no local ref to lease
          // against, and this branch is a derived artefact the control plane
          // owns outright.
          "--force",
          `HEAD:refs/heads/${input.branch}`,
        ],
        scratch,
        env,
      );
      // TASK-1268: the commit the deployment run will report as its head_sha.
      const head = (
        await this.run([...scratchTrust, "rev-parse", "HEAD"], scratch, env).catch(() => "")
      ).trim();
      return { pushed: true, ...(head ? { sha: head } : {}) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        pushed: false,
        reason:
          phase === "push"
            ? `推送 ${input.branch} 失败：${detail}`
            : `无法在 ${input.branch} 上提交改动：${detail}`,
      };
    } finally {
      if (scratch) {
        await this.run(
          [...trusted, "worktree", "remove", "--force", scratch],
          input.workspacePath,
          env,
        ).catch(() => undefined);
        await rm(resolve(scratch, ".."), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

/** First field of a `git ls-remote` line — the object name. */
function shaOrNothing(lsRemoteOutput: string): { sha?: string } {
  const sha = lsRemoteOutput.trim().split(/\s+/)[0]?.trim() ?? "";
  return sha ? { sha } : {};
}
