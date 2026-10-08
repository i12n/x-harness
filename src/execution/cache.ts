import { chown, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * TASK-1238: Run containers start from a read-only rootfs with a tmpfs HOME, so
 * every attempt re-downloads npm packages and rebuilds the frontend from
 * scratch. Live measurement: the verification phase was 114–152s of a
 * 255–322s Run, and it repeated the same `npm ci` + build on identical inputs.
 *
 * A per-repository bind mount keeps those caches between Runs without touching
 * the isolation rules: still exactly one worktree, still no docker socket, no
 * root, and no cache contents are ever read by the harness itself.
 */

/** Container path the caches are mounted at (one mount root, two subdirs). */
export const CACHE_MOUNT_ROOT = "/ai-cache";

/** `buildDockerRunArgs` runs the container as this uid:gid. */
const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;

export interface ExecutionCachePlan {
  /** Host directory holding this repository's cache (created by the caller). */
  root: string;
  /** `--mount` pairs: source on the host → path inside the container. */
  mounts: { source: string; target: string }[];
  /** Environment that makes the tools use the mounted cache. */
  env: Record<string, string>;
}

/** `AI_CACHE_DIR` overrides the default; tests and local runs stay untouched. */
export function executionCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AI_CACHE_DIR?.trim().replace(/\/+$/, "");
  return configured || "/var/cache/ai-harness";
}

/** Repository ids are already safe, but never let a key escape the cache root. */
export function executionCacheKey(key: string): string {
  const cleaned = key.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "default";
}

/**
 * Creates (and hands to the container user) the cache directories for one
 * repository. Called per Run, so it must be idempotent and cheap.
 */
export async function prepareExecutionCache(
  key: string,
  options: { env?: NodeJS.ProcessEnv; targetWorkdirs?: string[] } = {},
): Promise<ExecutionCachePlan> {
  const root = join(executionCacheRoot(options.env), executionCacheKey(key));
  const npm = join(root, "npm");
  const next = join(root, "next");
  for (const dir of [npm, next]) {
    await mkdir(dir, { recursive: true });
    // The container writes as uid 1000; a root-owned directory would be
    // read-only for it. Best effort: the local driver has no such mapping.
    await chown(dir, CONTAINER_UID, CONTAINER_GID).catch(() => undefined);
  }
  const mounts = [{ source: npm, target: `${CACHE_MOUNT_ROOT}/npm` }];
  for (const workdir of options.targetWorkdirs ?? []) {
    // Next.js keeps its build cache inside the worktree; mounting it per target
    // keeps the cache across Runs while the worktree itself stays disposable.
    mounts.push({ source: next, target: join(workdir, ".next/cache") });
  }
  return {
    root,
    mounts,
    env: {
      npm_config_cache: `${CACHE_MOUNT_ROOT}/npm`,
      NPM_CONFIG_CACHE: `${CACHE_MOUNT_ROOT}/npm`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  };
}
