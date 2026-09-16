import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import { buildDockerExecArgs } from "../src/execution/dockerArgs.js";
import {
  DockerExecutionDriver,
  LocalExecutionDriver,
} from "../src/execution/manager.js";

describe("ExecutionDriver.exec (TASK-912)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function localEnvironment() {
    const workspace = mkdtempSync(join(tmpdir(), "ai-exec-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const driver = new LocalExecutionDriver();
    const environment = await driver.start(
      await driver.create({
        runId: "run-001",
        workspacePath: workspace,
        profile: defaultExecutionProfile(),
      }),
    );
    return { driver, environment };
  }

  it("runs commands locally and captures exit code/output", async () => {
    const { driver, environment } = await localEnvironment();

    const ok = await driver.exec(environment, [
      process.execPath,
      "-e",
      "console.log('ok')",
    ]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe("ok");

    const failed = await driver.exec(environment, [
      process.execPath,
      "-e",
      "process.exit(3)",
    ]);
    expect(failed.exitCode).toBe(3);
  });

  it("passes stdin and enforces the timeout", async () => {
    const { driver, environment } = await localEnvironment();

    const echoed = await driver.exec(
      environment,
      [
        process.execPath,
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log('in:'+d))",
      ],
      { stdin: "hello" },
    );
    expect(echoed.stdout.trim()).toBe("in:hello");

    const timedOut = await driver.exec(
      environment,
      [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      { timeoutMs: 200 },
    );
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).not.toBe(0);
  });

  it("builds docker exec args scoped to the container", () => {
    const args = buildDockerExecArgs({
      containerId: "ai-harness-run-001",
      command: ["codex", "exec", "--json", "-"],
      cwd: "/workspace",
      env: { HOME: "/home/agent" },
    });
    expect(args).toEqual([
      "exec",
      "--interactive",
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/home/agent",
      "ai-harness-run-001",
      "codex",
      "exec",
      "--json",
      "-",
    ]);
  });

  it("refuses docker exec without a container", async () => {
    const driver = new DockerExecutionDriver({ dockerBinary: "false" });
    const environment = await driver.create({
      runId: "run-001",
      workspacePath: "/tmp/ws",
      profile: defaultExecutionProfile(),
    });
    await expect(driver.exec(environment, ["echo", "hi"])).rejects.toThrow(
      /requires a running container/,
    );
  });
});
