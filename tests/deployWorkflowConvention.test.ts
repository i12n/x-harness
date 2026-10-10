import { describe, expect, it } from "vitest";
import {
  branchMatches,
  deployWorkflowPath,
  workflowTriggerIssue,
} from "../src/deploy/domain/deployWorkflow.js";
import {
  collectDeployWorkflowIssues,
  gateRepositoryDeployWorkflows,
} from "../src/deploy/application/deployWorkflowGate.js";
import type { GitHubClient, GitHubWorkflow } from "../src/github/githubClient.js";

const TEST_PATH = deployWorkflowPath("deploy-test.yml");
const PROD_PATH = deployWorkflowPath("deploy-prod.yml");

const TEST_YAML = [
  "name: Deploy app to test environment",
  "on:",
  "  push:",
  '    branches: ["test/**"]',
  "  workflow_dispatch:",
  "jobs: {}",
  "",
].join("\n");

const PROD_YAML = [
  "name: Deploy app to VPS",
  "on:",
  "  push:",
  "    branches: [main]",
  "jobs: {}",
  "",
].join("\n");

function fakeGithub(
  options: {
    workflows?: GitHubWorkflow[];
    files?: Record<string, string | undefined>;
    listError?: Error;
  } = {},
): GitHubClient {
  const workflows = options.workflows ?? [
    { id: 1, name: "Deploy app to test environment", path: TEST_PATH, state: "active" },
    { id: 2, name: "Deploy app to VPS", path: PROD_PATH, state: "active" },
    { id: 3, name: "Documentation checks", path: ".github/workflows/docs.yml", state: "active" },
  ];
  const files = options.files ?? { [TEST_PATH]: TEST_YAML, [PROD_PATH]: PROD_YAML };
  return {
    async listWorkflows() {
      if (options.listError) {
        throw options.listError;
      }
      return workflows;
    },
    async readFile(input: { path: string }) {
      return files[input.path];
    },
  } as unknown as GitHubClient;
}

const githubRepo = {
  repositoryId: "repo-x-music",
  url: "git@github.com:i12n/x-music.git",
  defaultBranch: "main",
};

describe("deploy workflow convention (TASK-1268)", () => {
  it("matches branches the way GitHub does: ** crosses /, * does not", () => {
    expect(branchMatches("test/**", "test/dlv-9121521df0")).toBe(true);
    expect(branchMatches("test/*", "test/dlv-9121521df0")).toBe(true);
    expect(branchMatches("test/*", "test/a/b")).toBe(false);
    expect(branchMatches("**", "anything/at/all")).toBe(true);
    expect(branchMatches("main", "main")).toBe(true);
    expect(branchMatches("main", "maintenance")).toBe(false);
  });

  it("accepts a push trigger that covers the branch the harness pushes to", () => {
    expect(
      workflowTriggerIssue(TEST_YAML, {
        file: "deploy-test.yml",
        sampleBranch: "test/dlv-sample",
        expectation: "push 到 test/**",
      }),
    ).toBeUndefined();
    expect(
      workflowTriggerIssue(PROD_YAML, {
        file: "deploy-prod.yml",
        sampleBranch: "main",
        expectation: "push 到 main",
      }),
    ).toBeUndefined();
  });

  it("accepts an unfiltered `on: push`, since it covers every branch", () => {
    expect(
      workflowTriggerIssue("on: push\n", {
        file: "deploy-test.yml",
        sampleBranch: "test/dlv-sample",
        expectation: "push 到 test/**",
      }),
    ).toBeUndefined();
    expect(
      workflowTriggerIssue("on: [push, workflow_dispatch]\n", {
        file: "deploy-test.yml",
        sampleBranch: "test/dlv-sample",
        expectation: "push 到 test/**",
      }),
    ).toBeUndefined();
  });

  it("refuses a trigger that cannot run for the harness's branch", () => {
    const wrongBranch = workflowTriggerIssue(PROD_YAML, {
      file: "deploy-test.yml",
      sampleBranch: "test/dlv-sample",
      expectation: "push 到 test/**",
    });
    expect(wrongBranch).toMatch(/不覆盖 test\/dlv-sample/);

    const pullRequestOnly = workflowTriggerIssue("on: pull_request\n", {
      file: "deploy-prod.yml",
      sampleBranch: "main",
      expectation: "push 到 main",
    });
    expect(pullRequestOnly).toMatch(/没有 push 触发/);

    const branchesIgnore = workflowTriggerIssue(
      "on:\n  push:\n    branches-ignore: [main]\n",
      { file: "deploy-prod.yml", sampleBranch: "main", expectation: "push 到 main" },
    );
    expect(branchesIgnore).toMatch(/branches-ignore/);
  });

  it("reports unparseable YAML instead of guessing", () => {
    const issue = workflowTriggerIssue("on: [push\n", {
      file: "deploy-test.yml",
      sampleBranch: "test/dlv-sample",
      expectation: "push 到 test/**",
    });
    expect(issue).toMatch(/不是合法的 YAML/);
  });
});

describe("onboarding gate (TASK-1268)", () => {
  it("accepts a repository that declares both workflows", async () => {
    const issues = await collectDeployWorkflowIssues({
      ...githubRepo,
      github: fakeGithub(),
    });
    expect(issues).toEqual([]);
    await expect(
      gateRepositoryDeployWorkflows({ ...githubRepo, github: fakeGithub() }),
    ).resolves.toBeUndefined();
  });

  it("refuses a repository without deploy-prod.yml, naming what it found", async () => {
    const github = fakeGithub({
      workflows: [
        { id: 1, name: "Deploy app to test environment", path: TEST_PATH, state: "active" },
        { id: 2, name: "Deploy app to VPS", path: ".github/workflows/deploy-vps.yml", state: "active" },
        { id: 3, name: "Documentation checks", path: ".github/workflows/docs.yml", state: "active" },
      ],
    });

    const issues = await collectDeployWorkflowIssues({ ...githubRepo, github });

    expect(issues.map((issue) => issue.code)).toEqual(["missing_deploy_workflow"]);
    expect(issues[0]!.message).toContain(PROD_PATH);
    expect(issues[0]!.message).toContain(".github/workflows/deploy-vps.yml");
    await expect(gateRepositoryDeployWorkflows({ ...githubRepo, github })).rejects.toThrow(
      /不满足部署工作流约定/,
    );
    await expect(gateRepositoryDeployWorkflows({ ...githubRepo, github })).rejects.toThrow(
      /--skip-deploy-check/,
    );
  });

  it("refuses a disabled workflow and a trigger that cannot run", async () => {
    const disabled = fakeGithub({
      workflows: [
        { id: 1, name: "Deploy app to test environment", path: TEST_PATH, state: "disabled_manually" },
        { id: 2, name: "Deploy app to VPS", path: PROD_PATH, state: "active" },
      ],
    });
    expect(
      (await collectDeployWorkflowIssues({ ...githubRepo, github: disabled })).map((i) => i.code),
    ).toEqual(["inactive_deploy_workflow"]);

    const wrongTrigger = fakeGithub({
      files: {
        [TEST_PATH]: TEST_YAML,
        [PROD_PATH]: "on:\n  push:\n    branches: [release]\n",
      },
    });
    const issues = await collectDeployWorkflowIssues({ ...githubRepo, github: wrongTrigger });
    expect(issues.map((issue) => issue.code)).toEqual(["workflow_trigger"]);
  });

  it("refuses when the workflows cannot be read at all", async () => {
    const issues = await collectDeployWorkflowIssues({
      ...githubRepo,
      github: fakeGithub({ listError: new Error("GitHub GET … → 403 Forbidden") }),
    });
    expect(issues.map((issue) => issue.code)).toEqual(["workflow_lookup_failed"]);
    expect(issues[0]!.message).toMatch(/403/);
  });

  it("skips the check for a repository that is not on GitHub", async () => {
    let looked = false;
    const github = {
      async listWorkflows() {
        looked = true;
        return [];
      },
    } as unknown as GitHubClient;

    const issues = await collectDeployWorkflowIssues({
      repositoryId: "repo-demo",
      url: "file:///srv/repos/demo-origin.git",
      defaultBranch: "main",
      github,
    });

    expect(issues).toEqual([]);
    expect(looked).toBe(false);
  });
});
