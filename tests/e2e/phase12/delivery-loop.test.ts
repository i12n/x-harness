import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../../../src/agent/types.js";
import { DeliveryService } from "../../../src/delivery/application/service.js";
import { DeliveryReconciler } from "../../../src/delivery/application/reconciler.js";
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

/** Deterministic agent: writes the acceptance file into every workdir. */
class WriteSolutionEngine implements AgentEngine {
  calls = 0;

  async execute(context: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    const exec = context.execution?.exec;
    if (!exec) {
      throw new Error("delivery loop agent requires execution.exec");
    }
    for (const workdir of Object.values(context.execution?.workdirs ?? {})) {
      const result = await exec(
        ["sh", "-lc", "printf '%s' 'done' > solution.txt"],
        { cwd: workdir },
      );
      if (result.exitCode !== 0) {
        throw new Error(`agent write failed: ${result.stderr}`);
      }
    }
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: "solution written",
      stderr: "",
      startedAt: now,
      finishedAt: now,
    };
  }

  async cancel(): Promise<void> {}
}

describe("Phase 12 E2E — Delivery Loop (TASK-1206)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function harness(
    options: { notifier?: RecordingDeliveryNotifier } = {},
  ) {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(
      fixture.path,
      "check.sh",
      "test -f solution.txt && grep -qx 'done' solution.txt && echo ok\n",
    );
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-delivery-loop-"));
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
    const dependencyStore = new InMemoryTaskDependencyStore();

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
      agentEngine: new WriteSolutionEngine(),
      verifier: new Verifier(),
      executionManager,
      eventStore: events,
      workerId: "worker-delivery",
      heartbeatMs: 25,
      leaseSeconds: 5,
    });
    const dependencyService = new TaskDependencyService({
      tasks,
      dependencies: dependencyStore,
      events,
    });
    const deliveryService = new DeliveryService({ deliveries, plans, tasks, events });
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
    const notifier = options.notifier ?? new RecordingDeliveryNotifier();
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
    // B waits for A: the scheduler must respect the DAG.
    await dependencyService.addDependency(taskB!.id, taskA!.id);

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
      specificationId: specification.id,
      taskA: taskA!,
      taskB: taskB!,
    };
  }

  it("drives the chain to READY_FOR_RELEASE and stops before release", async () => {
    const h = await harness();
    const delivery = (await h.deliveryService.findBySpecification(h.specificationId))!;

    // Tick 1: A is runnable, B is gated by A.
    const first = await h.loop.tick();
    expect(first.scheduled.map((run) => run.taskId)).toEqual([h.taskA.id]);
    expect(first.deliveryTransitions.map((entry) => entry.status)).toEqual([
      "IN_PROGRESS",
    ]);
    expect(first.deliveryNotifications).toBe(0);
    expect((await h.tasks.findTask(h.taskA.id)).status).toBe("REVIEW");
    expect((await h.tasks.findTask(h.taskB.id)).status).toBe("READY");

    // Approval is the completion point; only DONE unlocks B.
    await h.reviews.approve(h.taskA.id, { channel: "cli", userId: "reviewer" });

    // Tick 2: B becomes runnable and runs.
    const second = await h.loop.tick();
    expect(second.scheduled.map((run) => run.taskId)).toEqual([h.taskB.id]);
    expect(second.deliveryNotifications).toBe(0);
    expect((await h.tasks.findTask(h.taskB.id)).status).toBe("REVIEW");

    await h.reviews.approve(h.taskB.id, { channel: "cli", userId: "reviewer" });

    // Tick 3: both required tasks DONE → READY_FOR_RELEASE + notification.
    const third = await h.loop.tick();
    expect(third.deliveryTransitions).toMatchObject([
      { previousStatus: "IN_PROGRESS", status: "READY_FOR_RELEASE" },
    ]);
    expect(third.deliveryNotifications).toBe(1);
    expect(h.notifier.notifications).toHaveLength(1);
    const message = JSON.stringify(h.notifier.notifications[0]!.message.blocks);
    expect(message).toContain("待发布");
    expect(message).toContain("✓ " + h.taskA.id);
    expect(message).toContain("✓ " + h.taskB.id);
    expect(message).toContain("（尚未发布）");

    // Release stays a human decision: repeated ticks must not release.
    await h.loop.tick();
    await h.loop.tick();
    await expect(h.deliveries.findDelivery(delivery.id)).resolves.toMatchObject({
      status: "READY_FOR_RELEASE",
    });
    await expect(h.deliveries.listReleases(delivery.id)).resolves.toEqual([]);
    expect(h.notifier.notifications).toHaveLength(1);
    await expect(
      h.events.listEvents({ type: "delivery.ready_for_release" }),
    ).resolves.toHaveLength(1);
    await expect(
      h.events.listEvents({ type: "release.released" }),
    ).resolves.toHaveLength(0);
  });

  it("keeps reconciling a BLOCKED delivery without touching execution", async () => {
    const h = await harness();
    const delivery = (await h.deliveryService.findBySpecification(h.specificationId))!;

    // A fails permanently (worker retries give up) → BLOCKED → notification.
    await h.tasks.updateTaskStatus(h.taskB.id, "BLOCKED");
    await h.tasks.updateTaskStatus(h.taskA.id, "DONE");
    const first = await h.loop.tick();
    expect(first.deliveryTransitions.map((entry) => entry.status)).toEqual(["BLOCKED"]);
    expect(first.deliveryNotifications).toBe(1);
    expect(JSON.stringify(h.notifier.notifications[0]!.message.blocks)).toContain(
      `${h.taskB.id} 处于已阻塞`,
    );

    // Later ticks are quiet, and the Delivery does not drift.
    const second = await h.loop.tick();
    expect(second.deliveryTransitions).toEqual([]);
    expect(second.deliveryNotifications).toBe(0);
    await expect(h.deliveries.findDelivery(delivery.id)).resolves.toMatchObject({
      status: "BLOCKED",
    });
  });

  it("keeps the transition when the notifier fails and retries on the next tick (TASK-1207)", async () => {
    // Two passes run per tick, so failing twice keeps it pending across ticks.
    const notifier = RecordingDeliveryNotifier.failingTimes(2, "feishu down");
    const h = await harness({ notifier });
    const delivery = (await h.deliveryService.findBySpecification(h.specificationId))!;
    await h.tasks.updateTaskStatus(h.taskA.id, "DONE");
    await h.tasks.updateTaskStatus(h.taskB.id, "DONE");

    const first = await h.loop.tick();

    // The state transition survived, the notification did not.
    // (No earlier tick refreshed the delivery, so it moves from PLANNED.)
    expect(first.deliveryTransitions).toMatchObject([
      { previousStatus: "PLANNED", status: "READY_FOR_RELEASE" },
    ]);
    expect(first.deliveryNotifications).toBe(0);
    expect(first.deliveryNotificationFailures).toEqual([
      { deliveryId: delivery.id, status: "READY_FOR_RELEASE", reason: "feishu down" },
      { deliveryId: delivery.id, status: "READY_FOR_RELEASE", reason: "feishu down" },
    ]);
    expect(first.deliveryPendingNotifications).toBe(1);
    await expect(h.deliveries.findDelivery(delivery.id)).resolves.toMatchObject({
      status: "READY_FOR_RELEASE",
    });
    await expect(
      h.events.listEvents({ type: "delivery.ready_for_release" }),
    ).resolves.toHaveLength(1);
    expect(notifier.notifications).toEqual([]);

    // Next tick retries the message only — no second transition event.
    const second = await h.loop.tick();
    expect(second.deliveryTransitions).toEqual([]);
    expect(second.deliveryNotifications).toBe(1);
    expect(second.deliveryNotificationFailures).toEqual([]);
    expect(second.deliveryPendingNotifications).toBe(0);
    expect(notifier.notifications).toHaveLength(1);
    await expect(
      h.events.listEvents({ type: "delivery.ready_for_release" }),
    ).resolves.toHaveLength(1);
  });
});
