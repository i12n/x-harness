import { HarnessError } from "../../errors.js";
import { githubSlugFromUrl, type GitHubClient, type GitHubWorkflow } from "../../github/githubClient.js";
import {
  DEPLOY_PROD_WORKFLOW,
  DEPLOY_TEST_WORKFLOW,
  deployWorkflowPath,
  workflowTriggerIssue,
  type WorkflowTriggerRequirement,
} from "../domain/deployWorkflow.js";

/**
 * TASK-1268: onboarding check for the deploy-workflow convention.
 *
 * The harness can only report a deployment if it knows which workflow *is* the
 * deployment. That is a property of the repository, so it is checked while a
 * human is registering it — a repository that does not declare
 * `deploy-test.yml` / `deploy-prod.yml` is refused, instead of failing later
 * with a card that never resolves.
 */
export interface DeployWorkflowIssue {
  code: string;
  message: string;
}

export interface DeployWorkflowGateInput {
  repositoryId: string;
  url: string;
  defaultBranch: string;
  github: GitHubClient;
}

export interface DeployWorkflowRequirements {
  test: WorkflowTriggerRequirement;
  production: WorkflowTriggerRequirement;
}

/** The sample branch stands in for `<deliveryId>`; only the glob shape matters. */
export function deployWorkflowRequirements(defaultBranch: string): DeployWorkflowRequirements {
  const base = defaultBranch.trim() || "main";
  return {
    test: {
      file: DEPLOY_TEST_WORKFLOW,
      sampleBranch: "test/dlv-sample",
      expectation: "push 到 test/**",
    },
    production: {
      file: DEPLOY_PROD_WORKFLOW,
      sampleBranch: base,
      expectation: `push 到 ${base}`,
    },
  };
}

/**
 * Every reason this repository cannot be onboarded, or an empty list. A remote
 * that is not GitHub at all is not checked: those repositories have no Actions
 * and no deployment for the harness to observe.
 */
export async function collectDeployWorkflowIssues(
  input: DeployWorkflowGateInput,
): Promise<DeployWorkflowIssue[]> {
  const repo = githubSlugFromUrl(input.url);
  if (!repo) {
    return [];
  }

  let workflows: GitHubWorkflow[];
  try {
    workflows = await input.github.listWorkflows({ repo });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      {
        code: "workflow_lookup_failed",
        message:
          `读不到 ${repo} 的 GitHub Actions 工作流：${detail}。` +
          "接入前必须能读到公开的 workflow 列表（检查 GitHub 凭据与该仓库的安装授权）。",
      },
    ];
  }

  const issues: DeployWorkflowIssue[] = [];
  const requirements = deployWorkflowRequirements(input.defaultBranch);
  for (const requirement of [requirements.test, requirements.production]) {
    const path = deployWorkflowPath(requirement.file);
    const declared = workflows.find((entry) => entry.path === path);
    if (!declared) {
      issues.push({
        code: "missing_deploy_workflow",
        message:
          `缺少 ${path}（需要 ${requirement.expectation}）。` +
          `现有工作流：${describeWorkflows(workflows)}。` +
          "按约定命名或新建该工作流后重新接入。",
      });
      continue;
    }
    if (declared.state !== "active") {
      issues.push({
        code: "inactive_deploy_workflow",
        message: `${path} 的状态是 ${declared.state}，不是 active——GitHub 不会为它创建 run。`,
      });
      continue;
    }
    let content: string | undefined;
    try {
      content = await input.github.readFile({
        repo,
        path,
        ref: input.defaultBranch.trim() || "main",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issues.push({ code: "workflow_unreadable", message: `读不到 ${path} 的内容：${detail}` });
      continue;
    }
    if (content === undefined) {
      issues.push({
        code: "workflow_unreadable",
        message: `${path} 在 ${input.defaultBranch} 上不存在（工作流列表与默认分支不一致？）。`,
      });
      continue;
    }
    const triggerIssue = workflowTriggerIssue(content, requirement);
    if (triggerIssue) {
      issues.push({ code: "workflow_trigger", message: triggerIssue });
    }
  }
  return issues;
}

/** Refuses onboarding. Mirrors the execution-profile gate's shape. */
export async function gateRepositoryDeployWorkflows(
  input: DeployWorkflowGateInput,
): Promise<void> {
  const issues = await collectDeployWorkflowIssues(input);
  if (issues.length === 0) {
    return;
  }
  throw new HarnessError(
    [
      `仓库 ${input.repositoryId} 不满足部署工作流约定，不能接入 harness：`,
      ...issues.map((issue) => `  · ${issue.message}`),
      "确认要接入可用 --skip-deploy-check 跳过，但 harness 将无法确认这个仓库的部署结果。",
    ].join("\n"),
  );
}

function describeWorkflows(workflows: GitHubWorkflow[]): string {
  if (workflows.length === 0) {
    return "（没有）";
  }
  return workflows.map((entry) => entry.path).join("、");
}
