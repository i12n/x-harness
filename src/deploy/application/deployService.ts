import type { Delivery } from "../../domain/delivery.js";
import type { EventRecord } from "../../domain/event.js";
import type { Repository } from "../../domain/repository.js";
import type { Run } from "../../domain/run.js";
import type { Task } from "../../domain/task.js";
import { latestDeliveryProduct } from "../../delivery/application/product.js";
import {
  githubSlugFromUrl,
  type GitHubClient,
  type GitHubPullRequest,
  type GitHubWorkflow,
  type GitHubWorkflowRun,
} from "../../github/githubClient.js";
import { GitHubRequestError, HarnessError } from "../../errors.js";
import type { EventStore } from "../../store/eventStore.js";
import { DEPLOY_PROD_WORKFLOW, DEPLOY_TEST_WORKFLOW, deployWorkflowPath } from "../domain/deployWorkflow.js";

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

/**
 * TASK-1255: the one write the deploy path performs on a Delivery. It is only
 * called once the *production* deploy is confirmed — never when the PR merely
 * merges — because RELEASED is the freeze point for the delivery.
 */
export interface DeployReleasePort {
  /** Records the release; idempotent for a delivery that is already RELEASED. */
  release(
    deliveryId: string,
    actor: { channel: string; userId: string },
  ): Promise<unknown>;
}

export interface DeployServiceDeps {
  deliveries: DeployDeliveryPort;
  repositories: { findRepository(id: string): Promise<Repository> };
  runs: { listRuns(filter: { taskId: string }): Promise<Run[]> };
  git: TestBranchPublisher;
  github: GitHubClient;
  /** TASK-1255: records the release once production is confirmed. */
  release?: DeployReleasePort;
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
  /** TASK-1231: which deployment this is — the test env or the production one. */
  kind: "test" | "production";
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
  /**
   * `none` before any run appears — Actions may take a moment to queue.
   *
   * TASK-1268: `unconfigured` means the repository does not declare the
   * conventional deploy workflow, so the harness cannot tell whether anything
   * was deployed. It is deliberately not a success: no card says "ready" and no
   * release is written from it.
   */
  state: "none" | "pending" | "succeeded" | "failed" | "unconfigured";
  /** TASK-1268: the deploy workflow this status was read from. */
  workflow?: string;
}

export interface PromoteOutcome {
  deliveryId: string;
  merged: boolean;
  pullRequest: GitHubPullRequest;
  /** TASK-1255: the PR was already merged (a repeat 发布, or after a restart). */
  alreadyMerged?: boolean;
  /** TASK-1255: this call confirmed the production deploy and recorded the release. */
  released?: boolean;
  /** Latest production run state when it could be attributed to this merge. */
  productionState?: TestDeployStatus["state"];
}

/** TASK-1255: what the repository's own production workflow is doing. */
export interface ProductionStatus {
  deliveryId: string;
  /** The test PR has been merged into the default branch. */
  merged: boolean;
  /** `none` also means "not attributable yet" — see `mergedAt`. */
  state: TestDeployStatus["state"];
  run?: GitHubWorkflowRun;
  pullRequest?: GitHubPullRequest;
}

export interface ReleaseConfirmation extends ProductionStatus {
  /** True when this call wrote the release. */
  released: boolean;
}

/** The release written by the deployment itself has no human behind it. */
const DEPLOY_ACTOR = { channel: "system", userId: "deploy-watch" };

/** TASK-1272: events that open a watch, and events that close one. */
const DEPLOY_START_EVENTS = ["TestBranchPushed", "TestMerged"] as const;
const DEPLOY_END_EVENTS = [
  "TestDeploySucceeded",
  "TestDeployFailed",
  "TestDeployStale",
  "ReleaseConfirmed",
] as const;

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
  private readonly watching = new Map<
    string,
    {
      last: string;
      startedAt: number;
      nextAt: number;
      branch: string;
      sinceMs: number;
      kind: "test" | "production";
      /** TASK-1268: the commit this watch belongs to, when we know it. */
      headSha?: string;
    }
  >();

  constructor(private readonly deps: DeployServiceDeps) {
    this.branchPrefix = deps.branchPrefix ?? "test/";
    this.watchIntervalMs = deps.watchIntervalMs ?? 30_000;
    this.watchTtlMs = deps.watchTtlMs ?? 30 * 60_000;
    this.now = deps.now ?? (() => new Date());
  }

  /** TASK-1231: start watching a deployment (called when the branch is pushed). */
  watch(
    deliveryId: string,
    options: {
      branch?: string;
      kind?: "test" | "production";
      sinceMs?: number;
      headSha?: string;
    } = {},
  ): void {
    const at = this.now().getTime();
    this.watching.set(deliveryId, {
      last: "unknown",
      startedAt: at,
      nextAt: at,
      branch: options.branch ?? this.branchName(deliveryId),
      // Only runs created *after* the watch started count: otherwise a branch
      // that was already deployed reports "succeeded" from its old run.
      // TASK-1255: the merge time wins when we know it — a repeat 发布 of an
      // already-merged PR must still see the deploy that merge triggered.
      sinceMs: options.sinceMs ?? at,
      kind: options.kind ?? "test",
      ...(options.headSha ? { headSha: options.headSha } : {}),
    });
  }

  watched(): string[] {
    return [...this.watching.keys()];
  }

  /**
   * TASK-1272: watches live in memory, so a restart used to drop every
   * in-flight deployment silently — the delivery never got a terminal card
   * (the production path had `confirmRelease` as a fallback, the test path had
   * nothing). On startup we re-derive the unfinished ones from the event log
   * and resume watching; the first poll then reports whatever GitHub says now.
   *
   * A deployment counts as unfinished when its latest "started" event
   * (`TestBranchPushed` / `TestMerged`) has no terminal event after it.
   * `TestDeployUnconfigured` is deliberately *not* terminal: that watch is
   * still waiting for the repository to be fixed.
   */
  async restore(): Promise<number> {
    const events = this.deps.events;
    if (!events) {
      return 0;
    }
    const starts = await this.latestEventsByDelivery(events, DEPLOY_START_EVENTS);
    const terminals = await this.latestEventsByDelivery(events, DEPLOY_END_EVENTS);
    let restored = 0;
    for (const [deliveryId, start] of starts) {
      const end = terminals.get(deliveryId);
      if (end && end.createdAt >= start.createdAt) {
        continue;
      }
      const payload = asRecord(start.payload) ?? {};
      const kind = start.type === "TestMerged" ? "production" : "test";
      const branch =
        kind === "production"
          ? await this.resolveRepository(deliveryId)
              .then((repository) => repository.defaultBranch)
              .catch(() => undefined)
          : typeof payload.branch === "string"
            ? payload.branch
            : this.branchName(deliveryId);
      if (!branch) {
        continue;
      }
      const headSha = firstText(payload.headSha, payload.mergeCommitSha);
      // TASK-1270: prefer the merge time when we have it; the head sha is what
      // really pins the run, so the time is only a fallback for thin clients.
      const sinceMs =
        kind === "production" && typeof payload.mergedAt === "string"
          ? Date.parse(payload.mergedAt)
          : Date.parse(start.createdAt);
      this.watch(deliveryId, {
        branch,
        kind,
        ...(Number.isFinite(sinceMs) ? { sinceMs } : {}),
        ...(headSha ? { headSha } : {}),
      });
      await this.record("DeployWatchResumed", { deliveryId, kind, branch });
      restored += 1;
    }
    return restored;
  }

  /** The newest event per delivery among `types` (event log is append-only). */
  private async latestEventsByDelivery(
    events: EventStore,
    types: readonly string[],
  ): Promise<Map<string, EventRecord>> {
    const byDelivery = new Map<string, EventRecord>();
    for (const type of types) {
      const rows = await events.listEvents({ type }).catch(() => [] as EventRecord[]);
      for (const row of rows) {
        const deliveryId = deliveryIdOf(row.payload);
        if (!deliveryId) {
          continue;
        }
        const current = byDelivery.get(deliveryId);
        if (!current || isNewerEvent(row, current)) {
          byDelivery.set(deliveryId, row);
        }
      }
    }
    return byDelivery;
  }

  /**
   * TASK-1231: poll the watched deployments and report only *changes*, so the
   * caller can notify once per state instead of every tick. The only write it
   * performs is TASK-1255's release, and only when a *production* deploy
   * succeeded; it never deploys anything and never re-notifies an unchanged
   * state.
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
        transitions.push({ deliveryId, state: "stale", kind: entry.kind, terminal: true });
        await this.record("TestDeployStale", { deliveryId });
        continue;
      }
      let status: TestDeployStatus;
      try {
        status = await this.statusOn(deliveryId, entry.branch, entry.sinceMs, {
          kind: entry.kind,
          ...(entry.headSha ? { headSha: entry.headSha } : {}),
        });
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
        kind: entry.kind,
        ...(status.run ? { run: status.run } : {}),
        terminal,
      });
      await this.record(
        status.state === "succeeded"
          ? "TestDeploySucceeded"
          : status.state === "failed"
            ? "TestDeployFailed"
            : status.state === "unconfigured"
              ? // TASK-1268: keep it distinguishable in the audit log — this is a
                // repository problem, not a deployment that is still running.
                "TestDeployUnconfigured"
              : "TestDeployProgress",
        { deliveryId, state: status.state, run: status.run?.url },
      );
      // TASK-1255: the production deploy is what "上线" means, so it — not the
      // PR merge — writes the release. Leaving the delivery at
      // READY_FOR_RELEASE here was the bug this closes; releasing on merge
      // instead would freeze a delivery whose deploy then failed.
      if (entry.kind === "production" && status.state === "succeeded") {
        await this.recordRelease(deliveryId, DEPLOY_ACTOR, status.run);
      }
    }
    return transitions;
  }

  branchName(deliveryId: string): string {
    return `${this.branchPrefix}${deliveryId}`;
  }

  async deployTest(deliveryId: string): Promise<TestDeployStart> {
    const { repository, worktree, delivery } = await this.resolve(deliveryId);
    const branch = this.branchName(deliveryId);
    // TASK-1256: a delivery that is already merged has nothing left to test —
    // its delta is on the default branch, so rebuilding the test branch from it
    // cannot apply and surfaced as a raw `git apply` error. Refuse in words.
    if (delivery.status === "RELEASED") {
      throw new Error(
        `交付 ${deliveryId} 已经上线，不需要再推测试环境；要再改请开新需求`,
      );
    }
    const repo = githubSlug(repository);
    const existing = await this.deps.github.findPullRequest({
      repo,
      head: branch,
      base: repository.defaultBranch,
    });
    if (existing?.merged) {
      throw new Error(
        `交付 ${deliveryId} 的改动已经合并进 ${repository.defaultBranch}，不需要再推测试环境；` +
          "要再改请开新需求（或先打回这份交付）",
      );
    }
    // TASK-1268: refuse in words when the repository clearly does not declare
    // the test workflow, instead of pushing, saying "部署中" and never being
    // able to tell. A failed lookup is not evidence — the watcher reports
    // `unconfigured` on its own if the workflow really is missing.
    await this.assertDeployWorkflow(repository, repo, DEPLOY_TEST_WORKFLOW, "测试环境");

    // TASK-1270: take the clock *before* the push. `watch()` otherwise defaults
    // `sinceMs` to when it is called — after the push→PR round-trip — and a run
    // the push triggered then looks older than the watch (GitHub's `createdAt`
    // only has second precision), so it was filtered out on every poll.
    const pushedAt = this.now().getTime();
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
    await this.record("TestBranchPushed", {
      deliveryId,
      repositoryId: repository.id,
      branch,
      // TASK-1272: enough for a restart to resume this watch (see restore()).
      ...(publish.sha ? { headSha: publish.sha } : {}),
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
    // TASK-1268: pinned to the commit we just pushed.
    // TASK-1270: and counting runs from the push itself, not from the watch.
    this.watch(deliveryId, {
      sinceMs: pushedAt,
      ...(publish.sha ? { headSha: publish.sha } : {}),
    });
    return { deliveryId, repositoryId: repository.id, branch, pullRequest };
  }

  /** Observe the repository's own deployment: we only read the runs. */
  async status(deliveryId: string): Promise<TestDeployStatus> {
    return this.statusOn(deliveryId, this.branchName(deliveryId), 0, { kind: "test" });
  }

  /**
   * TASK-1231: observe one branch. `sinceMs` ignores runs older than the watch,
   * so a re-published branch cannot report success from its previous run.
   *
   * TASK-1268: the answer is scoped to the conventional deploy workflow for
   * `kind` — never "the newest run on this branch". A push also triggers the
   * repository's PR checks, and the fast one used to be mistaken for the
   * deployment (a delivery was announced ready while the real deploy was still
   * building). `headSha` pins the run to the commit this watch belongs to.
   */
  private async statusOn(
    deliveryId: string,
    branch: string,
    sinceMs: number,
    options: { kind?: "test" | "production"; headSha?: string } = {},
  ): Promise<TestDeployStatus> {
    const kind = options.kind ?? "test";
    const workflow = kind === "production" ? DEPLOY_PROD_WORKFLOW : DEPLOY_TEST_WORKFLOW;
    // Only the repository is needed here — requiring a succeeded Run (and its
    // worktree) would make a deployment unobservable exactly when it matters.
    const repository = await this.resolveRepository(deliveryId);
    const repo = githubSlug(repository);
    let runs: GitHubWorkflowRun[];
    try {
      runs = await this.deps.github.listWorkflowRuns({
        repo,
        branch,
        limit: 5,
        workflow,
        event: "push",
      });
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404) {
        // The repository stopped declaring that workflow. Saying so beats
        // reporting whatever else happened to run on this branch.
        return { deliveryId, branch, state: "unconfigured", workflow };
      }
      throw error;
    }
    // Newest first, so the first matching run is the one we watch.
    //
    // TASK-1270: when both sides know the commit, the sha *is* the identity of
    // this watch. The time guard used to run first, and because GitHub
    // timestamps only have second precision a run created in the same second
    // as — but just before — `sinceMs` was dropped forever: the watch reported
    // `none` on every poll and only surfaced as "部署超时" 30 minutes later.
    // The guard still applies whenever the API did not report a head sha.
    const run = runs.find((candidate) => {
      // Both guards only bite when the API actually reported the field, so a
      // thin client (or an older GitHub response) cannot make a watch hang.
      if (candidate.event && candidate.event !== "push") {
        return false;
      }
      if (options.headSha && candidate.headSha) {
        return candidate.headSha === options.headSha;
      }
      return Date.parse(candidate.createdAt) >= sinceMs;
    });
    if (!run) {
      return { deliveryId, branch, state: "none", workflow };
    }
    return { deliveryId, branch, run, state: summarize(run), workflow };
  }

  /**
   * Called only after a human accepted: merge so production deploys.
   *
   * TASK-1255: idempotent, because 发布 is a human action that must be safe to
   * repeat — GitHub answers a second merge of the same PR with 405. When the PR
   * is already merged (a repeat, or a restart that lost the watch) we skip the
   * merge and confirm the production deploy on demand, which is also the
   * fallback for `AI_DEPLOY_WATCH=off`.
   */
  async promote(
    deliveryId: string,
    actor: { channel: string; userId: string } = DEPLOY_ACTOR,
  ): Promise<PromoteOutcome> {
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
    const alreadyMerged = pullRequest.merged;
    const merged = alreadyMerged
      ? pullRequest
      : await this.deps.github.mergePullRequest({
          repo,
          number: pullRequest.number,
        });
    if (!alreadyMerged) {
      await this.record("TestMerged", {
        deliveryId,
        repositoryId: repository.id,
        pullRequest: merged.number,
        url: merged.url,
        // TASK-1272: the merge commit is what the production watch pins to.
        ...(merged.mergedAt ? { mergedAt: merged.mergedAt } : {}),
        ...(merged.mergeCommitSha ? { mergeCommitSha: merged.mergeCommitSha } : {}),
      });
    }
    // TASK-1231: the merge itself triggers the repository's production workflow.
    // Watch the default branch from this moment so the上线 result is reported.
    const mergedAtMs = merged.mergedAt ? Date.parse(merged.mergedAt) : Number.NaN;
    this.watch(deliveryId, {
      branch: repository.defaultBranch,
      kind: "production",
      ...(Number.isFinite(mergedAtMs) ? { sinceMs: mergedAtMs } : {}),
      // TASK-1268: the merge commit is what the production workflow runs for.
      ...(merged.mergeCommitSha ? { headSha: merged.mergeCommitSha } : {}),
    });
    // TASK-1255: also confirm now, so the release does not depend on a watch
    // that a restart (or AI_DEPLOY_WATCH=off) may never deliver.
    const confirmed = await this.confirmRelease(deliveryId, actor);
    return {
      deliveryId,
      merged: alreadyMerged || merged.merged,
      pullRequest: merged,
      alreadyMerged,
      released: confirmed.released,
      productionState: confirmed.state,
    };
  }

  /**
   * TASK-1255: the repository's production view of a Delivery — has the test PR
   * been merged, and what did the default-branch run created at/after that
   * merge conclude?
   *
   * Without a merge timestamp no run can be attributed to *this* merge, so the
   * state stays `none` rather than picking the newest run on the branch (which
   * could belong to an earlier deploy).
   */
  async productionStatus(deliveryId: string): Promise<ProductionStatus> {
    const repository = await this.resolveRepository(deliveryId);
    const repo = githubSlug(repository);
    const pullRequest = await this.deps.github.findPullRequest({
      repo,
      head: this.branchName(deliveryId),
      base: repository.defaultBranch,
    });
    if (!pullRequest?.merged) {
      return {
        deliveryId,
        merged: false,
        state: "none",
        ...(pullRequest ? { pullRequest } : {}),
      };
    }
    const since = pullRequest.mergedAt ? Date.parse(pullRequest.mergedAt) : Number.NaN;
    if (!Number.isFinite(since)) {
      return { deliveryId, merged: true, state: "none", pullRequest };
    }
    // TASK-1268: only the production deploy workflow, and only a run for the
    // merge commit. A fast checks workflow finishing on `main` used to be enough
    // to mark a delivery released.
    const status = await this.statusOn(deliveryId, repository.defaultBranch, since, {
      kind: "production",
      ...(pullRequest.mergeCommitSha ? { headSha: pullRequest.mergeCommitSha } : {}),
    });
    return {
      deliveryId,
      merged: true,
      state: status.state,
      ...(status.run ? { run: status.run } : {}),
      pullRequest,
    };
  }

  /**
   * TASK-1255: record the release iff the production deploy is confirmed.
   * `release()` upstream refuses anything that is not READY_FOR_RELEASE and is
   * idempotent, so this is safe to call repeatedly (repeat 发布, watch, restart).
   */
  async confirmRelease(
    deliveryId: string,
    actor: { channel: string; userId: string } = DEPLOY_ACTOR,
  ): Promise<ReleaseConfirmation> {
    const status = await this.productionStatus(deliveryId);
    const released =
      status.merged && status.state === "succeeded"
        ? await this.recordRelease(deliveryId, actor, status.run)
        : false;
    return { ...status, released };
  }

  /**
   * The single release write. Failures are recorded, never thrown: this runs
   * inside the watch loop and must not take the service down.
   */
  private async recordRelease(
    deliveryId: string,
    actor: { channel: string; userId: string },
    run?: GitHubWorkflowRun,
  ): Promise<boolean> {
    if (!this.deps.release) {
      return false;
    }
    try {
      await this.deps.release.release(deliveryId, actor);
    } catch (error) {
      await this.record("ReleaseConfirmFailed", {
        deliveryId,
        reason: describeError(error),
      });
      return false;
    }
    await this.record("ReleaseConfirmed", {
      deliveryId,
      ...(run?.url ? { run: run.url } : {}),
    });
    return true;
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

  /**
   * TASK-1268: the onboarding gate refuses repositories that do not declare the
   * convention, but one registered before the gate existed (or renamed
   * afterwards) would otherwise fail silently: the branch is pushed, the card
   * says "部署中", and no run ever matches. Refuse in words instead.
   */
  private async assertDeployWorkflow(
    repository: Repository,
    repo: string,
    workflow: string,
    label: string,
  ): Promise<void> {
    let workflows: GitHubWorkflow[];
    try {
      workflows = await this.deps.github.listWorkflows({ repo });
    } catch {
      // Cannot look it up (network, credentials): not evidence of a violation.
      // The watcher reports `unconfigured` by itself if the workflow is gone.
      return;
    }
    if (workflows.some((entry) => entry.path === deployWorkflowPath(workflow))) {
      return;
    }
    const known =
      workflows.length > 0 ? workflows.map((entry) => entry.path).join("、") : "（读不到任何工作流）";
    throw new HarnessError(
      `仓库 ${repository.id} 没有${label}部署工作流 ${deployWorkflowPath(workflow)}：` +
        "harness 无法确认部署结果，所以不推分支。" +
        `请把该工作流按约定命名（文件必须是 .github/workflows/${workflow}）后重试。` +
        `现有工作流：${known}`,
    );
  }

  /** Delivery → its repository and the worktree a Run left behind. */
  private async resolve(
    deliveryId: string,
  ): Promise<{ repository: Repository; worktree: string; delivery: Delivery }> {
    const { delivery, tasks } = await this.deps.deliveries.load(deliveryId);
    // TASK-1267: push the *newest* worktree in the delivery. Picking the first
    // task was wrong as soon as a delivery could gain a revision: the revision
    // is the newest content, and an older worktree would hide it.
    const product = await latestDeliveryProduct(tasks, this.deps.runs);
    if (!product) {
      throw new Error(`交付 ${deliveryId} 没有带工作区的成功 Run，无法推送测试分支`);
    }
    const repository = await this.deps.repositories.findRepository(
      product.task.repositoryId,
    );
    return { repository, worktree: product.path, delivery };
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

/** The delivery an event payload belongs to, when it names one. */
function deliveryIdOf(payload: unknown): string | undefined {
  const record = asRecord(payload);
  return typeof record?.deliveryId === "string" && record.deliveryId
    ? record.deliveryId
    : undefined;
}

/** Event log order: createdAt, then id to break same-millisecond ties. */
function isNewerEvent(candidate: EventRecord, current: EventRecord): boolean {
  return candidate.createdAt === current.createdAt
    ? candidate.id > current.id
    : candidate.createdAt > current.createdAt;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

/** A short reason for the event log; release failures must not be silent. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `owner/name` from the repository's remote URL. */
export function githubSlug(repository: Repository): string {
  const slug = githubSlugFromUrl(repository.url);
  if (!slug) {
    throw new Error(`仓库 ${repository.id} 的地址不是 GitHub：${repository.url}`);
  }
  return slug;
}
