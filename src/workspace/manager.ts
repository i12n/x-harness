import { execFile } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { WorkspaceError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface CreateWorkspaceRequest {
  /** Local git checkout of the repository (repository.localPath). */
  repositoryLocalPath: string;
  taskId: string;
  runId: string;
}

export interface ManagedWorkspace {
  taskId: string;
  runId: string;
  /** Present for per-target workspaces (Phase 10); absent for legacy runs. */
  targetId?: string;
  repositoryLocalPath: string;
  path: string;
  branch: string;
  createdAt: string;
}

export interface TargetWorkspaceRequest {
  targetId: string;
  repositoryLocalPath: string;
  /** Order follows TaskTarget.position. */
  position: number;
  baseRef?: string;
}

export interface CreateRunWorkspacesRequest {
  taskId: string;
  runId: string;
  targets: TargetWorkspaceRequest[];
}

export interface WorkspaceManagerOptions {
  gitBinary?: string;
  baseDir?: string;
}

/**
 * One Run = one independent git worktree (plan section 十四):
 *
 *   git worktree add <base>/<taskId>/<runId> -b ai/<taskId>-<runId>
 */
export class WorkspaceManager {
  private readonly gitBinary: string;
  private readonly baseDir: string;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.gitBinary = options.gitBinary ?? "git";
    this.baseDir =
      options.baseDir ??
      process.env.AI_WORKSPACES_DIR ??
      resolve(homedir(), "ai-workspaces");
  }

  async createWorkspace(request: CreateWorkspaceRequest): Promise<ManagedWorkspace> {
    const path = resolve(this.baseDir, request.taskId, request.runId);
    const branch = `ai/${request.taskId}-${request.runId}`;

    await mkdir(dirname(path), { recursive: true });
    await this.runGit(["worktree", "add", path, "-b", branch], request.repositoryLocalPath);
    const canonicalPath = await realpath(path);

    return {
      taskId: request.taskId,
      runId: request.runId,
      repositoryLocalPath: request.repositoryLocalPath,
      path: canonicalPath,
      branch,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * TASK-1005: one workspace per TaskTarget, ordered by position.
   *
   *   <base>/<taskId>/<runId>/<targetId>/     branch ai/<task>-<run>-t<position>
   *
   * v1 never reuses a workspace: a retry (new Run) gets fresh directories.
   */
  async createRunWorkspaces(
    request: CreateRunWorkspacesRequest,
  ): Promise<ManagedWorkspace[]> {
    const ordered = [...request.targets].sort((a, b) => a.position - b.position);
    const workspaces: ManagedWorkspace[] = [];
    for (const target of ordered) {
      workspaces.push(await this.createTargetWorkspace(request.taskId, request.runId, target));
    }
    return workspaces;
  }

  private async createTargetWorkspace(
    taskId: string,
    runId: string,
    target: TargetWorkspaceRequest,
  ): Promise<ManagedWorkspace> {
    const path = resolve(
      this.baseDir,
      sanitizeSegment(taskId),
      sanitizeSegment(runId),
      sanitizeSegment(target.targetId),
    );
    const branch = `ai/${sanitizeSegment(taskId)}-${sanitizeSegment(runId)}-t${target.position}`;

    await mkdir(dirname(path), { recursive: true });
    const args = ["worktree", "add", path, "-b", branch];
    if (target.baseRef) {
      args.push(target.baseRef);
    }
    await this.runGit(args, target.repositoryLocalPath);
    const canonicalPath = await realpath(path);

    return {
      taskId,
      runId,
      targetId: target.targetId,
      repositoryLocalPath: target.repositoryLocalPath,
      path: canonicalPath,
      branch,
      createdAt: new Date().toISOString(),
    };
  }

  async removeWorkspace(
    workspace: Pick<ManagedWorkspace, "path" | "repositoryLocalPath">,
  ): Promise<void> {
    const path = resolve(workspace.path);
    const base = await this.canonicalDir(this.baseDir);
    if (!this.isPathInside(await this.canonicalDir(path), base)) {
      throw new WorkspaceError(
        `refusing to remove path outside workspaces base: ${path}`,
      );
    }
    await this.runGit(
      ["worktree", "remove", "--force", path],
      workspace.repositoryLocalPath,
    );
    // Safety net: worktree remove already deletes the directory; --force guards
    // against leftover untracked files.
    await rm(path, { recursive: true, force: true });
  }

  async listWorktrees(repositoryLocalPath: string): Promise<string[]> {
    const { stdout } = await this.runGit(["worktree", "list", "--porcelain"], repositoryLocalPath);
    const paths = stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean);
    const canonical: string[] = [];
    for (const entry of paths) {
      canonical.push(await this.canonicalDir(entry));
    }
    return canonical;
  }

  /** Diff of the workspace against a base (used by reviewers), capped size. */
  async showDiff(
    workspacePath: string,
    base = "HEAD",
    maxBytes = 200_000,
  ): Promise<string> {
    const stat = await this.runGit(["diff", "--stat", base], workspacePath);
    let body = "";
    try {
      body = (await this.runGit(["diff", base], workspacePath)).stdout;
    } catch {
      // A stat-only diff is still useful when the full diff is unavailable.
    }
    const combined = `${stat.stdout}\n${body}`.trim();
    return combined.length <= maxBytes
      ? combined
      : `${combined.slice(0, maxBytes)}\n...[truncated]`;
  }

  private async runGit(args: string[], cwd: string): Promise<{ stdout: string }> {
    try {
      const { stdout } = await execFileAsync(this.gitBinary, args, { cwd });
      return { stdout };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new WorkspaceError(`git ${args.join(" ")} failed: ${detail}`);
    }
  }

  private isPathInside(child: string, parent: string): boolean {
    const relativePath = relative(parent, child);
    return (
      relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath) &&
      (relativePath + sep).indexOf(`..${sep}`) === -1
    );
  }

  private async canonicalDir(value: string): Promise<string> {
    try {
      return await realpath(value);
    } catch {
      return resolve(value);
    }
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
