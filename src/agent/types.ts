import type { Repository } from "../domain/repository.js";
import type { Task } from "../domain/task.js";
import type { Problem } from "../domain/problem.js";
import type { ExecutionContext } from "../execution/manager.js";

/** Fully assembled input handed to an agent engine. */
export interface AgentContext {
  runId: string;
  workspacePath: string;
  prompt: string;
  task?: Task;
  repository?: Repository;
  problem?: Problem;
  execution?: ExecutionContext;
}

export interface AgentResult {
  runId: string;
  exitCode: number | null;
  signal: string | undefined;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  /**
   * TASK-1247: the agent CLI's session id (`thread.started.thread_id`), when the
   * engine reports one. It is what makes an in-run repair turn possible: the
   * follow-up resumes this session instead of starting from scratch.
   */
  sessionId?: string;
}

/** Strict isolation point between the harness and agent engines. */
export interface AgentEngine {
  execute(context: AgentContext): Promise<AgentResult>;
  /**
   * TASK-1247: keep working in the same session — same conversation, same
   * workspace, all prior context intact. Engines that cannot do this leave it
   * undefined and the caller falls back to a fresh attempt.
   */
  continue?(
    context: AgentContext,
    prompt: string,
    options?: { sessionId?: string },
  ): Promise<AgentResult>;
  cancel(runId: string): Promise<void>;
}

/**
 * TASK-1247: a verification failure the agent could actually fix. Environment
 * problems (missing binaries, permissions, no network) are not repair material —
 * retrying them only burns attempts, so they fail fast with a clear reason.
 */
const ENVIRONMENTAL_FAILURE = /(command not found|not found|EACCES|EPERM|ENOENT|no such file)/i;

export function looksEnvironmental(text: string): boolean {
  return ENVIRONMENTAL_FAILURE.test(text);
}
