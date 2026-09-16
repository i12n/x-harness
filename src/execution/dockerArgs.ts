import { resolve } from "node:path";
import type { ExecutionProfile } from "../domain/executionProfile.js";

export interface DockerRunSpec {
  runId: string;
  workspacePath: string;
  profile: ExecutionProfile;
  secrets: Record<string, string>;
  containerName?: string;
}

export function containerNameFor(runId: string): string {
  return `ai-harness-${runId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

export interface DockerExecSpec {
  containerId: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** `docker exec` args used to run the agent / verification inside the Run. */
export function buildDockerExecArgs(spec: DockerExecSpec): string[] {
  const args = ["exec", "--interactive", "--workdir", spec.cwd ?? "/workspace"];
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(spec.containerId, ...spec.command);
  return args;
}

/**
 * Build `docker run` args for one Run.
 *
 * Isolation rules (docs/remote-execution-isolation.md):
 * - mount ONLY the current Run worktree (never the host root or other runs)
 * - never mount /var/run/docker.sock (no docker access)
 * - cap-drop ALL, no-new-privileges, non-root user, read-only rootfs
 * - tmpfs /tmp and a writable HOME for caches
 * - CPU / memory / pids limits
 */
export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const { profile } = spec;
  const workspacePath = resolve(spec.workspacePath);
  const args: string[] = [
    "run",
    "--detach",
    "--rm",
    "--name",
    spec.containerName ?? containerNameFor(spec.runId),
    "--label",
    `ai-harness.run-id=${spec.runId}`,
    "--workdir",
    profile.workspace,
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(profile.resources.pidsLimit),
    "--cpus",
    String(profile.resources.cpus),
    "--memory",
    `${profile.resources.memoryMb}m`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs",
    "/home/agent:rw,noexec,nosuid,size=256m",
    "--env",
    "HOME=/home/agent",
    "--mount",
    `type=bind,src=${workspacePath},dst=${profile.workspace},rw`,
  ];

  args.push("--network", profile.network.mode === "none" ? "none" : "bridge");

  for (const [key, value] of Object.entries(spec.secrets)) {
    args.push("--env", `${key}=${value}`);
  }

  // Override any image ENTRYPOINT so the run container is a long-lived
  // sandbox driven via `docker exec` (see TASK-911 contract).
  args.push("--entrypoint", "sleep", profile.image, "infinity");
  return args;
}
