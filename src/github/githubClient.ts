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
  /**
   * TASK-1255: when the PR was merged. A production run only counts as the
   * evidence for *this* merge when it was created at/after this moment, so a
   * merge without a timestamp cannot be attributed to a run.
   */
  mergedAt?: string;
  /**
   * TASK-1268: the commit the merge produced on the base branch. The production
   * workflow runs for exactly this commit, which lets the watcher ignore a
   * concurrent push to `main`.
   */
  mergeCommitSha?: string;
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
  /**
   * TASK-1268: the workflow file this run belongs to (`.github/workflows/x.yml`).
   * The run list is scoped by workflow, so this is the proof that the run we
   * picked really is the deployment.
   */
  path?: string;
  /** `push`, `pull_request`, … — the deploy convention requires `push`. */
  event?: string;
  /** The commit the run was created for; pins a run to *this* delivery. */
  headSha?: string;
}

/** TASK-1268: one entry of `GET /repos/{repo}/actions/workflows`. */
export interface GitHubWorkflow {
  id: number;
  name: string;
  /** Repository-relative path, e.g. `.github/workflows/deploy-test.yml`. */
  path: string;
  /** `active`, `disabled_manually`, … */
  state: string;
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
  /**
   * Most recent runs for a branch, newest first.
   *
   * TASK-1268: pass `workflow` (a file name like `deploy-test.yml`, or a numeric
   * id) to scope the answer to *that* workflow — without it the list mixes in
   * every other workflow a push triggers. Throws `GitHubRequestError` with
   * status 404 when the named workflow does not exist.
   */
  listWorkflowRuns(input: {
    repo: string;
    branch: string;
    limit?: number;
    workflow?: string;
    event?: string;
  }): Promise<GitHubWorkflowRun[]>;
  /** Every workflow the repository declares (disabled files are not listed). */
  listWorkflows(input: { repo: string }): Promise<GitHubWorkflow[]>;
  /**
   * Raw text of a file, or `undefined` when the path does not exist. Used by the
   * onboarding gate to read the deploy workflows' triggers.
   */
  readFile(input: { repo: string; path: string; ref?: string }): Promise<string | undefined>;
}

/** `owner/name` from a git remote URL, or `undefined` when it is not GitHub. */
export function githubSlugFromUrl(url: string): string | undefined {
  const match = /github\.com[:/]([^/]+\/[^/.]+?)(\.git)?\/?$/.exec(url.trim());
  return match?.[1];
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
