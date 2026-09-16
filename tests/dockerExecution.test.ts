import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import { buildDockerRunArgs } from "../src/execution/dockerArgs.js";
import { EnvSecretStore } from "../src/execution/secrets.js";

const profile = buildExecutionProfile({
  name: "frontend-node",
  image: "harness/node:22",
  network: { mode: "restricted", allow: ["registry.npmjs.org"] },
  resources: { cpus: 4, memoryMb: 4096, pidsLimit: 256 },
  secrets: ["GITHUB_TOKEN"],
});

describe("buildDockerRunArgs isolation rules", () => {
  it("mounts only the current run workspace", () => {
    const workspacePath = "/srv/harness/runs/task-001/run-001";
    const args = buildDockerRunArgs({
      runId: "run-001",
      workspacePath,
      profile,
      secrets: { GITHUB_TOKEN: "token-value" },
    });

    const mounts = args.filter((_, index) => args[index - 1] === "--mount");
    expect(mounts).toEqual([
      `type=bind,src=${resolve(workspacePath)},dst=/workspace,rw`,
    ]);
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(mounts.some((mount) => mount.includes("src=/,"))).toBe(false);
  });

  it("applies the isolation and resource flags", () => {
    const args = buildDockerRunArgs({
      runId: "run-001",
      workspacePath: "/tmp/ws",
      profile,
      secrets: {},
    });

    expect(args[0]).toBe("run");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args.join(" ")).toContain("--security-opt no-new-privileges");
    expect(args.join(" ")).toContain("--user 1000:1000");
    expect(args.join(" ")).toContain("--pids-limit 256");
    expect(args.join(" ")).toContain("--cpus 4");
    expect(args.join(" ")).toContain("--memory 4096m");
    expect(args.join(" ")).toContain("--tmpfs /tmp:rw,noexec,nosuid,size=256m");
    expect(args.join(" ")).toContain("--network bridge");
    expect(args.join(" ")).toContain("ai-harness.run-id=run-001");
    expect(args.slice(-4)).toEqual([
      "--entrypoint",
      "sleep",
      "harness/node:22",
      "infinity",
    ]);
  });

  it("uses network none when the profile forbids network", () => {
    const isolated = buildExecutionProfile({ name: "n", image: "img" });
    const args = buildDockerRunArgs({
      runId: "run-002",
      workspacePath: "/tmp/ws",
      profile: isolated,
      secrets: {},
    });
    expect(args.join(" ")).toContain("--network none");
  });

  it("injects only resolved secrets", () => {
    const args = buildDockerRunArgs({
      runId: "run-003",
      workspacePath: "/tmp/ws",
      profile,
      secrets: { GITHUB_TOKEN: "value" },
    });
    const envPairs = args.filter((_, index) => args[index - 1] === "--env");
    expect(envPairs).toContain("GITHUB_TOKEN=value");
    expect(envPairs).toContain("HOME=/home/agent");
  });
});

describe("EnvSecretStore", () => {
  const original = process.env.AI_SECRET_GITHUB_TOKEN;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.AI_SECRET_GITHUB_TOKEN;
    } else {
      process.env.AI_SECRET_GITHUB_TOKEN = original;
    }
  });

  it("resolves only known secret names", async () => {
    process.env.AI_SECRET_GITHUB_TOKEN = "token-123";
    const store = new EnvSecretStore();
    await expect(store.resolve(["GITHUB_TOKEN", "MISSING"])).resolves.toEqual({
      GITHUB_TOKEN: "token-123",
    });
  });
});
