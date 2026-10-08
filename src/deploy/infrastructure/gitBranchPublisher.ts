import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitService } from "../../git/gitService.js";
import type { Repository } from "../../domain/repository.js";
import type { TestBranchPublisher } from "../application/deployService.js";

const execFileAsync = promisify(execFile);

export interface GitBranchPublisherOptions {
  git: GitService;
  gitBinary?: string;
  /** Injectable for tests: run git and return stdout. */
  exec?: (args: string[], cwd: string) => Promise<string>;
}

/**
 * TASK-1230: put the delivery's worktree on `test/<deliveryId>` and push it.
 *
 * The push itself goes through `GitService.publishWorkspace`, so the existing
 * safety rails still apply: only allowed branch prefixes, never the default
 * branch, and the repository's `gitPush` policy. Cutting the branch first is
 * the only new step — otherwise `publishWorkspace` would push whatever branch
 * the Run happened to leave behind (`ai/…`).
 */
export class GitBranchPublisher implements TestBranchPublisher {
  private readonly gitBinary: string;
  private readonly exec: (args: string[], cwd: string) => Promise<string>;

  constructor(private readonly options: GitBranchPublisherOptions) {
    this.gitBinary = options.gitBinary ?? process.env.AI_GIT_BIN ?? "git";
    this.exec =
      options.exec ??
      (async (args, cwd) => (await execFileAsync(this.gitBinary, args, { cwd, timeout: 120_000 })).stdout);
  }

  async publish(input: {
    repository: Repository;
    workspacePath: string;
    branch: string;
    message: string;
  }): Promise<{ pushed: boolean; reason?: string }> {
    try {
      await this.exec(["checkout", "-B", input.branch], input.workspacePath);
    } catch (error) {
      return {
        pushed: false,
        reason: `无法在 ${input.workspacePath} 切出分支 ${input.branch}：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const outcome = await this.options.git.publishWorkspace({
      repository: input.repository,
      workspacePath: input.workspacePath,
      message: input.message,
    });
    return {
      pushed: outcome.pushed,
      ...(outcome.pushed ? {} : { reason: outcome.message }),
    };
  }
}
