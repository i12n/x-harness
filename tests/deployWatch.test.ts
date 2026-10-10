import { describe, expect, it } from "vitest";
import { DeployService } from "../src/deploy/application/deployService.js";
import { GitHubRequestError } from "../src/errors.js";
import type { GitHubClient, GitHubWorkflowRun } from "../src/github/githubClient.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import type { Repository } from "../src/domain/repository.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";

const repository: Repository = {
  id: "repo-x-music",
  name: "x-music",
  url: "git@github.com:i12n/x-music.git",
  defaultBranch: "main",
  localPath: "/srv/repos/x-music",
  verificationCommands: [],
  executionProfile: defaultExecutionProfile({ name: "default", image: "harness/execution:node22" }),
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

function run(status: GitHubWorkflowRun["status"], conclusion?: GitHubWorkflowRun["conclusion"]) {
  return {
    id: 1,
    name: "deploy-test",
    branch: "test/dlv-1",
    status,
    ...(conclusion ? { conclusion } : {}),
    url: "https://github.com/i12n/x-music/actions/runs/1",
    createdAt: "2026-10-08T00:00:00Z",
    // TASK-1268: the deploy convention — the watcher only reads this workflow,
    // for a `push` event.
    path: ".github/workflows/deploy-test.yml",
    event: "push",
  } satisfies GitHubWorkflowRun;
}

/** The production deploy workflow, on the default branch. */
function prodRun(
  status: GitHubWorkflowRun["status"],
  conclusion?: GitHubWorkflowRun["conclusion"],
) {
  return {
    ...run(status, conclusion),
    id: 9,
    name: "Deploy app to VPS",
    branch: "main",
    path: ".github/workflows/deploy-prod.yml",
  } satisfies GitHubWorkflowRun;
}

/** TASK-1231: the watcher, with a mutable run list and a controllable clock. */
function watcher(runs: GitHubWorkflowRun[], released: string[] = []) {
  let nowMs = Date.parse("2026-10-08T00:00:00Z");
  let lookups = 0;
  const inputs: { branch: string; workflow?: string; event?: string }[] = [];
  const github = {
    async findPullRequest() {
      return undefined;
    },
    async openPullRequest() {
      throw new Error("unused");
    },
    async mergePullRequest() {
      throw new Error("unused");
    },
    // Mirrors GitHub: asking for one workflow answers with that workflow's runs
    // only. Fixtures without a `path` stand in for "the API said nothing".
    async listWorkflowRuns(input: { branch: string; workflow?: string; event?: string }) {
      lookups += 1;
      inputs.push(input);
      return runs.filter(
        (candidate) =>
          (!input.workflow ||
            !candidate.path ||
            candidate.path === `.github/workflows/${input.workflow}`) &&
          (!input.event || !candidate.event || candidate.event === input.event),
      );
    },
  } as unknown as GitHubClient;
  const service = new DeployService({
    deliveries: {
      async load(deliveryId) {
        return {
          delivery: { id: deliveryId } as never,
          tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never],
        };
      },
    },
    repositories: { async findRepository() { return repository; } },
    runs: { async listRuns() { return []; } },
    git: { async publish() { return { pushed: true }; } },
    github,
    release: {
      async release(deliveryId) {
        released.push(deliveryId);
      },
    },
    events: new InMemoryEventStore(),
    watchIntervalMs: 30_000,
    watchTtlMs: 30 * 60_000,
    now: () => new Date(nowMs),
  });
  return {
    service,
    advance: (ms: number) => {
      nowMs += ms;
    },
    lookups: () => lookups,
    inputs: () => inputs,
    setRuns: (next: GitHubWorkflowRun[]) => {
      runs.length = 0;
      runs.push(...next);
    },
  };
}

describe("deployment watching (TASK-1231)", () => {
  it("reports only changes, and stops after a terminal state", async () => {
    const w = watcher([run("in_progress")]);
    w.service.watch("dlv-1");

    expect(await w.service.poll()).toEqual([
      { deliveryId: "dlv-1", state: "pending", kind: "test", run: run("in_progress"), terminal: false },
    ]);

    w.advance(30_000);
    w.setRuns([run("completed", "success")]);
    const done = await w.service.poll();
    expect(done.map((t) => t.state)).toEqual(["succeeded"]);
    expect(done[0]!.terminal).toBe(true);
    expect(w.service.watched()).toEqual([]);

    // Terminal: no further lookups even if time passes.
    w.advance(60_000);
    expect(await w.service.poll()).toEqual([]);
    expect(w.lookups()).toBe(2);
  });

  it("does not poll before the interval elapses", async () => {
    const w = watcher([run("in_progress")]);
    w.service.watch("dlv-1");
    await w.service.poll(); // first check happens immediately
    w.advance(5_000);
    expect(await w.service.poll()).toEqual([]); // too soon
    expect(w.lookups()).toBe(1);
    w.advance(30_000);
    await w.service.poll();
    expect(w.lookups()).toBe(2);
  });

  it("gives up on a deployment that never finishes", async () => {
    const w = watcher([run("queued")]);
    w.service.watch("dlv-1");
    await w.service.poll();
    w.advance(31 * 60_000);
    const stale = await w.service.poll();
    expect(stale).toEqual([{ deliveryId: "dlv-1", state: "stale", kind: "test", terminal: true }]);
    expect(w.service.watched()).toEqual([]);
  });

  it("keeps watching when a lookup fails", async () => {
    const service = new DeployService({
      deliveries: { async load(id) { return { delivery: { id } as never, tasks: [{ id: "t", repositoryId: "repo-x-music" } as never] }; } },
      repositories: { async findRepository() { return repository; } },
      runs: { async listRuns() { return []; } },
      git: { async publish() { return { pushed: true }; } },
      github: {
        async listWorkflowRuns() {
          throw new Error("network");
        },
      } as unknown as GitHubClient,
      events: new InMemoryEventStore(),
    });
    service.watch("dlv-1");
    expect(await service.poll()).toEqual([]);
    expect(service.watched()).toEqual(["dlv-1"]);
  });

  // TASK-1255: the production deploy succeeding is what makes a delivery
  // RELEASED — the PR merge alone must not (a failed deploy would freeze it).
  it("records the release when the production deploy succeeds", async () => {
    const released: string[] = [];
    const w = watcher([prodRun("completed", "success")], released);
    w.service.watch("dlv-1", { branch: "main", kind: "production" });

    const transitions = await w.service.poll();

    expect(transitions).toEqual([
      {
        deliveryId: "dlv-1",
        state: "succeeded",
        kind: "production",
        run: prodRun("completed", "success"),
        terminal: true,
      },
    ]);
    expect(released).toEqual(["dlv-1"]);
  });

  it("does not release a delivery when only its test deploy succeeded", async () => {
    const released: string[] = [];
    const w = watcher([run("completed", "success")], released);
    w.service.watch("dlv-1");

    await w.service.poll();

    expect(released).toEqual([]);
  });

  it("does not release a delivery whose production deploy failed", async () => {
    const released: string[] = [];
    const w = watcher([prodRun("completed", "failure")], released);
    w.service.watch("dlv-1", { branch: "main", kind: "production" });

    await w.service.poll();

    expect(released).toEqual([]);
  });

  // TASK-1268 现场事故：一次 push 在 test/<deliveryId> 上并发触发三条 run，
  // 其中 Documentation checks 11 秒就 success。旧的"取分支上最新一条"把它当成
  // 了部署结果，于是飞书发"测试环境就绪"，而真正的部署还在 docker build。
  it("never reports success from another workflow on the same branch", async () => {
    const deploy = run("in_progress");
    const checks: GitHubWorkflowRun = {
      ...run("completed", "success"),
      id: 2,
      name: "Documentation checks",
      path: ".github/workflows/docs.yml",
      event: "pull_request",
    };
    const w = watcher([checks, deploy]);
    w.service.watch("dlv-1");

    const first = await w.service.poll();

    expect(first.map((t) => t.state)).toEqual(["pending"]);
    // The lookup is scoped to the conventional workflow, for a push.
    expect(w.inputs()[0]?.workflow).toBe("deploy-test.yml");
    expect(w.inputs()[0]?.event).toBe("push");

    w.advance(30_000);
    w.setRuns([checks, { ...deploy, status: "completed", conclusion: "success" }]);
    const second = await w.service.poll();

    expect(second.map((t) => t.state)).toEqual(["succeeded"]);
    expect(second[0]?.run?.name).toBe("deploy-test");
  });

  it("does not release a delivery from a checks workflow on the default branch", async () => {
    const released: string[] = [];
    const checks: GitHubWorkflowRun = {
      ...run("completed", "success"),
      name: "Documentation checks",
      branch: "main",
      path: ".github/workflows/docs.yml",
    };
    const deploy: GitHubWorkflowRun = {
      ...run("in_progress"),
      id: 3,
      name: "Deploy app to prod",
      branch: "main",
      path: ".github/workflows/deploy-prod.yml",
    };
    const w = watcher([checks, deploy], released);
    w.service.watch("dlv-1", { branch: "main", kind: "production" });

    const transitions = await w.service.poll();

    expect(transitions.map((t) => t.state)).toEqual(["pending"]);
    expect(w.inputs()[0]?.workflow).toBe("deploy-prod.yml");
    expect(released).toEqual([]);
  });

  // 仓库改名/删掉部署工作流之后：查不到就是查不到，不能退回去猜别的 run。
  it("reports unconfigured, and never success, when the deploy workflow is gone", async () => {
    const released: string[] = [];
    const service = new DeployService({
      deliveries: {
        async load(id) {
          return { delivery: { id } as never, tasks: [{ id: "t", repositoryId: "repo-x-music" } as never] };
        },
      },
      repositories: { async findRepository() { return repository; } },
      runs: { async listRuns() { return []; } },
      git: { async publish() { return { pushed: true }; } },
      github: {
        async listWorkflowRuns() {
          throw new GitHubRequestError(404, "GitHub GET … → 404 Not Found");
        },
      } as unknown as GitHubClient,
      release: {
        async release(deliveryId) {
          released.push(deliveryId);
        },
      },
      events: new InMemoryEventStore(),
    });
    service.watch("dlv-1", { branch: "main", kind: "production" });

    expect(await service.poll()).toEqual([
      { deliveryId: "dlv-1", state: "unconfigured", kind: "production", terminal: false },
    ]);
    expect(released).toEqual([]);
    // Not terminal: fixing the repository lets the same watch recover.
    expect(service.watched()).toEqual(["dlv-1"]);
  });

  // TASK-1270 现场事故（dlv-3ee9ed0da9）：run 与 watch 起点落在同一秒，而
  // GitHub 的 createdAt 只有秒精度——`createdAt >= sinceMs` 每次都把它排除，
  // 监听第一跳就报 none，撑到 30 分钟 TTL 才发"部署超时"。commit sha 才是
  // 这次 watch 的身份，时间守卫不能先把它否掉。
  it("matches a run from the same second when the commit pins it", async () => {
    const sha = "5116fb80c5850a978ea4d23c5d0dc105e26da299";
    const w = watcher([{ ...run("in_progress"), headSha: sha }]);
    w.advance(180); // the watch starts 180ms into the run's (second-truncated) second
    w.service.watch("dlv-1", { headSha: sha });

    const transitions = await w.service.poll();

    expect(transitions.map((t) => t.state)).toEqual(["pending"]);
  });

  // TASK-1231 的语义仍然保留：没有 commit 可对齐时，早于 watch 的 run 不算数
  // （否则重新部署会拿上一次的结论当本次结果）。
  it("still ignores a run older than the watch when no commit is known", async () => {
    const w = watcher([run("in_progress")]);
    w.advance(5_000);
    w.service.watch("dlv-1");

    // The old run is not this watch's run: report "none", never its result.
    const transitions = await w.service.poll();
    expect(transitions.map((t) => t.state)).toEqual(["none"]);
  });

  // TASK-1270: push 与 watch 之间还隔着建 PR 的往返。sinceMs 必须取 push 之前，
  // 否则 run（createdAt 秒精度）看起来比 watch 还早，同样会被永久过滤。
  it("counts a run created between the push and the later watch start", async () => {
    let nowMs = Date.parse("2026-10-10T05:53:46Z");
    const service = new DeployService({
      deliveries: {
        async load(id) {
          return {
            delivery: { id, status: "IN_PROGRESS" } as never,
            tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never],
          };
        },
      },
      repositories: { async findRepository() { return repository; } },
      runs: {
        async listRuns() {
          return [
            {
              id: "run-1",
              taskId: "task-1",
              status: "SUCCEEDED",
              result: {
                workspaces: [
                  { targetId: "task-1-target-0", path: "/root/ai-workspaces/task-1/run-1/t0" },
                ],
              },
            } as never,
          ];
        },
      },
      git: {
        async publish() {
          nowMs += 1_400; // push + the PR round-trip that used to eat the run
          return { pushed: true };
        },
      },
      github: {
        async findPullRequest() {
          return undefined;
        },
        async openPullRequest(input: { head: string; base: string }) {
          return {
            number: 7,
            url: "https://github.com/i12n/x-music/pull/7",
            state: "open",
            merged: false,
            head: input.head,
            base: input.base,
          };
        },
        async listWorkflows() {
          return [
            {
              id: 1,
              name: "Deploy app to test environment",
              path: ".github/workflows/deploy-test.yml",
              state: "active",
            },
          ];
        },
        async listWorkflowRuns() {
          return [
            {
              id: 1,
              name: "Deploy app to test environment",
              branch: "test/dlv-1",
              status: "in_progress",
              url: "https://github.com/i12n/x-music/actions/runs/1",
              createdAt: "2026-10-10T05:53:47Z", // created 1s into a 1.4s round-trip
              path: ".github/workflows/deploy-test.yml",
              event: "push",
            },
          ];
        },
      } as unknown as GitHubClient,
      events: new InMemoryEventStore(),
      now: () => new Date(nowMs),
    });

    await service.deployTest("dlv-1");
    // The watch starts *after* the run was created — that is the trap.
    expect(nowMs).toBeGreaterThan(Date.parse("2026-10-10T05:53:47Z"));

    const transitions = await service.poll();
    expect(transitions.map((t) => t.state)).toEqual(["pending"]);
  });

  // TASK-1272: watches live in memory, so a restart used to drop every in-flight
  // deployment silently (no terminal card, ever). Startup re-derives the
  // unfinished ones from the event log.
  it("resumes an unfinished test watch after a restart", async () => {
    const events = new InMemoryEventStore();
    await events.record({
      type: "TestBranchPushed",
      payload: { deliveryId: "dlv-1", branch: "test/dlv-1", headSha: "abc123" },
    });
    const service = new DeployService({
      deliveries: {
        async load(id) {
          return { delivery: { id } as never, tasks: [{ id: "t", repositoryId: "repo-x-music" } as never] };
        },
      },
      repositories: { async findRepository() { return repository; } },
      runs: { async listRuns() { return []; } },
      git: { async publish() { return { pushed: true }; } },
      github: {
        async listWorkflowRuns() {
          return [{ ...run("completed", "success"), headSha: "abc123" }];
        },
      } as unknown as GitHubClient,
      events,
    });

    expect(service.watched()).toEqual([]);
    expect(await service.restore()).toBe(1);
    expect(service.watched()).toEqual(["dlv-1"]);

    const transitions = await service.poll();
    expect(transitions.map((t) => [t.state, t.kind])).toEqual([["succeeded", "test"]]);
  });

  it("does not resume a deployment whose terminal state was already recorded", async () => {
    const events = new InMemoryEventStore();
    await events.record({
      type: "TestBranchPushed",
      payload: { deliveryId: "dlv-1", branch: "test/dlv-1", headSha: "abc123" },
    });
    await events.record({
      type: "TestDeploySucceeded",
      payload: { deliveryId: "dlv-1", state: "succeeded" },
    });
    const service = new DeployService({
      deliveries: {
        async load(id) {
          return { delivery: { id } as never, tasks: [{ id: "t", repositoryId: "repo-x-music" } as never] };
        },
      },
      repositories: { async findRepository() { return repository; } },
      runs: { async listRuns() { return []; } },
      git: { async publish() { return { pushed: true }; } },
      github: { async listWorkflowRuns() { return []; } } as unknown as GitHubClient,
      events,
    });

    expect(await service.restore()).toBe(0);
    expect(service.watched()).toEqual([]);
  });

  it("resumes a production watch from the merge commit and confirms the release", async () => {
    const events = new InMemoryEventStore();
    await events.record({
      type: "TestMerged",
      payload: {
        deliveryId: "dlv-1",
        mergeCommitSha: "merge1",
        mergedAt: "2026-10-10T00:00:00Z",
      },
    });
    const released: string[] = [];
    const service = new DeployService({
      deliveries: {
        async load(id) {
          return { delivery: { id } as never, tasks: [{ id: "t", repositoryId: "repo-x-music" } as never] };
        },
      },
      repositories: { async findRepository() { return repository; } },
      runs: { async listRuns() { return []; } },
      git: { async publish() { return { pushed: true }; } },
      github: {
        async listWorkflowRuns() {
          return [{ ...prodRun("completed", "success"), headSha: "merge1" }];
        },
      } as unknown as GitHubClient,
      release: {
        async release(deliveryId) {
          released.push(deliveryId);
        },
      },
      events,
    });

    expect(await service.restore()).toBe(1);
    const transitions = await service.poll();
    expect(transitions.map((t) => [t.state, t.kind])).toEqual([["succeeded", "production"]]);
    expect(released).toEqual(["dlv-1"]);
  });
});
