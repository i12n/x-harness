import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecutionProfile } from "../domain/executionProfile.js";
import { HarnessError } from "../errors.js";
import { buildDockerRunArgs, containerNameFor } from "./dockerArgs.js";
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
  containerWorkspace: string;
  profile: ExecutionProfile;
  containerId?: string;
  startedAt?: string;
}

/** Execution Plane driver: local (no container) or docker (Phase 9). */
export interface ExecutionDriver {
  create(request: ExecutionRequest): Promise<ExecutionEnvironment>;
  start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment>;
  cleanup(environment: ExecutionEnvironment): Promise<void>;
}

/** Current behavior: run directly in the worktree (no container isolation). */
export class LocalExecutionDriver implements ExecutionDriver {
  async create(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    const workspacePath = resolve(request.workspacePath);
    return {
      id: `local-${request.runId}`,
      runId: request.runId,
      workspacePath,
      containerWorkspace: workspacePath,
      profile: request.profile,
    };
  }

  async start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment> {
    return { ...environment, startedAt: new Date().toISOString() };
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
    };
  }

  async start(environment: ExecutionEnvironment): Promise<ExecutionEnvironment> {
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

  async cleanup(environment: ExecutionEnvironment): Promise<void> {
    const containerId = environment.containerId ?? environment.id;
    if (!containerId) {
      return;
    }
    try {
      await this.runDocker(["rm", "-f", containerId]);
    } catch {
      // Cleanup is best-effort; the container may already be gone.
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

/** Thin lifecycle wrapper so Worker can create/start/cleanup uniformly. */
export class ExecutionManager {
  constructor(private readonly driver: ExecutionDriver) {}

  async prepare(request: ExecutionRequest): Promise<ExecutionEnvironment> {
    const environment = await this.driver.create(request);
    return this.driver.start(environment);
  }

  async cleanup(environment: ExecutionEnvironment): Promise<void> {
    await this.driver.cleanup(environment);
  }
}
