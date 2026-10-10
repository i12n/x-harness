import {
  normalizeConclusion,
  type GitHubWorkflow,
  type GitHubClient,
  type GitHubPullRequest,
  type GitHubWorkflowRun,
  type MergePullRequestInput,
  type OpenPullRequestInput,
} from "./githubClient.js";
import { GitHubRequestError } from "../errors.js";
import { StaticTokenProvider, type GitHubTokenProvider } from "./tokenProvider.js";

export interface HttpGitHubClientOptions {
  /** How to authenticate: a GitHub App (recommended) or a PAT. */
  tokenProvider: GitHubTokenProvider;
  /** Override for GitHub Enterprise; defaults to api.github.com. */
  apiBase?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * REST implementation of `GitHubClient`. Deliberately thin: one JSON call per
 * method, no caching, no retries — the loop is the retry mechanism.
 */
export class HttpGitHubClient implements GitHubClient {
  private readonly tokenProvider: GitHubTokenProvider;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpGitHubClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Convenience for a plain token; the App path passes a provider instead. */
  static withToken(token: string, options: Omit<HttpGitHubClientOptions, "tokenProvider"> = {}) {
    return new HttpGitHubClient({ ...options, tokenProvider: new StaticTokenProvider(token) });
  }

  async findPullRequest(input: {
    repo: string;
    head: string;
    base: string;
  }): Promise<GitHubPullRequest | undefined> {
    const owner = input.repo.split("/")[0];
    const query = new URLSearchParams({
      head: `${owner}:${input.head}`,
      base: input.base,
      state: "all",
    });
    const rows = await this.request<unknown[]>(
      "GET",
      `/repos/${input.repo}/pulls?${query.toString()}`,
    );
    const first = Array.isArray(rows) ? rows[0] : undefined;
    return first ? toPullRequest(first) : undefined;
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<GitHubPullRequest> {
    const row = await this.request<unknown>("POST", `/repos/${input.repo}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
    });
    return toPullRequest(row);
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<GitHubPullRequest> {
    await this.request<unknown>("PUT", `/repos/${input.repo}/pulls/${input.number}/merge`, {
      merge_method: input.method ?? "squash",
    });
    const row = await this.request<unknown>("GET", `/repos/${input.repo}/pulls/${input.number}`);
    return toPullRequest(row);
  }

  async listWorkflowRuns(input: {
    repo: string;
    branch: string;
    limit?: number;
    workflow?: string;
    event?: string;
  }): Promise<GitHubWorkflowRun[]> {
    const query = new URLSearchParams({
      branch: input.branch,
      per_page: String(input.limit ?? 10),
    });
    if (input.event) {
      query.set("event", input.event);
    }
    // TASK-1268: scoping to one workflow is what makes the answer mean "the
    // deployment", instead of "whichever workflow on this branch finished first".
    const path = input.workflow
      ? `/repos/${input.repo}/actions/workflows/${encodeURIComponent(input.workflow)}/runs`
      : `/repos/${input.repo}/actions/runs`;
    const body = await this.request<{ workflow_runs?: unknown[] }>(
      "GET",
      `${path}?${query.toString()}`,
    );
    const rows = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    return rows.map(toRun);
  }

  async listWorkflows(input: { repo: string }): Promise<GitHubWorkflow[]> {
    const body = await this.request<{ workflows?: unknown[] }>(
      "GET",
      `/repos/${input.repo}/actions/workflows?per_page=100`,
    );
    const rows = Array.isArray(body?.workflows) ? body.workflows : [];
    return rows.map((row) => {
      const record = (row ?? {}) as Record<string, unknown>;
      return {
        id: Number(record.id ?? 0),
        name: String(record.name ?? ""),
        path: String(record.path ?? ""),
        state: String(record.state ?? ""),
      };
    });
  }

  async readFile(input: { repo: string; path: string; ref?: string }): Promise<string | undefined> {
    const query = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
    let body: unknown;
    try {
      body = await this.request<unknown>(
        "GET",
        `/repos/${input.repo}/contents/${input.path}${query}`,
      );
    } catch (error) {
      // A missing file is an answer ("this repository does not declare it"),
      // not a failure of the lookup.
      if (error instanceof GitHubRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
    const record = (body ?? {}) as Record<string, unknown>;
    if (record.encoding !== "base64" || typeof record.content !== "string") {
      return undefined;
    }
    return Buffer.from(record.content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokenProvider.getToken();
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed: unknown = text ? safeJson(text) : undefined;
    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message?: unknown }).message)
          : undefined) ?? text.slice(0, 200);
      throw new GitHubRequestError(
        response.status,
        `GitHub ${method} ${path} → ${response.status} ${message}`.trim(),
      );
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toPullRequest(raw: unknown): GitHubPullRequest {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    number: Number(record.number ?? 0),
    url: String(record.html_url ?? record.url ?? ""),
    state: record.state === "closed" ? "closed" : "open",
    merged: record.merged === true || record.merged_at != null,
    ...(typeof record.merged_at === "string" ? { mergedAt: record.merged_at } : {}),
    ...(typeof record.merge_commit_sha === "string" && record.merge_commit_sha
      ? { mergeCommitSha: record.merge_commit_sha }
      : {}),
    head: String((record.head as Record<string, unknown> | undefined)?.ref ?? ""),
    base: String((record.base as Record<string, unknown> | undefined)?.ref ?? ""),
  };
}

function toRun(raw: unknown): GitHubWorkflowRun {
  const record = (raw ?? {}) as Record<string, unknown>;
  const status = record.status;
  return {
    id: Number(record.id ?? 0),
    name: String(record.name ?? ""),
    branch: String(record.head_branch ?? ""),
    status:
      status === "queued" || status === "in_progress" || status === "completed"
        ? status
        : "completed",
    ...(normalizeConclusion(record.conclusion as string | null | undefined)
      ? { conclusion: normalizeConclusion(record.conclusion as string | null | undefined)! }
      : {}),
    url: String(record.html_url ?? ""),
    createdAt: String(record.created_at ?? ""),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.event === "string" ? { event: record.event } : {}),
    ...(typeof record.head_sha === "string" ? { headSha: record.head_sha } : {}),
  };
}
