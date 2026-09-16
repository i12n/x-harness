// TASK-910 / TASK-905 acceptance: real Docker isolation matrix.
//
// Requires a Linux + Docker host, a built execution image and explicit opt-in:
//
//   docker build -f docker/execution/Dockerfile \
//     --build-arg BASE_IMAGE=node:22-bookworm-slim --build-arg RUNTIME=node22 \
//     -t harness/execution:node22 .
//
//   AI_TEST_DOCKER=1 AI_EXECUTION_IMAGE=harness/execution:node22 \
//     npm run test:docker
//
// Optional: AI_TEST_CODEX=1 (real codex inside the container; needs
// AI_SECRET_OPENAI_API_KEY), AI_NETWORK_ENFORCEMENT=1 (TASK-905 spec).

import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngine } from "../src/agent/codexEngine.js";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import type { ExecutionProfile } from "../src/domain/executionProfile.js";
import {
  DockerExecutionDriver,
  ExecutionManager,
  type ExecutionDriver,
  type ExecutionEnvironment,
} from "../src/execution/manager.js";
import { Loop } from "../src/loop/loop.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryExecutionStore } from "../src/store/inMemoryExecutionStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { commitFile, createGitFixture, type GitFixture } from "./helpers/gitFixture.js";

const execFileAsync = promisify(execFile);
const dockerEnabled = process.env.AI_TEST_DOCKER === "1";
const image = process.env.AI_EXECUTION_IMAGE ?? "";
const describeDocker = dockerEnabled && image ? describe : describe.skip;
const networkEnabled =
  dockerEnabled && Boolean(image) && process.env.AI_NETWORK_ENFORCEMENT === "1";
const describeNetwork = networkEnabled ? describe : describe.skip;
const codexEnabled = dockerEnabled && Boolean(image) && process.env.AI_TEST_CODEX === "1";
const describeCodex = codexEnabled ? describe : describe.skip;

async function docker(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

async function containerGone(containerId: string | undefined): Promise<boolean> {
  if (!containerId) {
    return true;
  }
  const result = await docker(["inspect", "--format", "{{.Id}}", containerId]);
  return result.code !== 0;
}

async function labeledContainers(runId: string): Promise<string[]> {
  const result = await docker([
    "ps",
    "-a",
    "--filter",
    `label=ai-harness.run-id=${runId}`,
    "--format",
    "{{.ID}}",
  ]);
  return result.stdout.trim().split("\n").filter(Boolean);
}

/** Safety net: never leave labeled containers behind after a failed test. */
async function removeLabeledContainers(runId: string): Promise<void> {
  const ids = await labeledContainers(runId);
  if (ids.length > 0) {
    await docker(["rm", "-f", ...ids]);
  }
}

/** Runs a shell command inside the execution environment via driver exec. */
class ProbeEngine implements AgentEngine {
  constructor(private readonly shell: string) {}

  async execute(context: AgentContext): Promise<AgentResult> {
    const exec = context.execution?.exec;
    if (!exec) {
      throw new Error("probe engine requires execution.exec");
    }
    const startedAt = new Date().toISOString();
    const result = await exec(["sh", "-lc", this.shell], {
      cwd: context.execution?.workdir,
    });
    return {
      runId: context.runId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  async cancel(): Promise<void> {}
}

class FlakyCleanupDriver extends DockerExecutionDriver {
  private attempts = 0;

  async cleanup(environment: ExecutionEnvironment): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("flaky cleanup (intentional first failure)");
    }
    return super.cleanup(environment);
  }
}

interface SetupOptions {
  engine?: AgentEngine;
  driver?: ExecutionDriver;
  executionTimeoutMs?: number;
  networkMode?: "none" | "restricted";
}

describeDocker("TASK-910 lifecycle matrix (real Docker)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    for (const runId of [
      "run-001",
      "run-a",
      "run-b",
      "run-iso",
      "run-net-none",
      "run-net-restricted",
    ]) {
      await removeLabeledContainers(runId);
    }
  });

  async function setup(options: SetupOptions = {}) {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(
      fixture.path,
      "checks.sh",
      "test -f solution.txt && grep -qx 'avatar upload implemented' solution.txt && echo ok\n",
    );
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-docker-acceptance-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const profile: ExecutionProfile = buildExecutionProfile({
      name: "acceptance",
      image,
      workspace: "/workspace",
      network: { mode: options.networkMode ?? "none" },
      resources: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
    });
    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionStore();
    await repositories.createRepository({
      id: "repo-001",
      name: "acceptance",
      url: "git@github.com:example/acceptance.git",
      localPath: fixture.path,
      verificationCommands: ["sh checks.sh"],
      executionProfile: profile,
    });
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "docker acceptance",
      description: "d",
      acceptance: ["checks pass"],
      status: "READY",
      maxAttempts: 3,
    });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    const driver = options.driver ?? new DockerExecutionDriver({});
    const executionManager = new ExecutionManager({ driver, executions, events });
    const workspaceManager = new WorkspaceManager({ baseDir: workspaceBase });
    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager,
      agentEngine:
        options.engine ??
        new ProbeEngine("echo -n 'avatar upload implemented' > solution.txt"),
      verifier: new Verifier(),
      executionManager,
      eventStore: events,
      workerId: "worker-docker",
      heartbeatMs: 2_000,
      leaseSeconds: 180,
      executionTimeoutMs: options.executionTimeoutMs,
    });
    return {
      fixture,
      profile,
      repositories,
      tasks,
      runs,
      events,
      executions,
      executionManager,
      workspaceManager,
      worker,
    };
  }

  it("normal: SUCCEEDED -> CLEANED, container gone", async () => {
    const { runs, executions, worker } = await setup();

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(await containerGone(record?.containerId)).toBe(true);
    expect(await labeledContainers("run-001")).toEqual([]);
  }, 600_000);

  it("agent failure: FAILED -> CLEANED, container gone", async () => {
    const { runs, executions, worker } = await setup({
      engine: new ProbeEngine("echo boom >&2; exit 1"),
    });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(await containerGone(record?.containerId)).toBe(true);
  }, 600_000);

  it("verification failure: FAILED -> CLEANED, container gone", async () => {
    const { runs, executions, worker } = await setup({
      engine: new ProbeEngine("echo -n 'wrong content' > solution.txt"),
    });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("FAILED");
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(await containerGone(record?.containerId)).toBe(true);
  }, 600_000);

  it("container start failure: no leaked container", async () => {
    const { fixture, executions, executionManager } = await setup();
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-docker-startfail-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));
    const workspace = await new WorkspaceManager({ baseDir: workspaceBase }).createWorkspace({
      repositoryLocalPath: fixture.path,
      taskId: "task-001",
      runId: "run-001",
    });

    await expect(
      executionManager.prepare({
        runId: "run-001",
        workspacePath: workspace.path,
        profile: buildExecutionProfile({
          name: "acceptance",
          image: `${image}-does-not-exist`,
        }),
      }),
    ).rejects.toThrow();

    expect(await labeledContainers("run-001")).toEqual([]);
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe("CLEANED");
  }, 600_000);

  it("timeout: TIMED_OUT -> CLEANED, container gone", async () => {
    const { runs, executions, worker } = await setup({
      engine: new ProbeEngine("sleep 300"),
      executionTimeoutMs: 3_000,
    });

    await expect(worker.executeRun("run-001")).rejects.toThrow(/timed_out/);

    expect((await runs.findRun("run-001")).status).toBe("TIMED_OUT");
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(await containerGone(record?.containerId)).toBe(true);
  }, 600_000);

  it("cancel: CANCELLED -> CLEANED, container gone", async () => {
    const { runs, executions, worker } = await setup({
      engine: new ProbeEngine("sleep 300"),
    });
    const controller = new AbortController();

    const promise = worker.executeRun("run-001", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    controller.abort();

    await expect(promise).rejects.toThrow(/cancelled/);
    expect((await runs.findRun("run-001")).status).toBe("CANCELLED");
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(await containerGone(record?.containerId)).toBe(true);
  }, 600_000);

  it("worker crash / LOST: execution is cleaned by the loop", async () => {
    const {
      fixture,
      tasks,
      runs,
      events,
      executions,
      executionManager,
      workspaceManager,
      worker,
    } = await setup();
    const workspace = await workspaceManager.createWorkspace({
      repositoryLocalPath: fixture.path,
      taskId: "task-001",
      runId: "run-001",
    });
    await executionManager.prepare({
      runId: "run-001",
      workspacePath: workspace.path,
      profile: buildExecutionProfile({ name: "acceptance", image }),
    });
    await runs.claimRun("run-001", "worker-dead", "2000-01-01T00:00:00.000Z");
    await runs.markRunning("run-001", "2000-01-01T00:00:00.000Z");
    await tasks.updateTaskStatus("task-001", "RUNNING");

    const loop = new Loop({
      scheduler: new Scheduler({ taskStore: tasks, runStore: runs }),
      worker,
      runStore: runs,
      taskStore: tasks,
      eventStore: events,
      executions,
      executionManager,
      maxConcurrency: 1,
    });
    const report = await loop.tick();

    expect(report.recovered.map((run) => run.id)).toEqual(["run-001"]);
    expect((await runs.findRun("run-001")).status).toBe("LOST");
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(await containerGone(record?.containerId)).toBe(true);
    expect(await labeledContainers("run-001")).toEqual([]);
  }, 600_000);

  it("cleanup failure: CLEANUP_FAILED -> retried -> CLEANED", async () => {
    const {
      fixture,
      tasks,
      runs,
      events,
      executions,
      executionManager,
      workspaceManager,
      worker,
    } = await setup({ driver: new FlakyCleanupDriver({}) });
    const workspace = await workspaceManager.createWorkspace({
      repositoryLocalPath: fixture.path,
      taskId: "task-001",
      runId: "run-001",
    });
    await executionManager.prepare({
      runId: "run-001",
      workspacePath: workspace.path,
      profile: buildExecutionProfile({ name: "acceptance", image }),
    });
    await runs.claimRun("run-001", "worker-dead", "2000-01-01T00:00:00.000Z");
    await runs.markRunning("run-001", "2000-01-01T00:00:00.000Z");
    await tasks.updateTaskStatus("task-001", "RUNNING");

    const loop = new Loop({
      scheduler: new Scheduler({ taskStore: tasks, runStore: runs }),
      worker,
      runStore: runs,
      taskStore: tasks,
      eventStore: events,
      executions,
      executionManager,
      maxConcurrency: 1,
    });
    await loop.tick();
    expect((await executions.findLatestByRunId("run-001"))?.status).toBe(
      "CLEANUP_FAILED",
    );

    await loop.tick();
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(await containerGone(record?.containerId)).toBe(true);
  }, 600_000);
});

describeDocker("TASK-910 filesystem / privilege isolation", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("runs the isolation probe inside the container", async () => {
    const fixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-docker-iso-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));
    const workspaceManager = new WorkspaceManager({ baseDir: workspaceBase });
    const workspace = await workspaceManager.createWorkspace({
      repositoryLocalPath: fixture.path,
      taskId: "task-001",
      runId: "run-iso",
    });
    copyFileSync("scripts/isolation-probe.sh", join(workspace.path, ".isolation-probe.sh"));

    const profile = buildExecutionProfile({
      name: "acceptance",
      image,
      network: { mode: "none" },
      resources: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
    });
    const executions = new InMemoryExecutionStore();
    const manager = new ExecutionManager({
      driver: new DockerExecutionDriver({}),
      executions,
      events: new InMemoryEventStore(),
    });
    const environment = await manager.prepare({
      runId: "run-iso",
      workspacePath: workspace.path,
      profile,
    });
    try {
      const probe = await manager.exec(environment, [
        "sh",
        "/workspace/.isolation-probe.sh",
      ]);
      expect(probe.stdout + probe.stderr).toContain("ISOLATION PROBE PASSED");
      expect(probe.exitCode).toBe(0);
    } finally {
      await manager.cleanup(environment);
    }
  }, 600_000);

  it("keeps run workspaces invisible to each other", async () => {
    const fixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-docker-iso-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));
    const workspaceManager = new WorkspaceManager({ baseDir: workspaceBase });
    const [workspaceA, workspaceB] = await Promise.all([
      workspaceManager.createWorkspace({
        repositoryLocalPath: fixture.path,
        taskId: "task-a",
        runId: "run-a",
      }),
      workspaceManager.createWorkspace({
        repositoryLocalPath: fixture.path,
        taskId: "task-b",
        runId: "run-b",
      }),
    ]);
    writeFileSync(join(workspaceA.path, "marker-a.txt"), "a");

    const executions = new InMemoryExecutionStore();
    const manager = new ExecutionManager({
      driver: new DockerExecutionDriver({}),
      executions,
      events: new InMemoryEventStore(),
    });
    const environmentA = await manager.prepare({
      runId: "run-a",
      workspacePath: workspaceA.path,
      profile: buildExecutionProfile({ name: "acceptance", image }),
    });
    const environmentB = await manager.prepare({
      runId: "run-b",
      workspacePath: workspaceB.path,
      profile: buildExecutionProfile({ name: "acceptance", image }),
    });
    try {
      const seesOwn = await manager.exec(environmentA, [
        "sh",
        "-lc",
        "test -f /workspace/marker-a.txt",
      ]);
      expect(seesOwn.exitCode).toBe(0);

      const seesOther = await manager.exec(environmentB, [
        "sh",
        "-lc",
        `test -e '${join(workspaceA.path, "marker-a.txt")}'`,
      ]);
      expect(seesOther.exitCode).not.toBe(0);
    } finally {
      await manager.cleanup(environmentA);
      await manager.cleanup(environmentB);
    }
  }, 600_000);
});

describeNetwork("TASK-905 network enforcement spec (real Docker)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  const fetchProbe = (url: string): string =>
    `node -e "fetch('${url}',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0)).catch(()=>process.exit(7))"`;

  it("network:none really blocks egress", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-net-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const manager = new ExecutionManager({
      driver: new DockerExecutionDriver({}),
      executions: new InMemoryExecutionStore(),
      events: new InMemoryEventStore(),
    });
    const environment = await manager.prepare({
      runId: "run-net-none",
      workspacePath: workspace,
      profile: buildExecutionProfile({
        name: "acceptance",
        image,
        network: { mode: "none" },
      }),
    });
    try {
      const result = await manager.exec(environment, [
        "sh",
        "-lc",
        fetchProbe("https://example.com"),
      ]);
      expect(result.exitCode).toBe(7);
    } finally {
      await manager.cleanup(environment);
    }
  }, 600_000);

  it("restricted: allow-list, forbidden host, direct IP", async () => {
    const allowed = process.env.AI_NETWORK_ALLOWED_HOST ?? "registry.npmjs.org";
    const forbidden = process.env.AI_NETWORK_FORBIDDEN_HOST ?? "example.com";
    const workspace = mkdtempSync(join(tmpdir(), "ai-net-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const manager = new ExecutionManager({
      driver: new DockerExecutionDriver({}),
      executions: new InMemoryExecutionStore(),
      events: new InMemoryEventStore(),
    });
    const environment = await manager.prepare({
      runId: "run-net-restricted",
      workspacePath: workspace,
      profile: buildExecutionProfile({
        name: "acceptance",
        image,
        network: { mode: "restricted", allow: [allowed] },
      }),
    });
    try {
      const allowedResult = await manager.exec(environment, [
        "sh",
        "-lc",
        fetchProbe(`https://${allowed}`),
      ]);
      expect(allowedResult.exitCode).toBe(0);

      const forbiddenResult = await manager.exec(environment, [
        "sh",
        "-lc",
        fetchProbe(`https://${forbidden}`),
      ]);
      expect(forbiddenResult.exitCode).toBe(7);

      const directIp = await manager.exec(environment, [
        "sh",
        "-lc",
        fetchProbe("http://1.1.1.1"),
      ]);
      expect(directIp.exitCode).toBe(7);
    } finally {
      await manager.cleanup(environment);
    }
  }, 600_000);
});

describeCodex("TASK-910 real codex inside the container", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("drives codex -> verification -> CLEANED inside Docker", async () => {
    const fixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(
      fixture.path,
      "checks.sh",
      "test -f solution.txt && grep -qx 'avatar upload implemented' solution.txt && echo ok\n",
    );
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-docker-codex-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const profile = buildExecutionProfile({
      name: "acceptance",
      image,
      network: { mode: "restricted", allow: ["api.openai.com", "chatgpt.com"] },
      secrets: ["OPENAI_API_KEY"],
    });
    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionStore();
    await repositories.createRepository({
      id: "repo-001",
      name: "acceptance",
      url: "git@github.com:example/acceptance.git",
      localPath: fixture.path,
      verificationCommands: ["sh checks.sh"],
      executionProfile: profile,
    });
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "Add user avatar",
      description:
        "Create a file named solution.txt in the repository root whose content is exactly " +
        "'avatar upload implemented'. Do not modify any other file.",
      acceptance: ["checks pass"],
      status: "READY",
      maxAttempts: 1,
    });
    await runs.createRun({
      id: "run-001",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    const executionManager = new ExecutionManager({
      driver: new DockerExecutionDriver({}),
      executions,
      events,
    });
    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      agentEngine: new CodexEngine(),
      verifier: new Verifier(),
      executionManager,
      eventStore: events,
      workerId: "worker-docker-codex",
      heartbeatMs: 5_000,
      leaseSeconds: 600,
    });

    const outcome = await worker.executeRun("run-001");

    expect(outcome.run.status).toBe("SUCCEEDED");
    const record = await executions.findLatestByRunId("run-001");
    expect(record?.status).toBe("CLEANED");
    expect(await containerGone(record?.containerId)).toBe(true);
  }, 1_800_000);
});
