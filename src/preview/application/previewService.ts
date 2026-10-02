import type { Delivery } from "../../domain/delivery.js";
import type { ExecutionProfile } from "../../domain/executionProfile.js";
import type { Repository } from "../../domain/repository.js";
import type { Run } from "../../domain/run.js";
import type { Task } from "../../domain/task.js";
import type { ExecutionEnvironment, ExecutionManager } from "../../execution/manager.js";
import type { EventStore } from "../../store/eventStore.js";
import { extractWorkspacesInfo } from "../../workspace/info.js";

export type PreviewStatus = "BUILT" | "FAILED" | "NO_BUILD";

export interface PreviewCommandResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode: number | null;
  durationSeconds: number;
  /** Tail of the output (already truncated). */
  output: string;
}

export interface PreviewEvidence {
  deliveryId: string;
  status: PreviewStatus;
  commands: PreviewCommandResult[];
  /** Paths as they exist on the host (the container writes into the worktree). */
  screenshots: string[];
  artifacts: { path: string; sizeKb: number }[];
  notes: string[];
  startedAt: string;
  finishedAt: string;
}

export interface PreviewDeliveryPort {
  load(deliveryId: string): Promise<{ delivery: Delivery; tasks: Task[] }>;
}

export interface PreviewServiceDeps {
  deliveries: PreviewDeliveryPort;
  repositories: { findRepository(id: string): Promise<Repository> };
  runs: { listRuns(filter: { taskId: string }): Promise<Run[]> };
  executionManager: ExecutionManager;
  events?: EventStore;
  /** Package hosts the preview container may reach (default: npm registry). */
  allowedHosts?: string[];
  maxOutputChars?: number;
  memoryMb?: number;
  cpus?: number;
  now?: () => Date;
}

const DEFAULT_ALLOWED_HOSTS = ["registry.npmjs.org"];
const DEFAULT_MAX_OUTPUT = 4_000;
const DEFAULT_MEMORY_MB = 768;
const DEFAULT_CPUS = 1;
/** Build outputs worth reporting a size for. */
const ARTIFACT_DIRS = [".next", "dist", "build", "out"];

/** Env knobs, resolved in one place so wiring stays declarative. */
export function previewSettingsFromEnv(
  env: Record<string, string | undefined>,
): { allowedHosts?: string[]; memoryMb?: number; cpus?: number } {
  const allowedHosts = (env.AI_PREVIEW_ALLOW ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const memoryMb = Number(env.AI_PREVIEW_MEMORY_MB);
  const cpus = Number(env.AI_PREVIEW_CPUS);
  return {
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(Number.isFinite(memoryMb) && memoryMb > 0 ? { memoryMb } : {}),
    ...(Number.isFinite(cpus) && cpus > 0 ? { cpus } : {}),
  };
}

/**
 * TASK-1226: evidence-style preview.
 *
 * A one-shot container runs the repository's own `install` → `build` →
 * `screenshot` commands against the Run's worktree and everything it produces
 * is recorded as evidence. It is deliberately NOT a long-lived preview server:
 * no ports, no TTL, no reverse proxy — that is TASK-1227.
 *
 * Failure never blocks acceptance. The point is to tell the human what state
 * the change is in, not to gate on it.
 */
export class PreviewService {
  constructor(private readonly deps: PreviewServiceDeps) {}

  async build(deliveryId: string): Promise<PreviewEvidence> {
    const startedAt = this.nowIso();
    const { delivery, tasks } = await this.deps.deliveries.load(deliveryId);
    const target = await this.findWorktree(tasks);
    if (!target) {
      return this.finish({
        deliveryId,
        status: "NO_BUILD",
        commands: [],
        screenshots: [],
        artifacts: [],
        notes: ["没有找到带工作区的成功 Run，无法构建预览"],
        startedAt,
      });
    }

    const { repository } = target;
    const commands = repository.executionProfile.commands;
    const plan = [commands.install, commands.build, commands.screenshot]
      .map((command, index) => ({ command, name: ["install", "build", "screenshot"][index]! }))
      .filter((entry): entry is { command: string; name: string } => Boolean(entry.command));
    if (plan.length === 0) {
      return this.finish({
        deliveryId,
        status: "NO_BUILD",
        commands: [],
        screenshots: [],
        artifacts: [],
        notes: [
          "执行档案没有配置 commands.install / build / screenshot —— " +
            "预览没有可执行的内容，只能依据仓库验证命令的结论。",
        ],
        startedAt,
      });
    }

    const profile = this.previewProfile(repository.executionProfile);
    const results: PreviewCommandResult[] = [];
    let environment: ExecutionEnvironment | undefined;
    try {
      environment = await this.deps.executionManager.prepare({
        runId: `preview-${delivery.id}`,
        profile,
        workspacePath: target.worktree,
      });
      for (const entry of plan) {
        results.push(await this.runCommand(environment, entry.command, entry.name));
      }
      const artifacts = await this.collectArtifacts(environment);
      const screenshots = await this.collectScreenshots(environment);
      const failed = results.some((result) => result.status === "failed");
      return this.finish({
        deliveryId,
        status: failed ? "FAILED" : "BUILT",
        commands: results,
        screenshots,
        artifacts,
        notes: failed ? ["构建或截图命令失败：应用很可能起不来"] : [],
        startedAt,
      });
    } catch (error) {
      return this.finish({
        deliveryId,
        status: "FAILED",
        commands: results,
        screenshots: [],
        artifacts: [],
        notes: [`预览容器启动失败：${error instanceof Error ? error.message : String(error)}`],
        startedAt,
      });
    } finally {
      if (environment) {
        try {
          await this.deps.executionManager.stop(environment);
          await this.deps.executionManager.finish(environment, "SUCCEEDED");
          await this.deps.executionManager.cleanup(environment);
        } catch {
          // Cleanup must never mask the evidence.
        }
      }
    }
  }

  /** First required task with a successful Run that recorded a workspace. */
  private async findWorktree(
    tasks: Task[],
  ): Promise<{ task: Task; run: Run; repository: Repository; worktree: string } | undefined> {
    for (const task of tasks) {
      const runs = await this.deps.runs.listRuns({ taskId: task.id });
      const run = [...runs].reverse().find((candidate) => candidate.status === "SUCCEEDED");
      if (!run) {
        continue;
      }
      const workspace = extractWorkspacesInfo(run)[0];
      if (!workspace?.path) {
        continue;
      }
      try {
        const repository = await this.deps.repositories.findRepository(task.repositoryId);
        return { task, run, repository, worktree: workspace.path };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private previewProfile(profile: ExecutionProfile): ExecutionProfile {
    const allow = [...new Set([...profile.network.allow, ...(this.deps.allowedHosts ?? DEFAULT_ALLOWED_HOSTS)])];
    return {
      ...profile,
      network: { mode: "restricted", allow },
      resources: {
        cpus: this.deps.cpus ?? DEFAULT_CPUS,
        memoryMb: this.deps.memoryMb ?? DEFAULT_MEMORY_MB,
        pidsLimit: profile.resources.pidsLimit,
      },
      policy: { ...profile.policy, gitPush: "deny" },
    };
  }

  private async runCommand(
    environment: ExecutionEnvironment,
    command: string,
    name: string,
  ): Promise<PreviewCommandResult> {
    const startedAt = Date.now();
    try {
      const result = await this.deps.executionManager.exec(
        environment,
        ["sh", "-lc", command],
        { cwd: environment.containerWorkspace },
      );
      const exitCode = result.exitCode ?? 0;
      return {
        command: `${name}: ${command}`,
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        output: this.tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
      };
    } catch (error) {
      return {
        command: `${name}: ${command}`,
        status: "failed",
        exitCode: null,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async collectArtifacts(
    environment: ExecutionEnvironment,
  ): Promise<{ path: string; sizeKb: number }[]> {
    const artifacts: { path: string; sizeKb: number }[] = [];
    for (const dir of ARTIFACT_DIRS) {
      try {
        const result = await this.deps.executionManager.exec(
          environment,
          ["du", "-sk", dir],
          { cwd: environment.containerWorkspace },
        );
        const sizeKb = Number((result.stdout ?? "").trim().split(/\s+/)[0]);
        if (Number.isFinite(sizeKb) && sizeKb > 0) {
          artifacts.push({ path: dir, sizeKb });
        }
      } catch {
        // Missing output directory is the normal case, not an error.
      }
    }
    return artifacts;
  }

  private async collectScreenshots(
    environment: ExecutionEnvironment,
  ): Promise<string[]> {
    try {
      const result = await this.deps.executionManager.exec(
        environment,
        ["sh", "-lc", "ls -1 *.png screenshots/*.png 2>/dev/null | head -50"],
        { cwd: environment.containerWorkspace },
      );
      return (result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async finish(
    partial: Omit<PreviewEvidence, "finishedAt">,
  ): Promise<PreviewEvidence> {
    const evidence: PreviewEvidence = { ...partial, finishedAt: this.nowIso() };
    await this.record(evidence);
    return evidence;
  }

  private async record(evidence: PreviewEvidence): Promise<void> {
    try {
      await this.deps.events?.record({
        type: evidence.status === "FAILED" ? "PreviewFailed" : "PreviewBuilt",
        payload: evidence,
      });
    } catch {
      // History must never fail a preview.
    }
  }

  private tail(value: string): string {
    const limit = this.deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    const trimmed = value.trim();
    return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
