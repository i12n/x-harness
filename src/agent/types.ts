import type { Repository } from "../domain/repository.js";
import type { Task } from "../domain/task.js";
import type { Problem } from "../domain/problem.js";

/** Fully assembled input handed to an agent engine. */
export interface AgentContext {
  runId: string;
  workspacePath: string;
  prompt: string;
  task?: Task;
  repository?: Repository;
  problem?: Problem;
}

export interface AgentResult {
  runId: string;
  exitCode: number | null;
  signal: string | undefined;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
}

/** Strict isolation point between the harness and agent engines. */
export interface AgentEngine {
  execute(context: AgentContext): Promise<AgentResult>;
  cancel(runId: string): Promise<void>;
}
