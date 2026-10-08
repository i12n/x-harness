import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CACHE_MOUNT_ROOT,
  executionCacheKey,
  executionCacheRoot,
  prepareExecutionCache,
} from "../src/execution/cache.js";

describe("execution cache (TASK-1238)", () => {
  it("defaults to /var/cache/ai-harness and honours AI_CACHE_DIR", () => {
    expect(executionCacheRoot({})).toBe("/var/cache/ai-harness");
    expect(executionCacheRoot({ AI_CACHE_DIR: "/srv/cache/" })).toBe("/srv/cache");
  });

  it("keeps a cache key inside the cache root", () => {
    expect(executionCacheKey("repo-x-music")).toBe("repo-x-music");
    expect(executionCacheKey("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(executionCacheKey("   ")).toBe("default");
  });

  it("creates the cache directories and mounts them per target workdir", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-cache-"));
    const plan = await prepareExecutionCache("repo-1", {
      env: { AI_CACHE_DIR: root },
      targetWorkdirs: ["/workspace", "/workspaces/tgt-b"],
    });

    expect(plan.root).toBe(join(root, "repo-1"));
    expect(plan.mounts).toEqual([
      { source: join(root, "repo-1", "npm"), target: `${CACHE_MOUNT_ROOT}/npm` },
      { source: join(root, "repo-1", "next"), target: "/workspace/.next/cache" },
      { source: join(root, "repo-1", "next"), target: "/workspaces/tgt-b/.next/cache" },
    ]);
    expect(plan.env.npm_config_cache).toBe(`${CACHE_MOUNT_ROOT}/npm`);
    for (const mount of plan.mounts) {
      expect(statSync(mount.source).isDirectory()).toBe(true);
    }
  });

  it("is idempotent across runs of the same repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-cache-"));
    const first = await prepareExecutionCache("repo-1", { env: { AI_CACHE_DIR: root } });
    const second = await prepareExecutionCache("repo-1", { env: { AI_CACHE_DIR: root } });
    expect(second.root).toBe(first.root);
  });
});
