import { homedir } from "node:os";
import { resolve } from "node:path";
import { HarnessError } from "../errors.js";
import {
  DockerExecutionDriver,
  LocalExecutionDriver,
  type ExecutionDriver,
} from "./manager.js";

export type ExecutionDriverMode = "local" | "docker";

/**
 * Workspace root shared by the WorkspaceManager and the Docker driver.
 * The driver only accepts mounts under this root (safety rule), so both must
 * be derived from the same variable.
 */
export function workspacesDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AI_WORKSPACES_DIR ?? resolve(homedir(), "ai-workspaces"));
}

export function parseExecutionDriverMode(value: string | undefined): ExecutionDriverMode {
  const mode = (value ?? "local").trim().toLowerCase();
  if (mode === "local" || mode === "docker") {
    return mode;
  }
  throw new HarnessError(`invalid AI_EXECUTION_DRIVER '${value}' (use local|docker)`);
}

/**
 * Selects the execution driver at the edge: the CLI and the service must not
 * disagree about whether a Run executes on the host or in a container.
 */
export function createExecutionDriver(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionDriver {
  const mode = parseExecutionDriverMode(env.AI_EXECUTION_DRIVER);
  if (mode === "docker") {
    return new DockerExecutionDriver({ workspaceRoots: [workspacesDir(env)] });
  }
  return new LocalExecutionDriver();
}

/**
 * Sandbox mode for the Codex agent process.
 *
 * Layering matters: with the Docker driver the container *is* the isolation
 * boundary (cap-drop ALL, no-new-privileges, read-only rootfs, a single
 * worktree mount, restricted network), and Codex's own bubblewrap sandbox
 * cannot create a user namespace inside it — every command would fail with
 * `bwrap: No permissions to create a new namespace`. With the local driver
 * there is no outer boundary, so Codex keeps `workspace-write`.
 *
 * `AI_CODEX_SANDBOX` overrides the default when a deployment needs it.
 */
export function codexSandboxFor(
  mode: ExecutionDriverMode,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.AI_CODEX_SANDBOX?.trim();
  if (override) {
    return override;
  }
  return mode === "docker" ? "danger-full-access" : "workspace-write";
}
