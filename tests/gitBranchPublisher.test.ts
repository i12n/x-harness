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
    // The delivery delta (vs the default branch) must report work, or the
    // publisher stops early.
      if (args.includes("merge-base")) return "base123\n";
      return args.includes("diff") ? "diff --git a/app/page.tsx b/app/page.tsx\n" : "";
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
      .map((call) => call.args.find((arg) => ["fetch", "worktree", "apply", "commit", "push"].includes(arg)))
      .filter(Boolean);
    expect(verbs).toContain("fetch");
    expect(verbs).toContain("worktree");
    expect(verbs).toContain("apply");
    // The throwaway worktree is removed again after the push.
    expect(verbs.at(-1)).toBe("worktree");
    expect(calls.some((call) => call.args.includes("commit"))).toBe(true);
    expect(calls.every((call) => call.args.some((arg) => arg.startsWith("safe.directory=")))).toBe(true);
    // The test branch is cut from the repository's default branch in a throwaway
    // worktree — the deploy workflow lives there, and the Run's own workspace
    // (with its already-published ai/… commit) is never rewritten.
    const worktreeAdd = calls.find((call) => call.args.includes("worktree"))!;
    expect(worktreeAdd.args).toContain("origin/main");
    // The delta is measured from the run's fork point, not the remote tip —
    // diffing against a moved-on `main` would make the patch revert it.
    const diff = calls.find((call) => call.args.includes("diff"))!;
    expect(diff.args).toContain("base123");
    expect(diff.args).not.toContain("origin/main");
    expect(calls.some((call) => call.args.includes("checkout"))).toBe(false);
    const push = calls.filter((call) => call.args.includes("push")).at(-1)!;
    expect(push.args.join(" ")).toContain("@github.com/i12n/x-music.git");
    expect(push.args.join(" ")).toContain("HEAD:refs/heads/test/dlv-1");
    // The scratch worktree has no local ref for a lease, and the branch is a
    // derived artefact, so the rebuild pushes with plain --force.
    expect(push.args).toContain("--force");
    expect(push.args.join(" ")).toContain("x-access-token:ghs_token@");
  });

  it("treats an already-published delivery as a no-op, not an error", async () => {
    const calls: string[][] = [];
    const service = new GitBranchPublisher({
      tokenProvider: new StaticTokenProvider("ghs_token"),
      exec: async (args) => {
        calls.push(args);
        if (args.includes("status")) return ""; // clean tree
        if (args.includes("ls-remote")) return "abc123\trefs/heads/test/dlv-1\n";
        return "";
      },
    });
    const outcome = await service.publish(request("test/dlv-1"));
    expect(outcome.pushed).toBe(true);
    // Nothing was committed or pushed again.
    expect(calls.some((args) => args.includes("commit"))).toBe(false);
    expect(calls.some((args) => args.includes("push"))).toBe(false);
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
        return args.includes("diff") ? "diff --git a/app/page.tsx b/app/page.tsx\n" : "";
      },
    });
    const outcome = await service.publish(request("test/dlv-1"));
    expect(outcome.pushed).toBe(false);
    expect(outcome.reason).toContain("Permission denied");
  });
});
