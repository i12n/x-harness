import { ValidationError } from "../errors.js";
import { dedupeNonEmpty } from "../util/strings.js";

export const DEFAULT_EXECUTION_IMAGE = "harness/execution:base";
export const DEFAULT_CONTAINER_WORKSPACE = "/workspace";

export type ExecutionNetworkMode = "none" | "restricted";

export interface ExecutionNetworkPolicy {
  mode: ExecutionNetworkMode;
  /** Egress allow-list; empty means "no extra hosts". */
  allow: string[];
}

export interface ExecutionResources {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
}

/** What the agent is allowed to do (plan section 12). */
export interface ExecutionPolicy {
  workspaceAccess: "read_write" | "read_only";
  hostFilesystem: "deny";
  gitPush: "allow" | "deny";
  dockerAccess: "deny";
  productionAccess: "deny";
}

export interface ExecutionCommands {
  install?: string;
  test?: string;
  build?: string;
  /**
   * TASK-1226: the repository's own screenshot script, run by the preview
   * build after `build`. The harness does not drive a browser itself — the
   * repo knows how to start its app and which viewports matter.
   */
  screenshot?: string;
}

/** Per-repository execution environment (image, limits, policy, secrets). */
export interface ExecutionProfile {
  name: string;
  image: string;
  workspace: string;
  commands: ExecutionCommands;
  network: ExecutionNetworkPolicy;
  resources: ExecutionResources;
  policy: ExecutionPolicy;
  /** Secret *names* only; values are resolved at Run time, never stored. */
  secrets: string[];
}

export interface CreateExecutionProfileInput {
  name: string;
  image: string;
  workspace?: string;
  commands?: ExecutionCommands;
  network?: Partial<ExecutionNetworkPolicy>;
  resources?: Partial<ExecutionResources>;
  policy?: Partial<ExecutionPolicy>;
  secrets?: string[];
}

export function buildExecutionProfile(
  input: CreateExecutionProfileInput,
): ExecutionProfile {
  const name = input.name?.trim();
  if (!name) {
    throw new ValidationError("execution profile name is required");
  }
  const image = input.image?.trim();
  if (!image) {
    throw new ValidationError("execution profile image is required");
  }
  const mode = input.network?.mode ?? "none";
  if (mode !== "none" && mode !== "restricted") {
    throw new ValidationError(`invalid network mode: ${String(mode)}`);
  }
  return {
    name,
    image,
    workspace: input.workspace?.trim() || DEFAULT_CONTAINER_WORKSPACE,
    commands: {
      install: input.commands?.install?.trim() || undefined,
      test: input.commands?.test?.trim() || undefined,
      build: input.commands?.build?.trim() || undefined,
      screenshot: input.commands?.screenshot?.trim() || undefined,
    },
    network: { mode, allow: dedupeNonEmpty(input.network?.allow ?? []) },
    resources: {
      cpus: clampNumber(input.resources?.cpus ?? 2, 0.1, 64),
      memoryMb: clampNumber(input.resources?.memoryMb ?? 2048, 128, 65536),
      pidsLimit: clampNumber(input.resources?.pidsLimit ?? 512, 16, 8192),
    },
    policy: {
      workspaceAccess: input.policy?.workspaceAccess ?? "read_write",
      hostFilesystem: "deny",
      // TASK-1240: a newly registered repository defaults to `allow`, so an
      // approval actually lands on the remote instead of silently skipping.
      // The push guards stay: only `AI_GIT_PUSH_PREFIX` branches (ai/, test/),
      // never the default branch, and only after a human approval or an
      // explicit `task publish` / `deploy.test`.
      gitPush: input.policy?.gitPush ?? "allow",
      dockerAccess: "deny",
      productionAccess: "deny",
    },
    secrets: dedupeNonEmpty(input.secrets ?? []),
  };
}

export function defaultExecutionProfile(): ExecutionProfile {
  return buildExecutionProfile({
    name: "default",
    image: DEFAULT_EXECUTION_IMAGE,
  });
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
