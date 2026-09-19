import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { renderRunMessage } from "../src/channel/rendering/run.js";
import { renderTaskMessage } from "../src/channel/rendering/task.js";
import {
  CommandDispatcher,
  InMemoryIdempotencyStore,
  ScriptedIntentEngine,
  handleIntent,
  type AuthorizationContext,
  type IntentInput,
} from "../src/command/index.js";
import { createTaskRunCommandHandlers } from "../src/command/handlers/taskRun.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import { RUN_STATUSES } from "../src/domain/run.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
} from "../src/execution/manager.js";
import { Loop } from "../src/loop/loop.js";
import { RunService } from "../src/run/application/runService.js";
import { TaskRunService } from "../src/run/application/taskRunService.js";
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

class ProbeEngine implements AgentEngine {
  calls = 0;
  constructor(public contents: (string | undefined)[]) {}
  async execute(context: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    const exec = context.execution?.exec!;
    const workdirs = Object.values(context.execution?.workdirs ?? {});
    for (let index = 0; index < workdirs.length; index += 1) {
      const content = this.contents[index];
      if (content) {
        await exec(["sh", "-lc", `printf '%s' '${content}' > solution.txt`], {
          cwd: workdirs[index],
        });
      }
    }
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: "probe",
      stderr: "",
      startedAt: now,
      finishedAt: now,
    };
  }
  async cancel(): Promise<void> {}
}

class SlowEngine implements AgentEngine {
  private pending?: (result: AgentResult) => void;
  async execute(context: AgentContext): Promise<AgentResult> {
    void context;
    return new Promise<AgentResult>((resolve) => {
      this.pending = resolve;
    });
  }
  async cancel(): Promise<void> {
    const resolve = this.pending;
    this.pending = undefined;
    const now = new Date().toISOString();
    resolve?.({
      runId: "slow",
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      startedAt: now,
      finishedAt: now,
    });
  }
}

function intentMessage(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    channel: "feishu",
    conversationId: "conv-001",
    messageId: "message-001",
    senderId: "ou_user_1",
    text: "do it",
    ...overrides,
  };
}

function context(roles: AuthorizationContext["roles"]): AuthorizationContext {
  return { channel: "feishu", userId: "ou_user_1", roles };
}

describe("Task / Run operations (TASK-1108)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function fixture(expected = "A-OK"): GitFixture {
    const created = createGitFixture();
    cleanups.push(created.cleanup);
    commitFile(
      created.path,
      "check.sh",
      `test -f solution.txt && grep -qx '${expected}' solution.txt && echo ok\n`,
    );
    return created;
  }

  async function setup(options: {
    engine?: AgentEngine;
    multiRepository?: boolean;
    heartbeatMs?: number;
  } = {}) {
    const fixtureA = fixture("A-OK");
    const fixtureB = options.multiRepository ? fixture("B-OK") : undefined;
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-taskrun-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionStore();
    await repositories.createRepository({
      id: "repo-a",
      name: "rehelu",
      url: "git@github.com:example/rehelu.git",
      localPath: fixtureA.path,
      verificationCommands: ["sh check.sh"],
      executionProfile: defaultExecutionProfile(),
    });
    if (fixtureB) {
      await repositories.createRepository({
        id: "repo-b",
        name: "auth",
        url: "git@github.com:example/auth.git",
        localPath: fixtureB.path,
        verificationCommands: ["sh check.sh"],
        executionProfile: defaultExecutionProfile(),
      });
    }
    await tasks.createTask({
      id: "task-001",
      title: "Add avatar",
      description: "d",
      status: "READY",
      acceptance: ["check passes"],
      targets: [
        { id: "tgt-a", taskId: "task-001", repositoryId: "repo-a", role: "primary", position: 0 },
        ...(fixtureB
          ? [
              {
                id: "tgt-b",
                taskId: "task-001",
                repositoryId: "repo-b",
                role: "supporting" as const,
                position: 1,
              },
            ]
          : []),
      ],
    });

    const workspaceManager = new WorkspaceManager({ baseDir: workspaceBase });
    const executionManager = new ExecutionManager({
      driver: new LocalExecutionDriver(),
      executions,
      events,
    });
    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager,
      agentEngine: options.engine ?? new ProbeEngine(["A-OK", "B-OK"]),
      verifier: new Verifier(),
      executionManager,
      eventStore: events,
      workerId: "worker-1108",
      heartbeatMs: options.heartbeatMs ?? 50,
      leaseSeconds: 5,
    });
    const runService = new RunService({ runs, tasks, events });
    const taskRunService = new TaskRunService({ tasks, runs, worker });
    const dispatcher = new CommandDispatcher({
      handlers: createTaskRunCommandHandlers({ taskRun: taskRunService, runs: runService }),
      idempotency: new InMemoryIdempotencyStore(),
    });
    return {
      fixtureA,
      fixtureB,
      workspaceBase,
      workspaceManager,
      executionManager,
      repositories,
      tasks,
      runs,
      events,
      executions,
      worker,
      runService,
      taskRunService,
      dispatcher,
    };
  }

  it("task.show returns the task and its latest run", async () => {
    const { dispatcher } = await setup();
    const engine = new ScriptedIntentEngine({
      command: { type: "task.show", payload: { taskId: "task-001" } },
    });

    const result = await handleIntent(intentMessage(), context(["guest"]), {
      engine,
      dispatcher,
    });

    expect(result.status).toBe("succeeded");
    const data = result.data as { task: { id: string }; latestRun: unknown };
    expect(data.task.id).toBe("task-001");
    expect(data.latestRun).toBeNull();
  });

  it("task.run executes through the existing Worker", async () => {
    const { dispatcher, tasks, runs } = await setup();
    const engine = new ScriptedIntentEngine({
      command: { type: "task.run", payload: { taskId: "task-001" } },
    });

    const result = await handleIntent(intentMessage(), context(["developer"]), {
      engine,
      dispatcher,
    });

    expect(result.status).toBe("succeeded");
    const data = result.data as { runId: string; run: { status: string } };
    expect(data.run.status).toBe("SUCCEEDED");
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");
    const run = await runs.findRun(data.runId);
    const rendered = JSON.stringify(renderRunMessage(run).blocks);
    expect(rendered).toContain("✓ rehelu (primary)");
    expect(rendered).toContain("Verification: PASS");
  });

  it("renders multi-repository tasks and runs", async () => {
    const { dispatcher, runs } = await setup({ multiRepository: true });
    const shown = await handleIntent(
      intentMessage(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "task.show", payload: { taskId: "task-001" } },
        }),
        dispatcher,
      },
    );
    const task = (shown.data as { task: Parameters<typeof renderTaskMessage>[0] }).task;
    const taskText = JSON.stringify(renderTaskMessage(task).blocks);
    expect(taskText).toContain("(repo-a)");
    expect(taskText).toContain("(repo-b)");

    const ran = await handleIntent(
      intentMessage({ messageId: "message-002" }),
      context(["developer"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "task.run", payload: { taskId: "task-001" } },
        }),
        dispatcher,
      },
    );
    const run = await runs.findRun((ran.data as { runId: string }).runId);
    const runText = JSON.stringify(renderRunMessage(run).blocks);
    expect(runText).toContain("✓ rehelu (primary)");
    expect(runText).toContain("✓ auth (supporting)");
  });

  it("run.show renders a failed run with the failing target", async () => {
    const { dispatcher, runs } = await setup({
      engine: new ProbeEngine(["A-OK", undefined]),
      multiRepository: true,
    });
    const ran = await handleIntent(
      intentMessage(),
      context(["developer"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "task.run", payload: { taskId: "task-001" } },
        }),
        dispatcher,
      },
    );
    const runId = (ran.data as { runId: string }).runId;

    const shown = await handleIntent(
      intentMessage({ messageId: "message-002" }),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "run.show", payload: { runId } },
        }),
        dispatcher,
      },
    );

    const run = (shown.data as { run: { status: string } }).run;
    expect(run.status).toBe("FAILED");
    const rendered = JSON.stringify(renderRunMessage(await runs.findRun(runId)).blocks);
    expect(rendered).toContain("✗ auth (supporting)");
  });

  it("cancels a QUEUED run synchronously", async () => {
    const { dispatcher, runs, tasks } = await setup();
    await runs.createRun({
      id: "run-queued",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const result = await handleIntent(
      intentMessage(),
      context(["developer"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "run.cancel", payload: { runId: "run-queued" } },
        }),
        dispatcher,
      },
    );

    expect(result.status).toBe("succeeded");
    expect((result.data as { cancelStatus: string }).cancelStatus).toBe("cancelled");
    expect((await runs.findRun("run-queued")).status).toBe("CANCELLED");
    expect((await tasks.findTask("task-001")).status).toBe("READY");
  });

  it("persists a cancel request for a RUNNING run and is idempotent", async () => {
    const { dispatcher, runs, events } = await setup();
    await runs.createRun({
      id: "run-running",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await runs.claimRun("run-running", "worker-x", "2099-01-01T00:00:00.000Z");
    await runs.markRunning("run-running");
    const command = {
      type: "run.cancel",
      payload: { runId: "run-running" },
    };

    const first = await handleIntent(intentMessage(), context(["developer"]), {
      engine: new ScriptedIntentEngine({ command }),
      dispatcher,
    });
    const retry = await handleIntent(intentMessage(), context(["developer"]), {
      engine: new ScriptedIntentEngine({ command }),
      dispatcher,
    });

    expect(first).toMatchObject({ status: "succeeded" });
    expect(first.data).toMatchObject({ cancelStatus: "accepted", alreadyRequested: false });
    expect(retry).toMatchObject({ status: "succeeded", replayed: true });

    const run = await runs.findRun("run-running");
    expect(run.status).toBe("RUNNING");
    expect(run.cancelRequestedAt).toBeDefined();
    const audit = await events.listEvents({ runId: "run-running", type: "run.cancel_requested" });
    expect(audit).toHaveLength(1);
  });

  it("rejects cancelling a terminal run", async () => {
    const { dispatcher, runs } = await setup();
    await runs.createRun({
      id: "run-done",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await runs.claimRun("run-done", "worker-x", "2099-01-01T00:00:00.000Z");
    await runs.markRunning("run-done");
    await runs.completeRun("run-done", { status: "SUCCEEDED", exitCode: 0 });

    const result = await handleIntent(intentMessage(), context(["developer"]), {
      engine: new ScriptedIntentEngine({
        command: { type: "run.cancel", payload: { runId: "run-done" } },
      }),
      dispatcher,
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "run_not_cancellable" },
    });
    expect((await runs.findRun("run-done")).status).toBe("SUCCEEDED");
  });

  it("lets a running worker consume a persisted cancel request", async () => {
    const { dispatcher, runs, executions, worker } = await setup({
      engine: new SlowEngine(),
      heartbeatMs: 25,
    });
    const run = await runs.createRun({
      id: "run-cancel-me",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const executing = worker.executeRun(run.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancel = await handleIntent(intentMessage(), context(["developer"]), {
      engine: new ScriptedIntentEngine({
        command: { type: "run.cancel", payload: { runId: run.id } },
      }),
      dispatcher,
    });
    expect(cancel.status).toBe("succeeded");

    await expect(executing).rejects.toThrow(/cancelled/);
    expect((await runs.findRun(run.id)).status).toBe("CANCELLED");
    expect((await executions.findLatestByRunId(run.id))?.status).toBe("CLEANED");
  }, 20_000);

  it("cancels a RUNNING run written by another process (Loop reconcile)", async () => {
    const {
      fixtureA,
      runs,
      tasks,
      events,
      executions,
      executionManager,
      workspaceManager,
      repositories,
      worker,
    } = await setup({ engine: new ProbeEngine([undefined]) });
    const workspaces = await workspaceManager.createRunWorkspaces({
      taskId: "task-001",
      runId: "run-remote",
      targets: [
        { targetId: "tgt-a", repositoryLocalPath: fixtureA.path, position: 0 },
      ],
    });
    await executionManager.prepare({
      runId: "run-remote",
      profile: defaultExecutionProfile(),
      mounts: [
        {
          targetId: "tgt-a",
          source: workspaces[0]!.path,
          target: "/workspace",
          primary: true,
        },
      ],
      primaryTargetId: "tgt-a",
    });
    await runs.createRun({
      id: "run-remote",
      taskId: "task-001",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await runs.claimRun("run-remote", "dead-worker", "2099-01-01T00:00:00.000Z");
    await runs.markRunning("run-remote");
    await tasks.updateTaskStatus("task-001", "RUNNING");
    // Another process persists the cancel intent; this Loop never sees a signal.
    await runs.requestCancel("run-remote", "feishu:ou_user_1");

    const loop = new Loop({
      scheduler: new Scheduler({ taskStore: tasks, runStore: runs }),
      worker,
      runStore: runs,
      taskStore: tasks,
      eventStore: events,
      executions,
      executionManager,
      repositories,
      workspaceManager,
      maxConcurrency: 1,
    });
    const report = await loop.tick();

    expect(report.cancelled.map((run) => run.id)).toEqual(["run-remote"]);
    expect((await runs.findRun("run-remote")).status).toBe("CANCELLED");
    expect((await executions.findLatestByRunId("run-remote"))?.status).toBe("CLEANED");
    for (const workspace of workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    expect((await tasks.findTask("task-001")).status).toBe("READY");
  });

  it("keeps cancellation out of RunStatus", () => {
    expect(RUN_STATUSES as readonly string[]).not.toContain("CANCELLING");
    expect(RUN_STATUSES as readonly string[]).not.toContain("CANCEL_REQUESTED");
  });
});
