import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../../../src/agent/types.js";
import { DeliveryReconciler } from "../../../src/delivery/application/reconciler.js";
import { DeliveryService } from "../../../src/delivery/application/service.js";
import { RecordingDeliveryNotifier } from "../../../src/delivery/application/notifier.js";
import { defaultExecutionProfile } from "../../../src/domain/executionProfile.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
} from "../../../src/execution/manager.js";
import { Loop } from "../../../src/loop/loop.js";
import { ReviewService } from "../../../src/review/application/reviewService.js";
import { Scheduler } from "../../../src/scheduler/scheduler.js";
import { DeterministicTaskPlanner } from "../../../src/specification/application/planner.js";
import { PlanningService } from "../../../src/specification/application/planning.js";
import { SpecificationService } from "../../../src/specification/application/service.js";
import { TaskDependencyService } from "../../../src/task/application/dependencyService.js";
import { InMemoryDeliveryStore } from "../../../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../../../src/store/inMemoryEventStore.js";
import { InMemoryExecutionStore } from "../../../src/store/inMemoryExecutionStore.js";
import { InMemoryProblemStore } from "../../../src/store/inMemoryProblemStore.js";
import { InMemoryRepositoryStore } from "../../../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../../../src/store/inMemoryRunStore.js";
import { InMemorySpecificationPlanStore } from "../../../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../../../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskDependencyStore } from "../../../src/store/inMemoryTaskDependencyStore.js";
import { InMemoryTaskStore } from "../../../src/store/inMemoryTaskStore.js";
import { Verifier } from "../../../src/verification/runner.js";
import { Worker } from "../../../src/worker/worker.js";
import { WorkspaceManager } from "../../../src/workspace/manager.js";
import { commitFile, createGitFixture, type GitFixture } from "../../helpers/gitFixture.js";

/**
 * Fails verification for the first `failures` attempts (writes the wrong
 * content), then succeeds — the deterministic stand-in for a developer who
 * breaks tests and then fixes them.
 */
class FlakyEngine implements AgentEngine {
  attempts = 0;

  constructor(private readonly failures: number) {}

  async execute(context: AgentContext): Promise<AgentResult> {
    this.attempts += 1;
    const exec = context.execution?.exec;
    if (!exec) {
      throw new Error("flaky agent requires execution.exec");
    }
    const content = this.attempts <= this.failures ? "broken" : "done";
    for (const workdir of Object.values(context.execution?.workdirs ?? {})) {
      await exec(["sh", "-lc", `printf '%s' '${content}' > solution.txt`], {
        cwd: workdir,
      });
    }
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: `attempt ${this.attempts}`,
      stderr: "",
      startedAt: now,
      finishedAt: now,
    };
  }

  async cancel(): Promise<void> {}
}

describe("Phase 12 E2E — failure, retry and delivery recovery (TASK-1207)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function harness() {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(
      fixture.path,
      "check.sh",
      "test -f solution.txt && grep -qx 'done' solution.txt && echo ok\n",
    );
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-failure-recovery-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionStore();
    const problems = new InMemoryProblemStore();
    const specifications = new InMemorySpecificationStore();
    const plans = new InMemorySpecificationPlanStore();
    const deliveries = new InMemoryDeliveryStore();

    await repositories.createRepository({
      id: "repo-a",
      name: "sample",
      url: "git@github.com:example/sample.git",
      localPath: fixture.path,
      verificationCommands: ["sh check.sh"],
      executionProfile: defaultExecutionProfile(),
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
      agentEngine: new FlakyEngine(3),
      verifier: new Verifier(),
      executionManager,
      eventStore: events,
      workerId: "worker-failure-recovery",
      heartbeatMs: 25,
      leaseSeconds: 5,
    });
    const dependencyService = new TaskDependencyService({
      tasks,
      dependencies: new InMemoryTaskDependencyStore(),
      events,
    });
    const deliveryService = new DeliveryService({
      deliveries,
      plans,
      tasks,
      events,
      impacts: dependencyService,
      runs,
    });
    const planning = new PlanningService({
      specifications,
      plans,
      tasks,
      planner: new DeterministicTaskPlanner(),
      events,
      deliveries: deliveryService,
    });
    const specificationService = new SpecificationService({
      specifications,
      problems,
      events,
    });
    const reviews = new ReviewService({ tasks, runs, events });
    const notifier = new RecordingDeliveryNotifier();
    const loop = new Loop({
      scheduler: new Scheduler({
        taskStore: tasks,
        runStore: runs,
        eventStore: events,
        runnableTasks: dependencyService,
        maxConcurrency: 1,
      }),
      worker,
      runStore: runs,
      taskStore: tasks,
      eventStore: events,
      executions,
      executionManager,
      repositories,
      workspaceManager,
      maxConcurrency: 1,
      deliveryReconciler: new DeliveryReconciler({
        deliveries: deliveryService,
        notifier,
      }),
    });

    await problems.createProblem({
      id: "prob-001",
      title: "专辑页面",
      statement: "用户希望有一个专辑页面。",
      status: "CONFIRMED",
    });
    await problems.setProblemSpec("prob-001", {
      problem: "专辑页面不存在",
      expected: "可以浏览专辑曲目",
    });
    const specification = await specificationService.createFromProblem({
      problemId: "prob-001",
      requirements: ["A: 列表接口", "B: 页面"],
      acceptance: ["可以打开专辑页"],
      targets: [{ repositoryId: "repo-a" }],
    });
    await specificationService.markReady(specification.id);
    const planned = await planning.plan(specification.id);
    const [taskA, taskB] = planned.tasks;
    for (const task of planned.tasks) {
      await tasks.updateTaskStatus(task.id, "READY");
    }
    await dependencyService.addDependency(taskB!.id, taskA!.id);
    const delivery = (await deliveryService.findBySpecification(specification.id))!;

    return {
      loop,
      tasks,
      runs,
      events,
      deliveries,
      deliveryService,
      dependencyService,
      reviews,
      notifier,
      taskA: taskA!,
      taskB: taskB!,
      delivery,
    };
  }

  function attemptWorkspaces(
    runs: { result?: unknown }[],
  ): string[] {
    return runs.flatMap((run) => {
      const result = run.result as { workspaces?: { path: string }[] } | undefined;
      return (result?.workspaces ?? []).map((entry) => entry.path);
    });
  }

  it("recovers from failure: BLOCKED → human reset → fresh workspace → READY_FOR_RELEASE", async () => {
    const h = await harness();
    const approve = (taskId: string) =>
      h.reviews.approve(taskId, { channel: "cli", userId: "reviewer" });

    // Attempts 1-3 fail verification; maxAttempts=3 means the third is terminal.
    const first = await h.loop.tick();
    expect(first.scheduled.map((run) => run.taskId)).toEqual([h.taskA.id]);
    await expect(h.tasks.findTask(h.taskA.id)).resolves.toMatchObject({ status: "READY" });
    expect((await h.runs.listRuns({ taskId: h.taskA.id }))[0]?.status).toBe("FAILED");

    await h.loop.tick();
    const third = await h.loop.tick();

    // Third failure exhausts attempts → BLOCKED → Delivery BLOCKED + notify.
    await expect(h.tasks.findTask(h.taskA.id)).resolves.toMatchObject({ status: "BLOCKED" });
    expect(third.deliveryTransitions).toMatchObject([{ status: "BLOCKED" }]);
    expect(third.deliveryNotifications).toBe(1);
    // IN_PROGRESS is recorded but never notified; only BLOCKED reaches a human.
    expect(h.notifier.notifications.map((entry) => entry.status)).toEqual(["BLOCKED"]);
    const blockedMessage = JSON.stringify(h.notifier.notifications[0]!.message.blocks);
    expect(blockedMessage).toContain("BLOCKED");
    expect(blockedMessage).toContain(h.taskA.id);
    expect(blockedMessage).toContain("Failure");
    expect(blockedMessage).toContain("verification: sh check.sh");
    expect(await h.deliveries.listReleases(h.delivery.id)).toEqual([]);

    // B cannot run while its prerequisite is blocked.
    await expect(h.dependencyService.isRunnable(h.taskB.id)).resolves.toBe(false);

    // Human decision: reset the blocked task (same semantics as task validate).
    await h.tasks.updateTaskStatus(h.taskA.id, "READY");

    // Attempt 4 succeeds in a fresh workspace.
    const fourth = await h.loop.tick();
    expect(fourth.scheduled.map((run) => run.taskId)).toEqual([h.taskA.id]);
    // The human reset immediately makes the delivery "in progress" again.
    expect(fourth.deliveryTransitions).toMatchObject([
      { previousStatus: "BLOCKED", status: "IN_PROGRESS" },
    ]);
    await expect(h.tasks.findTask(h.taskA.id)).resolves.toMatchObject({ status: "REVIEW" });
    await approve(h.taskA.id);

    // B is now runnable and finishes.
    const fifth = await h.loop.tick();
    expect(fifth.scheduled.map((run) => run.taskId)).toEqual([h.taskB.id]);
    await expect(h.tasks.findTask(h.taskB.id)).resolves.toMatchObject({ status: "REVIEW" });
    await approve(h.taskB.id);

    // Delivery recovers to READY_FOR_RELEASE — and stops there.
    const sixth = await h.loop.tick();
    expect(sixth.deliveryTransitions).toMatchObject([
      { previousStatus: "IN_PROGRESS", status: "READY_FOR_RELEASE" },
    ]);
    expect(sixth.deliveryNotifications).toBe(1);
    // Full delivery lifecycle across the scenario.
    expect(
      [
        ...first.deliveryTransitions,
        ...third.deliveryTransitions,
        ...fourth.deliveryTransitions,
        ...sixth.deliveryTransitions,
      ].map((transition) => `${transition.previousStatus}→${transition.status}`),
    ).toEqual([
      "PLANNED→IN_PROGRESS",
      "IN_PROGRESS→BLOCKED",
      "BLOCKED→IN_PROGRESS",
      "IN_PROGRESS→READY_FOR_RELEASE",
    ]);
    expect(h.notifier.notifications.map((entry) => entry.status)).toEqual([
      "BLOCKED",
      "READY_FOR_RELEASE",
    ]);
    await expect(h.deliveries.findDelivery(h.delivery.id)).resolves.toMatchObject({
      status: "READY_FOR_RELEASE",
    });
    expect(await h.deliveries.listReleases(h.delivery.id)).toEqual([]);
    await expect(
      h.events.listEvents({ type: "release.released" }),
    ).resolves.toHaveLength(0);

    // Repeated ticks keep it human-controlled and quiet.
    const seventh = await h.loop.tick();
    expect(seventh.deliveryTransitions).toEqual([]);
    expect(seventh.deliveryNotifications).toBe(0);
    expect(await h.deliveries.listReleases(h.delivery.id)).toEqual([]);

    // Every A attempt used its own workspace: no reuse across retries.
    const aRuns = await h.runs.listRuns({ taskId: h.taskA.id });
    expect(aRuns.map((run) => run.status)).toEqual([
      "FAILED",
      "FAILED",
      "FAILED",
      "SUCCEEDED",
    ]);
    const paths = attemptWorkspaces(aRuns);
    expect(paths).toHaveLength(4);
    expect(new Set(paths).size).toBe(4);
  });
});
