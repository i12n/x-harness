import type { Delivery } from "../../domain/delivery.js";
import type { Repository } from "../../domain/repository.js";
import type { Run } from "../../domain/run.js";
import type { Task } from "../../domain/task.js";
import type { GitHubClient, GitHubPullRequest, GitHubWorkflowRun } from "../../github/githubClient.js";
import type { EventStore } from "../../store/eventStore.js";
import { extractWorkspacesInfo } from "../../workspace/info.js";

/** Pushes a branch to a repository (the harness's existing git path). */
export interface TestBranchPublisher {
  publish(input: {
    repository: Repository;
    workspacePath: string;
    branch: string;
    message: string;
  }): Promise<{ pushed: boolean; sha?: string; reason?: string }>;
}

export interface DeployDeliveryPort {
  load(deliveryId: string): Promise<{ delivery: Delivery; tasks: Task[] }>;
}

export interface DeployServiceDeps {
  deliveries: DeployDeliveryPort;
  repositories: { findRepository(id: string): Promise<Repository> };
  runs: { listRuns(filter: { taskId: string }): Promise<Run[]> };
  git: TestBranchPublisher;
  github: GitHubClient;
  events?: EventStore;
  /** Test branches are `<prefix><deliveryId>`; default `test/`. */
  branchPrefix?: string;
  /** TASK-1231: how often a watched deployment is polled; default 30s. */
  watchIntervalMs?: number;
  /** TASK-1231: give up watching after this long; default 30min. */
  watchTtlMs?: number;
  now?: () => Date;
}

/** TASK-1231: one observed change while watching a deployment. */
export interface DeployTransition {
  deliveryId: string;
  state: TestDeployStatus["state"] | "stale";
  run?: GitHubWorkflowRun;
  /** Terminal states stop the watch. */
  terminal: boolean;
}

export interface TestDeployStart {
  deliveryId: string;
  repositoryId: string;
  branch: string;
  pullRequest: GitHubPullRequest;
}

export interface TestDeployStatus {
  deliveryId: string;
  branch: string;
  /** Latest run on the branch, when any has started. */
  run?: GitHubWorkflowRun;
  /** `none` before any run appears — Actions may take a moment to queue. */
  state: "none" | "pending" | "succeeded" | "failed";
}

export interface PromoteOutcome {
  deliveryId: string;
  merged: boolean;
  pullRequest: GitHubPullRequest;
}

/**
 * TASK-1230: the harness's whole role in deployment.
 *
 * Push the code to a test branch, let the repository's GitHub Actions build and
 * deploy it, watch the run, and — once a human accepted — merge to `main` so
 * the repository's own production workflow fires. The harness never holds a
 * deployment credential and never talks to a test or production environment.
 */
export class DeployService {
  private readonly branchPrefix: string;
  private readonly watchIntervalMs: number;
  private readonly watchTtlMs: number;
  private readonly now: () => Date;
  /** TASK-1231: deliveries being watched → last state seen and next check time. */
  private readonly watching = new Map<string, { last: string; startedAt: number; nextAt: number }>();

  constructor(private readonly deps: DeployServiceDeps) {
    this.branchPrefix = deps.branchPrefix ?? "test/";
    this.watchIntervalMs = deps.watchIntervalMs ?? 30_000;
    this.watchTtlMs = deps.watchTtlMs ?? 30 * 60_000;
    this.now = deps.now ?? (() => new Date());
  }

  /** TASK-1231: start watching a deployment (called when the branch is pushed). */
  watch(deliveryId: string): void {
    const at = this.now().getTime();
    this.watching.set(deliveryId, { last: "unknown", startedAt: at, nextAt: at });
  }

  watched(): string[] {
    return [...this.watching.keys()];
  }

  /**
   * TASK-1231: poll the watched deployments and report only *changes*, so the
   * caller can notify once per state instead of every tick. Read-only: it never
   * deploys anything, and it never re-notifies an unchanged state.
   */
  async poll(): Promise<DeployTransition[]> {
    const transitions: DeployTransition[] = [];
    const at = this.now().getTime();
    for (const [deliveryId, entry] of [...this.watching]) {
      if (at < entry.nextAt) {
        continue;
      }
      entry.nextAt = at + this.watchIntervalMs;
      if (at - entry.startedAt > this.watchTtlMs) {
        this.watching.delete(deliveryId);
        transitions.push({ deliveryId, state: "stale", terminal: true });
        await this.record("TestDeployStale", { deliveryId });
        continue;
      }
      let status: TestDeployStatus;
      try {
        status = await this.status(deliveryId);
      } catch (error) {
        // A failed lookup is not a failed deployment: keep watching, say nothing.
        continue;
      }
      if (status.state === entry.last) {
        continue;
      }
      entry.last = status.state;
      const terminal = status.state === "succeeded" || status.state === "failed";
      if (terminal) {
        this.watching.delete(deliveryId);
      }
      transitions.push({
        deliveryId,
        state: status.state,
        ...(status.run ? { run: status.run } : {}),
        terminal,
      });
      await this.record(
        status.state === "succeeded"
          ? "TestDeploySucceeded"
          : status.state === "failed"
            ? "TestDeployFailed"
            : "TestDeployProgress",
        { deliveryId, state: status.state, run: status.run?.url },
      );
    }
    return transitions;
  }

  branchName(deliveryId: string): string {
    return `${this.branchPrefix}${deliveryId}`;
  }

  async deployTest(deliveryId: string): Promise<TestDeployStart> {
    const { repository, worktree } = await this.resolve(deliveryId);
    const branch = this.branchName(deliveryId);
    const publish = await this.deps.git.publish({
      repository,
      workspacePath: worktree,
      branch,
      message: `test: ${deliveryId} (harness)`,
    });
    if (!publish.pushed) {
      throw new Error(
        `测试分支未推送（${publish.reason ?? "仓库策略拒绝推送"}）：${repository.id}`,
      );
    }
    await this.record("TestBranchPushed", { deliveryId, repositoryId: repository.id, branch });

    const repo = githubSlug(repository);
    const existing = await this.deps.github.findPullRequest({
      repo,
      head: branch,
      base: repository.defaultBranch,
    });
    const pullRequest =
      existing ??
      (await this.deps.github.openPullRequest({
        repo,
        head: branch,
        base: repository.defaultBranch,
        title: `测试环境：${deliveryId}`,
        body:
          `由 harness 推送的测试分支。\n\n` +
          `- 交付：${deliveryId}\n- 测试分支：\`${branch}\`\n\n` +
          `合并本 PR 到 \`${repository.defaultBranch}\` 即触发线上发布。`,
      }));
    await this.record("TestPullRequestReady", {
      deliveryId,
      repositoryId: repository.id,
      branch,
      pullRequest: pullRequest.number,
      url: pullRequest.url,
    });
    // TASK-1231: from here the loop watches the repository's own deployment.
    this.watch(deliveryId);
    return { deliveryId, repositoryId: repository.id, branch, pullRequest };
  }

  /** Observe the repository's own deployment: we only read the runs. */
  async status(deliveryId: string): Promise<TestDeployStatus> {
    // Only the repository is needed here — requiring a succeeded Run (and its
    // worktree) would make a deployment unobservable exactly when it matters.
    const repository = await this.resolveRepository(deliveryId);
    const branch = this.branchName(deliveryId);
    const runs = await this.deps.github.listWorkflowRuns({
      repo: githubSlug(repository),
      branch,
      limit: 5,
    });
    const run = runs[0];
    if (!run) {
      return { deliveryId, branch, state: "none" };
    }
    return { deliveryId, branch, run, state: summarize(run) };
  }

  /** Called only after a human accepted: merge so production deploys. */
  async promote(deliveryId: string): Promise<PromoteOutcome> {
    const repository = await this.resolveRepository(deliveryId);
    const repo = githubSlug(repository);
    const branch = this.branchName(deliveryId);
    const pullRequest = await this.deps.github.findPullRequest({
      repo,
      head: branch,
      base: repository.defaultBranch,
    });
    if (!pullRequest) {
      throw new Error(`没有找到 ${branch} 的 PR，先执行「测试部署 ${deliveryId}」`);
    }
    const merged = await this.deps.github.mergePullRequest({
      repo,
      number: pullRequest.number,
    });
    await this.record("TestMerged", {
      deliveryId,
      repositoryId: repository.id,
      pullRequest: merged.number,
      url: merged.url,
    });
    return { deliveryId, merged: merged.merged, pullRequest: merged };
  }

  /** Delivery → its repository, without demanding a worktree. */
  private async resolveRepository(deliveryId: string): Promise<Repository> {
    const { tasks } = await this.deps.deliveries.load(deliveryId);
    const task = tasks[0];
    if (!task) {
      throw new Error(`交付 ${deliveryId} 没有任务，无法定位仓库`);
    }
    return this.deps.repositories.findRepository(task.repositoryId);
  }

  /** Delivery → its repository and the worktree a Run left behind. */
  private async resolve(
    deliveryId: string,
  ): Promise<{ repository: Repository; worktree: string }> {
    const { tasks } = await this.deps.deliveries.load(deliveryId);
    for (const task of tasks) {
      const runs = await this.deps.runs.listRuns({ taskId: task.id });
      const run = [...runs].reverse().find((candidate) => candidate.status === "SUCCEEDED");
      const workspace = run ? extractWorkspacesInfo(run)[0] : undefined;
      if (!workspace?.path) {
        continue;
      }
      const repository = await this.deps.repositories.findRepository(task.repositoryId);
      return { repository, worktree: workspace.path };
    }
    throw new Error(`交付 ${deliveryId} 没有带工作区的成功 Run，无法推送测试分支`);
  }

  private async record(type: string, payload: unknown): Promise<void> {
    try {
      await this.deps.events?.record({ type, payload });
    } catch {
      // Audit never blocks a deploy.
    }
  }
}

function summarize(run: GitHubWorkflowRun): TestDeployStatus["state"] {
  if (run.status !== "completed") {
    return "pending";
  }
  return run.conclusion === "success" ? "succeeded" : "failed";
}

/** `owner/name` from the repository's remote URL. */
export function githubSlug(repository: Repository): string {
  const match = /github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/.exec(repository.url);
  if (!match) {
    throw new Error(`仓库 ${repository.id} 的地址不是 GitHub：${repository.url}`);
  }
  return match[1]!;
}
