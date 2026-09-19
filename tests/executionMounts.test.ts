import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import { buildDockerRunArgs } from "../src/execution/dockerArgs.js";
import {
  DockerExecutionDriver,
  LocalExecutionDriver,
  toExecutionContext,
  type ExecutionEnvironment,
} from "../src/execution/manager.js";
import {
  normalizeExecutionMounts,
  validateExecutionMounts,
  type ExecutionMount,
} from "../src/execution/mounts.js";
import { ValidationError } from "../src/errors.js";

describe("Execution mounts (TASK-1006)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  describe("normalization and validation", () => {
    it("keeps the legacy single-workspace shape working", () => {
      const mounts = normalizeExecutionMounts({ workspacePath: "/host/ws" });
      expect(mounts).toEqual([
        {
          targetId: "primary",
          source: resolve("/host/ws"),
          target: "/workspace",
          primary: true,
        },
      ]);
    });

    it("accepts explicit mounts with one primary at /workspace", () => {
      const mounts: ExecutionMount[] = [
        { targetId: "t-a", source: "/host/a", target: "/workspace", primary: true },
        { targetId: "t-b", source: "/host/b", target: "/workspaces/t-b" },
      ];
      expect(() => validateExecutionMounts(mounts)).not.toThrow();
    });

    it("rejects container targets outside /workspace and /workspaces", () => {
      expect(() =>
        validateExecutionMounts([
          { targetId: "t-a", source: "/host/a", target: "/data", primary: true },
        ]),
      ).toThrow(ValidationError);
    });

    it("rejects duplicate targetIds and duplicate container targets", () => {
      expect(() =>
        validateExecutionMounts([
          { targetId: "t-a", source: "/host/a", target: "/workspace", primary: true },
          { targetId: "t-a", source: "/host/b", target: "/workspaces/b" },
        ]),
      ).toThrow(/duplicate mount targetId/);

      expect(() =>
        validateExecutionMounts([
          { targetId: "t-a", source: "/host/a", target: "/workspace", primary: true },
          { targetId: "t-b", source: "/host/b", target: "/workspace" },
        ]),
      ).toThrow(/duplicate container target/);
    });

    it("requires exactly one primary mapped to /workspace", () => {
      expect(() =>
        validateExecutionMounts([
          { targetId: "t-a", source: "/host/a", target: "/workspaces/a" },
        ]),
      ).toThrow(/exactly one primary/);

      expect(() =>
        validateExecutionMounts([
          { targetId: "t-a", source: "/host/a", target: "/workspaces/a", primary: true },
        ]),
      ).toThrow(/primary mount must map to \/workspace/);
    });

    it("rejects sources outside the allowed workspace roots", () => {
      const mounts: ExecutionMount[] = [
        { targetId: "t-a", source: "/etc/passwd", target: "/workspace", primary: true },
      ];
      expect(() =>
        validateExecutionMounts(mounts, { allowedSourceRoots: ["/srv/harness/runs"] }),
      ).toThrow(/outside the allowed workspace roots/);
    });

    it("checks primaryTargetId against the primary mount", () => {
      const mounts: ExecutionMount[] = [
        { targetId: "t-a", source: "/host/a", target: "/workspace", primary: true },
        { targetId: "t-b", source: "/host/b", target: "/workspaces/t-b" },
      ];
      expect(() =>
        validateExecutionMounts(mounts, { primaryTargetId: "t-b" }),
      ).toThrow(/primaryTargetId/);
      expect(() =>
        validateExecutionMounts(mounts, { primaryTargetId: "t-a" }),
      ).not.toThrow();
    });
  });

  it("renders one --mount per workspace, primary to /workspace", () => {
    const profile = defaultExecutionProfile();
    const args = buildDockerRunArgs({
      runId: "run-001",
      workspacePath: "/host/primary",
      profile,
      secrets: {},
      mounts: [
        { targetId: "t-a", source: "/host/a", target: "/workspace", primary: true },
        {
          targetId: "t-b",
          source: "/host/b",
          target: "/workspaces/t-b",
          readOnly: true,
        },
      ],
    });
    const mounts = args.filter((_, index) => args[index - 1] === "--mount");
    expect(mounts).toEqual([
      "type=bind,src=/host/a,dst=/workspace",
      "type=bind,src=/host/b,dst=/workspaces/t-b,readonly",
    ]);
  });

  it("exposes workdirs with workdir = primary (legacy) ", () => {
    const environment: ExecutionEnvironment = {
      id: "exec-1",
      runId: "run-001",
      workspacePath: "/host/a",
      containerWorkspace: "/workspace",
      profile: defaultExecutionProfile(),
      driver: "docker",
      primaryTargetId: "t-a",
      mounts: [
        { targetId: "t-a", source: "/host/a", target: "/workspace", primary: true },
        { targetId: "t-b", source: "/host/b", target: "/workspaces/t-b" },
      ],
    };

    const context = toExecutionContext(environment);
    expect(context.workdir).toBe("/workspace");
    expect(context.primaryTargetId).toBe("t-a");
    expect(context.workdirs).toEqual({
      "t-a": "/workspace",
      "t-b": "/workspaces/t-b",
    });
  });

  it("runs commands in each local workspace through one execution", async () => {
    const workspaceA = tempDir("ai-mount-a-");
    const workspaceB = tempDir("ai-mount-b-");
    const driver = new LocalExecutionDriver();
    const environment = await driver.start(
      await driver.create({
        runId: "run-001",
        profile: defaultExecutionProfile(),
        mounts: [
          { targetId: "t-a", source: workspaceA, target: "/workspace", primary: true },
          { targetId: "t-b", source: workspaceB, target: "/workspaces/t-b" },
        ],
      }),
    );

    const context = toExecutionContext(environment);
    expect(realpathSync(context.workdirs!["t-a"]!)).toBe(realpathSync(workspaceA));
    expect(realpathSync(context.workdirs!["t-b"]!)).toBe(realpathSync(workspaceB));

    const node = process.execPath;
    const primary = await driver.exec(environment, [node, "-e", "console.log(process.cwd())"]);
    expect(realpathSync(primary.stdout.trim())).toBe(realpathSync(workspaceA));
    const supporting = await driver.exec(
      environment,
      [node, "-e", "console.log(process.cwd())"],
      { cwd: context.workdirs?.["t-b"] },
    );
    expect(realpathSync(supporting.stdout.trim())).toBe(realpathSync(workspaceB));
  });

  it("keeps the Docker driver free of primary/supporting business logic", async () => {
    const driver = new DockerExecutionDriver({ workspaceRoots: ["/srv/harness/runs"] });
    const environment = await driver.create({
      runId: "run-002",
      profile: defaultExecutionProfile(),
      mounts: [
        { targetId: "t-a", source: "/srv/harness/runs/a", target: "/workspace", primary: true },
        { targetId: "t-b", source: "/srv/harness/runs/b", target: "/workspaces/t-b" },
      ],
    });

    expect(environment.workspacePath).toBe("/srv/harness/runs/a");
    expect(environment.containerWorkspace).toBe("/workspace");
    expect(environment.mounts?.map((mount) => mount.targetId)).toEqual(["t-a", "t-b"]);
    expect(environment.primaryTargetId).toBe("t-a");
  });
});
