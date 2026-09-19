import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawn/git/docker based tests need headroom on busy machines; the default
    // 5s flakes when the host is loaded (observed with load average > 200).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    // This machine is often under heavy external load; cap parallelism so the
    // spawn-heavy suite does not thrash (or hang) when everything runs at once.
    minWorkers: 1,
    maxWorkers: 4,
  },
});
