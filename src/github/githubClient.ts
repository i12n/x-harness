/**
 * TASK-1230: the GitHub surface the harness needs.
 *
 * Deployment is owned by each repository's GitHub Actions
 * (docs/test-environment-deployment-plan.md). The harness only pushes a test
 * branch, opens/merges the pull request, and *observes* the runs — so this port
 * has no deploy, no secrets and no environment access.
 */

export interface GitHubPullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  head: string;
  base: string;
}

export type GitHubRunStatus = "queued" | "in_progress" | "completed";
/** GitHub's completed-run conclusions, plus "unknown" for future values. */
export type GitHubRunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "unknown";

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  branch: string;
  status: GitHubRunStatus;
  conclusion?: GitHubRunConclusion;
  url: string;
  createdAt: string;
}

export interface OpenPullRequestInput {
  /** `owner/name`. */
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface MergePullRequestInput {
  repo: string;
  number: number;
  /** Defaults to `squash`. */
  method?: "merge" | "squash" | "rebase";
}

export interface GitHubClient {
  findPullRequest(input: { repo: string; head: string; base: string }): Promise<GitHubPullRequest | undefined>;
  openPullRequest(input: OpenPullRequestInput): Promise<GitHubPullRequest>;
  mergePullRequest(input: MergePullRequestInput): Promise<GitHubPullRequest>;
  /** Most recent runs for a branch, newest first. */
  listWorkflowRuns(input: { repo: string; branch: string; limit?: number }): Promise<GitHubWorkflowRun[]>;
}

/** Normalizes any GitHub conclusion string into the closed set above. */
export function normalizeConclusion(value: string | null | undefined): GitHubRunConclusion | undefined {
  if (!value) {
    return undefined;
  }
  const known: GitHubRunConclusion[] = [
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "neutral",
  ];
  return (known as string[]).includes(value) ? (value as GitHubRunConclusion) : "unknown";
}
