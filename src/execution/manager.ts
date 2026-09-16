import { execFile, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecutionRecord, ExecutionStatus } from "../domain/execution.js";
import { defaultExecutionProfile } from "../domain/executionProfile.js";
import type { ExecutionProfile } from "../domain/executionProfile.js";
import { HarnessError } from "../errors.js";
import { validateExecutionProfileContract } from "./contract.js";
import type { EventStore } from "../store/eventStore.js";
import type { ExecutionStore } from "../store/executionStore.js";
import { makeId } from "../util/id.js";
import {
  buildDockerExecArgs,
  buildDockerRunArgs,
  containerNameFor,
} from "./dockerArgs.js";
import { EnvSecretStore, type SecretStore } from "./secrets.js";

const execFileAsync = promisify(execFile);

export interface ExecutionRequest {
  runId: string;
  workspacePath: string;
  profile: ExecutionProfile;
}

export interface ExecutionEnvironment {
  id: string;
  runId: string;
  workspacePath: string;
  /** Path the agent/verifier should run in (host path or container path). */
  containerWorkspace: string;
  profile: ExecutionProfile;
  driver: string;
  containerId?: string;
  startedAt?: string;
  /** Persisted lifecycle record id (when an ExecutionStore is configured). */
  executionRecordId?: string;
}

/** What Agent/Verifier see — they never care whether it is host or docker. */
export interface ExecutionContext {
  runId: string;
  executionId: string;
  /** Host-side workspace path (worktree). */
  workspacePath: string;
  /** Working directory for agent/verifier commands. */
  workdir: string;
  driver: string;
  containerId?: string;
  exec?: ExecutionExec;
}

export function toExecutionContext(
  environment: ExecutionEnvironment,
  exec?: ExecutionExec,
): ExecutionContext {
  return {
    runId: environment.runId,
    executionId: environment.id,
    workspacePath: environment.workspacePath,
    workdir: environment.containerWorkspace || environment.workspacePath,
    driver: environment.driver,
    containerId: environment.containerId,
    exec,
  };
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationSeconds: number;
  timedOut: boolean;
}

/** Bound "run this command inside my execution environment" capability. */
export type ExecutionExec = (
  command: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Execution Plane driver: local (no container) or docker (Phase 9). */
export interface ExecutionDriver {
  readonly name: string;
  create(request: ExecutionRequest): Promise<ExecutionEnvironment>;
  start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment>;
  exec(
    environment: ExecutionEnvironment,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  stop?(environment: ExecutionEnvironment): Promise<void>;
  cleanup(environment: ExecutionEnvironment): Promise<void>;
}

/** Current behavior: run directly in the worktree (no container isolation). */
export class LocalExecutionDriver implements ExecutionDriver {
  readonly name = "local";

  async create(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    const workspacePath = resolve(request.workspacePath);
    return {
      id: `local-${request.runId}`,
      runId: request.runId,
      workspacePath,
      containerWorkspace: workspacePath,
      profile: request.profile,
      driver: this.name,
    };
  }

  async start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment> {
    return { ...environment, startedAt: new Date().toISOString() };
  }

  async exec(
    environment: ExecutionEnvironment,
    command: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    return runCommand(
      command,
      options.cwd ?? environment.containerWorkspace ?? environment.workspacePath,
      options,
    );
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up in local mode.
  }
}

export interface DockerExecutionDriverOptions {
  dockerBinary?: string;
  secretStore?: SecretStore;
}

/** One Run = one container, mounted with only that Run's worktree. */
export class DockerExecutionDriver implements ExecutionDriver {
  readonly name = "docker";
  private readonly dockerBinary: string;
  private readonly secretStore: SecretStore;

  constructor(options: DockerExecutionDriverOptions = {}) {
    this.dockerBinary = options.dockerBinary ?? process.env.AI_DOCKER_BIN ?? "docker";
    this.secretStore = options.secretStore ?? new EnvSecretStore();
  }

  async create(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    return {
      id: containerNameFor(request.runId),
      runId: request.runId,
      workspacePath: resolve(request.workspacePath),
      containerWorkspace: request.profile.workspace,
      profile: request.profile,
      driver: this.name,
    };
  }

  async start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment> {
    validateExecutionProfileContract(environment.profile);
    const secrets = await this.secretStore.resolve(environment.profile.secrets);
    const args = buildDockerRunArgs({
      runId: environment.runId,
      workspacePath: environment.workspacePath,
      profile: environment.profile,
      secrets,
    });
    const { stdout } = await this.runDocker(args);
    return {
      ...environment,
      containerId: stdout.trim(),
      startedAt: new Date().toISOString(),
    };
  }

  async exec(
    environment: ExecutionEnvironment,
    command: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const containerId = environment.containerId;
    if (!containerId) {
      throw new HarnessError("docker exec requires a running container");
    }
    const args = buildDockerExecArgs({
      containerId,
      command,
      cwd: options.cwd ?? environment.containerWorkspace,
      env: options.env,
    });
    return runCommand([this.dockerBinary, ...args], undefined, options, true);
  }

  async stop(environment: ExecutionEnvironment): Promise<void> {
    const containerId = environment.containerId ?? environment.id;
    try {
      await this.runDocker(["stop", containerId]);
    } catch {
      // Stop is best-effort; cleanup remains the final obligation.
    }
  }

  async cleanup(environment: ExecutionEnvironment): Promise<void> {
    const containerId = environment.containerId ?? environment.id;
    if (!containerId) {
      return;
    }
    try {
      await this.runDocker(["rm", "-f", containerId]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No such container")) {
        return;
      }
      throw error;
    }
  }

  private async runDocker(args: string[]): Promise<{ stdout: string }> {
    try {
      const { stdout } = await execFileAsync(this.dockerBinary, args);
      return { stdout };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new HarnessError(`${this.dockerBinary} ${args[0]} failed: ${detail}`);
    }
  }
}

export interface ExecutionManagerOptions {
  driver: ExecutionDriver;
  executions?: ExecutionStore;
  events?: EventStore;
}

export type ExecutionRef = ExecutionEnvironment | ExecutionRecord | string;

/**
 * Execution lifecycle contract (TASK-901/908):
 *
 *   CREATING -> CREATED -> STARTING -> RUNNING -> <terminal> -> CLEANING -> CLEANED
 *
 * Cleanup obligation: once `create()` succeeded, cleanup MUST be attempted —
 * even when `start()` fails, the agent throws, or the run times out.
 * A failed cleanup is recorded as CLEANUP_FAILED, never hidden.
 */
export class ExecutionManager {
  private readonly driver: ExecutionDriver;
  private readonly executions: ExecutionStore | undefined;
  private readonly events: EventStore | undefined;

  constructor(driverOrOptions: ExecutionDriver | ExecutionManagerOptions) {
    if ("driver" in driverOrOptions) {
      this.driver = driverOrOptions.driver;
      this.executions = driverOrOptions.executions;
      this.events = driverOrOptions.events;
    } else {
      this.driver = driverOrOptions;
      this.executions = undefined;
      this.events = undefined;
    }
  }

  get driverName(): string {
    return this.driver.name;
  }

  async prepare(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    const record = await this.createRecord(request);
    let environment: ExecutionEnvironment;
    try {
      environment = await this.driver.create(request);
    } catch (error) {
      await this.update(record, { status: "FAILED", error: messageOf(error) });
      await this.emit(record, "execution.failed", { phase: "create" });
      throw error;
    }
    environment.executionRecordId = record?.id;
    await this.update(record, { status: "CREATED" });

    await this.update(record, { status: "STARTING" });
    try {
      environment = await this.driver.start(environment);
    } catch (error) {
      // create() succeeded: cleanup obligation applies.
      await this.update(record, { status: "FAILED", error: messageOf(error) });
      await this.emit(record, "execution.failed", { phase: "start" });
      await this.cleanup(environment);
      throw error;
    }
    environment.executionRecordId = record?.id;
    await this.update(record, {
      status: "RUNNING",
      containerId: environment.containerId,
      startedAt: environment.startedAt ?? new Date().toISOString(),
    });
    await this.emit(record, "execution.prepared", {
      driver: environment.driver,
    });
    return environment;
  }

  /** Mark the execution terminal (SUCCEEDED/FAILED/TIMED_OUT/CANCELLED/LOST). */
  async finish(
    environmentOrId: ExecutionRef,
    status: ExecutionStatus,
    error?: unknown,
  ): Promise<ExecutionRecord | undefined> {
    const record = await this.resolve(environmentOrId);
    if (!record) {
      return undefined;
    }
    return this.update(record, {
      status,
      error: error === undefined ? undefined : messageOf(error),
      finishedAt: new Date().toISOString(),
    });
  }

  async stop(environment: ExecutionEnvironment): Promise<void> {
    if (!this.driver.stop) {
      return;
    }
    try {
      await this.driver.stop(environment);
    } catch {
      // Stop is best-effort; cleanup remains the final obligation.
    }
  }

  /** TASK-912: agent/verifier run commands through the execution driver. */
  async exec(
    environment: ExecutionEnvironment,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return this.driver.exec(environment, command, options);
  }

  /**
   * Final cleanup obligation. Returns the persisted record when a store is
   * configured; a driver failure is recorded as CLEANUP_FAILED (not hidden).
   */
  async cleanup(
    environmentOrId: ExecutionRef,
  ): Promise<ExecutionRecord | undefined> {
    const record = await this.resolve(environmentOrId);
    if (record?.status === "CLEANED") {
      return record;
    }
    const environment =
      typeof environmentOrId === "string" || !isExecutionEnvironment(environmentOrId)
        ? record
          ? environmentFromRecord(record)
          : undefined
        : environmentOrId;
    if (!environment) {
      return undefined;
    }
    await this.update(record, { status: "CLEANING" });
    try {
      await this.driver.cleanup(environment);
    } catch (error) {
      const failed = await this.update(record, {
        status: "CLEANUP_FAILED",
        error: messageOf(error),
      });
      await this.emit(record, "execution.cleanup_failed", {
        driver: environment.driver,
        message: messageOf(error),
      });
      return failed;
    }
    const cleaned = await this.update(record, {
      status: "CLEANED",
      cleanedAt: new Date().toISOString(),
    });
    await this.emit(record, "execution.cleaned", { driver: environment.driver });
    return cleaned;
  }

  /** Recovery entry point: clean up a persisted record after a worker crash. */
  async cleanupRecord(record: ExecutionRecord): Promise<ExecutionRecord | undefined> {
    return this.cleanup(record);
  }

  private async createRecord(
    request: ExecutionRequest,
  ): Promise<ExecutionRecord | undefined> {
    if (!this.executions) {
      return undefined;
    }
    return this.executions.createExecution({
      id: makeId("exec"),
      runId: request.runId,
      driver: this.driver.name,
      workspacePath: request.workspacePath,
      workdir: request.profile.workspace,
      profileName: request.profile.name,
      status: "CREATING",
    });
  }

  private async resolve(
    environmentOrId: ExecutionRef,
  ): Promise<ExecutionRecord | undefined> {
    if (!this.executions) {
      return undefined;
    }
    const id =
      typeof environmentOrId === "string"
        ? environmentOrId
        : isExecutionEnvironment(environmentOrId)
          ? environmentOrId.executionRecordId
          : environmentOrId.id;
    if (!id) {
      return undefined;
    }
    try {
      return await this.executions.findExecution(id);
    } catch {
      return undefined;
    }
  }

  private async update(
    record: ExecutionRecord | undefined,
    update: Parameters<ExecutionStore["updateExecution"]>[1],
  ): Promise<ExecutionRecord | undefined> {
    if (!record || !this.executions) {
      return undefined;
    }
    return this.executions.updateExecution(record.id, update);
  }

  private async emit(
    record: ExecutionRecord | undefined,
    type: string,
    payload: unknown,
  ): Promise<void> {
    if (!record || !this.events) {
      return;
    }
    try {
      await this.events.record({ type, runId: record.runId, payload });
    } catch {
      // History must never break execution.
    }
  }
}

function environmentFromRecord(record: ExecutionRecord): ExecutionEnvironment {
  return {
    id: record.containerId ?? record.id,
    runId: record.runId,
    workspacePath: record.workspacePath,
    containerWorkspace: record.workdir,
    profile: defaultExecutionProfile(),
    driver: record.driver,
    containerId: record.containerId,
    executionRecordId: record.id,
  };
}

function isExecutionEnvironment(value: ExecutionRef): value is ExecutionEnvironment {
  return (
    typeof value !== "string" &&
    "containerWorkspace" in value &&
    "profile" in value
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runCommand(
  command: string[],
  cwd: string | undefined,
  options: ExecOptions,
  dockerWrapper = false,
): Promise<ExecResult> {
  const startedAt = Date.now();
  return new Promise<ExecResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command[0] ?? "", command.slice(1), {
        cwd: dockerWrapper ? undefined : cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: String(error),
        durationSeconds: elapsedSeconds(startedAt),
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : undefined;
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, signal?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationSeconds: elapsedSeconds(startedAt),
        timedOut,
      });
    };

    child.on("error", (error) => finish(null, String(error)));
    child.on("close", (code, signal) =>
      finish(code, signal === null ? undefined : String(signal)),
    );
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, (Date.now() - startedAt) / 1000);
}
