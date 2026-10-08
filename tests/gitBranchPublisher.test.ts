import { describe, expect, it } from "vitest";
import { GitBranchPublisher } from "../src/deploy/infrastructure/gitBranchPublisher.js";
import { StaticTokenProvider } from "../src/github/tokenProvider.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import type { Repository } from "../src/domain/repository.js";

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

function publisher(options: { allowedPrefixes?: string[] } = {}) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const service = new GitBranchPublisher({
    tokenProvider: new StaticTokenProvider("ghs_token"),
    ...(options.allowedPrefixes ? { allowedPrefixes: options.allowedPrefixes } : {}),
    authorName: "AI Harness",
    authorEmail: "ai@example.com",
    exec: async (args, _cwd, env) => {
      calls.push({ args, env });
      // `status --porcelain` must report work, or the publisher stops early.
      return args.includes("status") ? " M app/page.tsx\n" : "";
    },
  });
  return { service, calls };
}

const request = (branch: string) => ({
  repository,
  workspacePath: "/root/ai-workspaces/task-1/run-1/t0",
  branch,
  message: "test: dlv-1",
});

describe("control-plane test-branch push (TASK-1230)", () => {
  it("cuts the branch, commits, and pushes it over HTTPS with the App token", async () => {
    const { service, calls } = publisher();
    const outcome = await service.publish(request("test/dlv-1"));

    expect(outcome.pushed).toBe(true);
    // Every git call carries `-c safe.directory=…` (worktrees are owned by the
    // container user, so git refuses to touch them as root otherwise).
    const verbs = calls
      .map((call) => call.args.find((arg) => ["fetch", "stash", "checkout", "push"].includes(arg)))
      .filter(Boolean);
    expect(verbs).toContain("fetch");
    expect(verbs).toContain("checkout");
    expect(verbs.at(-1)).toBe("push");
    expect(calls.some((call) => call.args.includes("commit"))).toBe(true);
    expect(calls.every((call) => call.args.some((arg) => arg.startsWith("safe.directory=")))).toBe(true);
    // The test branch is cut from the repository's default branch, not from the
    // Run's leftover HEAD — otherwise the deploy workflow would not be present.
    const checkout = calls.find((call) => call.args.includes("checkout"))!;
    expect(checkout.args).toContain("origin/main");
    const push = calls.at(-1)!;
    expect(push.args.join(" ")).toContain("@github.com/i12n/x-music.git");
    expect(push.args.join(" ")).toContain("HEAD:test/dlv-1");
    expect(push.args.join(" ")).toContain("x-access-token:ghs_token@");
  });

  it("never pushes the default branch", async () => {
    const { service, calls } = publisher({ allowedPrefixes: ["main"] });
    const outcome = await service.publish(request("main"));
    expect(outcome.pushed).toBe(false);
    expect(outcome.reason).toContain("默认分支");
    expect(calls).toHaveLength(0);
  });

  it("refuses branches outside the whitelisted prefixes", async () => {
    const { service, calls } = publisher({ allowedPrefixes: ["test/"] });
    const outcome = await service.publish(request("feature/x"));
    expect(outcome.pushed).toBe(false);
    expect(outcome.reason).toContain("前缀");
    expect(calls).toHaveLength(0);
  });

  it("reports a failed push instead of pretending it worked", async () => {
    const service = new GitBranchPublisher({
      tokenProvider: new StaticTokenProvider("ghs_token"),
      exec: async (args) => {
        if (args.includes("push")) {
          throw new Error("remote: Permission denied");
        }
        return args.includes("status") ? " M app/page.tsx\n" : "";
      },
    });
    const outcome = await service.publish(request("test/dlv-1"));
    expect(outcome.pushed).toBe(false);
    expect(outcome.reason).toContain("Permission denied");
  });
});
