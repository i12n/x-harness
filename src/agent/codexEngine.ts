import { spawn, type ChildProcess } from "node:child_process";
import { AgentExecutionError } from "../errors.js";
import type { AgentContext, AgentEngine, AgentResult } from "./types.js";

export interface CodexEngineOptions {
  /** Executable to spawn; defaults to $AI_CODEX_BIN or `codex`. */
  executable?: string;
  /** Sandbox mode; defaults to $AI_CODEX_SANDBOX or `workspace-write`. */
  sandbox?: string;
  /** Override how spawn args are built (used by tests with fake engines). */
  spawnArgs?: (context: AgentContext) => string[];
  /** Extra environment variables merged over process.env. */
  env?: Record<string, string>;
}

const FORCE_KILL_DELAY_MS = 3_000;

/**
 * Codex Engine (plan section 十五/十六): spawns `codex exec` inside the
 * run workspace. Process exit only means "agent execution finished" — it does
 * NOT mean the task completed (verification decides that, Phase 5+).
 */
export class CodexEngine implements AgentEngine {
  private readonly executable: string;
  private readonly sandbox: string;
  private readonly spawnArgs: (context: AgentContext) => string[];
  private readonly env: Record<string, string>;
  private readonly active = new Map<string, ActiveChild>();

  constructor(options: CodexEngineOptions = {}) {
    this.executable =
      options.executable ?? process.env.AI_CODEX_BIN ?? "codex";
    this.sandbox = options.sandbox ?? process.env.AI_CODEX_SANDBOX ?? "workspace-write";
    this.spawnArgs =
      options.spawnArgs ??
      ((_context: AgentContext) => [
        "exec",
        "--sandbox",
        this.sandbox,
        "--json",
        "-",
      ]);
    this.env = options.env ?? {};
  }

  execute(context: AgentContext): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      const args = this.spawnArgs(context);
      const startedAt = new Date().toISOString();
      let child: ChildProcess;
      try {
        child = spawn(this.executable, args, {
          cwd: context.execution?.workdir ?? context.workspacePath,
          env: { ...process.env, ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          new AgentExecutionError(
            `failed to spawn ${this.executable}: ${String(error)}`,
          ),
        );
        return;
      }

      const activeChild: ActiveChild = { child, forceKill: undefined };
      this.active.set(context.runId, activeChild);

      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error: Error) => {
        this.active.delete(context.runId);
        reject(new AgentExecutionError(`agent process error: ${error.message}`));
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        this.active.delete(context.runId);
        resolve({
          runId: context.runId,
          exitCode: code,
          signal: signal ?? undefined,
          stdout,
          stderr,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      });

      child.stdin?.end(context.prompt);
    });
  }

  async cancel(runId: string): Promise<void> {
    const activeChild = this.active.get(runId);
    if (!activeChild) {
      return;
    }
    if (!activeChild.child.kill("SIGTERM")) {
      return;
    }
    activeChild.forceKill = setTimeout(() => {
      activeChild.child.kill("SIGKILL");
    }, FORCE_KILL_DELAY_MS);
    activeChild.forceKill.unref();
  }
}

interface ActiveChild {
  child: ChildProcess;
  forceKill: NodeJS.Timeout | undefined;
}
