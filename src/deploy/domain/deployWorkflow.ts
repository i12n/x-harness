import { parse } from "yaml";

/**
 * TASK-1268: the deploy-workflow naming convention.
 *
 * The harness never deploys anything — it only *observes* the repository's own
 * GitHub Actions. That makes "which workflow is the deployment" a fact the
 * harness must know rather than infer: reading every run on the branch and
 * taking the newest one (the old behaviour) picked whichever workflow finished
 * first. A push to `test/…` also triggers the repository's PR checks, and
 * "Documentation checks" finishes in seconds — so a delivery was reported ready
 * while the real deploy was still building.
 *
 * So the convention is part of onboarding: a repository that does not declare
 * these two workflows is refused by the CLI (`deployWorkflowGate.ts`), and the
 * watcher only ever reads runs of these workflows.
 */
export const DEPLOY_TEST_WORKFLOW = "deploy-test.yml";
export const DEPLOY_PROD_WORKFLOW = "deploy-prod.yml";

export const DEPLOY_WORKFLOW_DIR = ".github/workflows";

/** Repository-relative path of a workflow file. */
export function deployWorkflowPath(file: string): string {
  return `${DEPLOY_WORKFLOW_DIR}/${file}`;
}

export interface WorkflowTriggerRequirement {
  /** Workflow file name, e.g. `deploy-test.yml`. */
  file: string;
  /** A branch the workflow must be able to run on, e.g. `test/dlv-sample`. */
  sampleBranch: string;
  /** Human phrase for the failure message, e.g. `push 到 test/**`. */
  expectation: string;
}

/**
 * Why this workflow's triggers do not cover the branch the harness will push,
 * or `undefined` when they do. Deliberately lenient: `on: push` without a
 * branch filter is accepted, and only a trigger set that provably cannot run
 * for the sample branch is refused.
 */
export function workflowTriggerIssue(
  yamlText: string,
  requirement: WorkflowTriggerRequirement,
): string | undefined {
  let document: unknown;
  try {
    document = parse(yamlText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${requirement.file} 不是合法的 YAML：${detail}`;
  }
  if (!isRecord(document)) {
    return `${requirement.file} 的内容不是 YAML 映射`;
  }
  const on = triggerSection(document);
  if (on === undefined) {
    return `${requirement.file} 没有 on: 触发配置`;
  }
  const push = pushSection(on);
  if (push === "absent") {
    return `${requirement.file} 没有 push 触发（需要 ${requirement.expectation}）`;
  }
  if (push === "any-branch") {
    return undefined;
  }
  if (push.ignoredBranches.length > 0) {
    return (
      `${requirement.file} 只用 branches-ignore 排除分支，无法确认覆盖 ` +
      `${requirement.sampleBranch}（需要 ${requirement.expectation}）；请改成显式的 branches`
    );
  }
  if (push.branches.some((pattern) => branchMatches(pattern, requirement.sampleBranch))) {
    return undefined;
  }
  const declared = push.branches.length > 0 ? push.branches.join(", ") : "（空）";
  return (
    `${requirement.file} 的 push 分支是 ${declared}，` +
    `不覆盖 ${requirement.sampleBranch}（需要 ${requirement.expectation}）`
  );
}

/**
 * The `on:` section. YAML 1.1 parses a bare `on` key as the boolean `true`, so
 * both spellings are accepted rather than trusting one parser version.
 */
function triggerSection(document: Record<string, unknown>): unknown {
  if ("on" in document) {
    return document.on;
  }
  return document["true"];
}

type PushSection = "absent" | "any-branch" | { branches: string[]; ignoredBranches: string[] };

function pushSection(on: unknown): PushSection {
  // `on: push` / `on: [push, workflow_dispatch]` — every branch.
  if (on === "push") {
    return "any-branch";
  }
  if (Array.isArray(on)) {
    return on.includes("push") ? "any-branch" : "absent";
  }
  if (!isRecord(on) || !("push" in on)) {
    return "absent";
  }
  const push = on.push;
  // `push:` with nothing under it means "every branch".
  if (push == null) {
    return "any-branch";
  }
  if (!isRecord(push)) {
    return "any-branch";
  }
  return {
    branches: stringList(push.branches),
    ignoredBranches: stringList(push["branches-ignore"]),
  };
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim());
  }
  return [];
}

/** GitHub branch filter semantics: `*` stops at `/`, `**` crosses it. */
export function branchMatches(pattern: string, branch: string): boolean {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`).test(branch);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
