import { describe, expect, it } from "vitest";
import {
  DeployService,
  githubSlug,
  type TestBranchPublisher,
} from "../src/deploy/application/deployService.js";
import type { Repository } from "../src/domain/repository.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import type { GitHubClient, GitHubPullRequest, GitHubWorkflowRun } from "../src/github/githubClient.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { makeId } from "../src/util/id.js";

function repository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-x-music",
    name: "x-music",
    url: "git@github.com:i12n/x-music.git",
    defaultBranch: "main",
    localPath: "/srv/repos/x-music",
    verificationCommands: [],
    executionProfile: defaultExecutionProfile({ name: "default", image: "harness/execution:node22" }),
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

/** A SUCCEEDED run whose workspaces evidence points at a worktree. */
function run() {
  return {
    id: "run-1",
    taskId: "task-1",
    status: "SUCCEEDED",
    result: {
      workspaces: [
        { targetId: "task-1-target-0", path: "/root/ai-workspaces/task-1/run-1/t0" },
      ],
    },
  } as never;
}

function harness(
  options: {
    runs?: GitHubWorkflowRun[];
    existingPr?: GitHubPullRequest;
    deliveryStatus?: string;
  } = {},
) {
  const calls: {
    published: string[];
    opened: string[];
    merged: number[];
    listed: string[];
    released: string[];
    releasedBy: string[];
  } = { published: [], opened: [], merged: [], listed: [], released: [], releasedBy: [] };
  const git: TestBranchPublisher = {
    async publish(input) {
      calls.published.push(input.branch);
      return { pushed: true, sha: "abc123" };
    },
  };
  const github: GitHubClient = {
    async findPullRequest() {
      return options.existingPr;
    },
    async openPullRequest(input) {
      calls.opened.push(`${input.head}→${input.base}`);
      return {
        number: 7,
        url: "https://github.com/i12n/x-music/pull/7",
        state: "open",
        merged: false,
        head: input.head,
        base: input.base,
      };
    },
    async mergePullRequest(input) {
      calls.merged.push(input.number);
      return {
        number: input.number,
        url: "https://github.com/i12n/x-music/pull/7",
        state: "closed",
        merged: true,
        head: "test/dlv-1",
        base: "main",
      };
    },
    async listWorkflowRuns(input) {
      calls.listed.push(input.branch);
      return options.runs ?? [];
    },
  };
  const service = new DeployService({
    deliveries: {
      async load(deliveryId) {
        return {
          delivery: {
            id: deliveryId,
            specificationId: "spec-1",
            status: options.deliveryStatus ?? "IN_PROGRESS",
          } as never,
          tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never],
        };
      },
    },
    repositories: { async findRepository() { return repository(); } },
    runs: { async listRuns() { return [run()]; } },
    git,
    github,
    // TASK-1255: the deploy path's only Delivery write.
    release: {
      async release(deliveryId, actor) {
        calls.released.push(deliveryId);
        calls.releasedBy.push(`${actor.channel}:${actor.userId}`);
      },
    },
    events: new InMemoryEventStore(),
  });
  return { service, calls };
}

describe("test-branch deploy, GitHub-driven (TASK-1230)", () => {
  it("pushes test/<deliveryId> and opens a PR into the default branch", async () => {
    const { service, calls } = harness();
    const started = await service.deployTest("dlv-1");
    expect(calls.published).toEqual(["test/dlv-1"]);
    expect(calls.opened).toEqual(["test/dlv-1→main"]);
    expect(started.pullRequest.number).toBe(7);
  });

  it("reuses an existing PR instead of opening a second one", async () => {
    const { service, calls } = harness({
      existingPr: {
        number: 3,
        url: "https://github.com/i12n/x-music/pull/3",
        state: "open",
        merged: false,
        head: "test/dlv-1",
        base: "main",
      },
    });
    const started = await service.deployTest("dlv-1");
    expect(calls.opened).toEqual([]);
    expect(started.pullRequest.number).toBe(3);
  });

  // TASK-1256: a released delivery has nothing left to test — its delta is on
  // the default branch, so rebuilding the test branch from it cannot apply.
  it("refuses 测试部署 once the delivery is released", async () => {
    const { service, calls } = harness({ deliveryStatus: "RELEASED" });
    await expect(service.deployTest("dlv-1")).rejects.toThrow(/已经上线/);
    expect(calls.published).toEqual([]);
  });

  it("refuses 测试部署 when the delivery's PR is already merged", async () => {
    const { service, calls } = harness({
      existingPr: {
        number: 9,
        url: "https://github.com/i12n/x-music/pull/9",
        state: "closed",
        merged: true,
        mergedAt: "2026-10-09T08:35:00Z",
        head: "test/dlv-1",
        base: "main",
      },
    });
    await expect(service.deployTest("dlv-1")).rejects.toThrow(/已经合并/);
    expect(calls.published).toEqual([]);
  });

  it("reports a queued run as pending, and success as succeeded", async () => {
    const pending = harness({
      runs: [
        {
          id: 1,
          name: "deploy-test",
          branch: "test/dlv-1",
          status: "in_progress",
          url: "https://github.com/i12n/x-music/actions/runs/1",
          createdAt: "2026-10-08T00:00:00Z",
        },
      ],
    });
    expect((await pending.service.status("dlv-1")).state).toBe("pending");

    const ok = harness({
      runs: [
        {
          id: 2,
          name: "deploy-test",
          branch: "test/dlv-1",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/i12n/x-music/actions/runs/2",
          createdAt: "2026-10-08T00:00:00Z",
        },
      ],
    });
    expect((await ok.service.status("dlv-1")).state).toBe("succeeded");
  });

  it("reports 'none' until Actions has queued a run", async () => {
    const { service } = harness({ runs: [] });
    expect((await service.status("dlv-1")).state).toBe("none");
  });

  it("merges only when asked, so production deploys after acceptance", async () => {
    const { service, calls } = harness({
      existingPr: {
        number: 9,
        url: "https://github.com/i12n/x-music/pull/9",
        state: "open",
        merged: false,
        head: "test/dlv-1",
        base: "main",
      },
    });
    const outcome = await service.promote("dlv-1");
    expect(calls.merged).toEqual([9]);
    expect(outcome.merged).toBe(true);
  });

  it("does not merge twice when the PR is already merged (repeat 发布)", async () => {
    const { service, calls } = harness({
      existingPr: {
        number: 9,
        url: "https://github.com/i12n/x-music/pull/9",
        state: "closed",
        merged: true,
        mergedAt: "2026-10-09T08:35:00Z",
        head: "test/dlv-1",
        base: "main",
      },
    });
    const outcome = await service.promote("dlv-1");
    // GitHub answers a second merge of the same PR with 405, so 发布 must not
    // ask again — it only confirms what already happened.
    expect(calls.merged).toEqual([]);
    expect(outcome.alreadyMerged).toBe(true);
    expect(outcome.merged).toBe(true);
  });

  it("re-confirms an already-merged PR into a release once production succeeded", async () => {
    const { service, calls } = harness({
      existingPr: {
        number: 9,
        url: "https://github.com/i12n/x-music/pull/9",
        state: "closed",
        merged: true,
        mergedAt: "2026-10-09T08:35:00Z",
        head: "test/dlv-1",
        base: "main",
      },
      runs: [
        {
          id: 42,
          name: "Deploy app to VPS",
          branch: "main",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/i12n/x-music/actions/runs/42",
          createdAt: "2026-10-09T08:38:00Z",
        },
      ],
    });
    // A restart (or AI_DEPLOY_WATCH=off) loses the watch; 发布 again must still
    // land the release instead of failing on an already-merged PR.
    const outcome = await service.promote("dlv-1");
    expect(outcome.released).toBe(true);
    expect(calls.released).toEqual(["dlv-1"]);
  });

  it("reads the GitHub slug from the remote URL", () => {
    expect(githubSlug(repository())).toBe("i12n/x-music");
    expect(githubSlug(repository({ url: "https://github.com/i12n/x-music.git" }))).toBe(
      "i12n/x-music",
    );
    expect(() => githubSlug(repository({ url: "file:///srv/repos/demo-origin.git" }))).toThrow(
      /不是 GitHub/,
    );
  });

  it("fails clearly when there is no pushed work to deploy", async () => {
    const service = new DeployService({
      deliveries: {
        async load(deliveryId) {
          return { delivery: { id: deliveryId } as never, tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never] };
        },
      },
      repositories: { async findRepository() { return repository(); } },
      runs: { async listRuns() { return []; } },
      git: { async publish() { return { pushed: true }; } },
      github: {} as unknown as GitHubClient,
      events: new InMemoryEventStore(),
    });
    await expect(service.deployTest("dlv-1")).rejects.toThrow(/没有带工作区的成功 Run/);
  });

  it("does not open a PR when the repository refuses the push", async () => {
    const { service, calls } = harness();
    const refusing = new DeployService({
      deliveries: {
        async load(deliveryId) {
          return { delivery: { id: deliveryId } as never, tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never] };
        },
      },
      repositories: { async findRepository() { return repository(); } },
      runs: { async listRuns() { return [run()]; } },
      git: { async publish() { return { pushed: false, reason: "gitPush=deny" }; } },
      github: { async findPullRequest() { return undefined; } } as unknown as GitHubClient,
      events: new InMemoryEventStore(),
    });
    await expect(refusing.deployTest("dlv-1")).rejects.toThrow(/gitPush=deny/);
    expect(calls.opened).toEqual([]);
  });
});

describe("ids stay readable", () => {
  it("uses the delivery id verbatim in the branch", () => {
    const { service } = harness();
    expect(service.branchName("dlv-487e422b44")).toBe("test/dlv-487e422b44");
    expect(makeId("x")).toMatch(/^x-/);
  });
});

describe("release confirmation (TASK-1255)", () => {
  const mergedPr: GitHubPullRequest = {
    number: 9,
    url: "https://github.com/i12n/x-music/pull/9",
    state: "closed",
    merged: true,
    mergedAt: "2026-10-09T08:35:00Z",
    head: "test/dlv-1",
    base: "main",
  };
  const productionRun = (conclusion: GitHubWorkflowRun["conclusion"]): GitHubWorkflowRun => ({
    id: 42,
    name: "Deploy app to VPS",
    branch: "main",
    status: "completed",
    conclusion,
    url: "https://github.com/i12n/x-music/actions/runs/42",
    createdAt: "2026-10-09T08:38:00Z",
  });

  it("records the release once the production run succeeded", async () => {
    const { service, calls } = harness({
      existingPr: mergedPr,
      runs: [productionRun("success")],
    });
    const outcome = await service.confirmRelease("dlv-1", {
      channel: "feishu",
      userId: "ou_reviewer",
    });
    expect(outcome.released).toBe(true);
    expect(outcome.state).toBe("succeeded");
    expect(calls.released).toEqual(["dlv-1"]);
    // The release record names whoever said 发布, not the deploy watcher.
    expect(calls.releasedBy).toEqual(["feishu:ou_reviewer"]);
  });

  it("leaves a failed production deploy unreleased so it can still be sent back", async () => {
    const { service, calls } = harness({
      existingPr: mergedPr,
      runs: [productionRun("failure")],
    });
    const outcome = await service.confirmRelease("dlv-1");
    expect(outcome.released).toBe(false);
    expect(outcome.state).toBe("failed");
    expect(calls.released).toEqual([]);
  });

  it("does not attribute a run to a merge whose time is unknown", async () => {
    const { service, calls } = harness({
      existingPr: { ...mergedPr, mergedAt: undefined },
      runs: [productionRun("success")],
    });
    const outcome = await service.confirmRelease("dlv-1");
    expect(outcome.merged).toBe(true);
    expect(outcome.state).toBe("none");
    expect(calls.released).toEqual([]);
  });

  it("does not release before the PR is merged", async () => {
    const { service, calls } = harness({
      existingPr: { ...mergedPr, merged: false, state: "open", mergedAt: undefined },
      runs: [productionRun("success")],
    });
    const outcome = await service.confirmRelease("dlv-1");
    expect(outcome.merged).toBe(false);
    expect(calls.released).toEqual([]);
  });
});
