import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import {
  DockerExecutionDriver,
  ExecutionManager,
  LocalExecutionDriver,
} from "../src/execution/manager.js";

const profile = buildExecutionProfile({
  name: "node",
  image: "harness/node:22",
  secrets: ["GITHUB_TOKEN"],
});

describe("ExecutionManager", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("runs the lifecycle with the local driver", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-exec-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const manager = new ExecutionManager(new LocalExecutionDriver());

    const environment = await manager.prepare({
      runId: "run-001",
      workspacePath: workspace,
      profile,
    });

    expect(environment.workspacePath).toBe(workspace);
    expect(environment.containerId).toBeUndefined();
    expect(environment.startedAt).toBeDefined();
    await expect(manager.cleanup(environment)).resolves.toBeUndefined();
  });

  it("drives docker run/rm through the driver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-fake-docker-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const logPath = join(dir, "docker.log");
    const scriptPath = join(dir, "fake-docker");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\necho "$@" >> "${logPath}"\necho fake-container-123\n`,
    );
    chmodSync(scriptPath, 0o755);

    const driver = new DockerExecutionDriver({
      dockerBinary: scriptPath,
      secretStore: { resolve: async () => ({ GITHUB_TOKEN: "token-123" }) },
    });
    const manager = new ExecutionManager(driver);
    const environment = await manager.prepare({
      runId: "run-001",
      workspacePath: dir,
      profile,
    });

    expect(environment.containerId).toBe("fake-container-123");
    await manager.cleanup(environment);

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines[0]).toContain("run --detach");
    expect(lines[0]).toContain("GITHUB_TOKEN=token-123");
    expect(lines[0]).toContain(`type=bind,src=${dir},dst=/workspace,rw`);
    expect(lines[1]).toBe("rm -f fake-container-123");
  });
});
