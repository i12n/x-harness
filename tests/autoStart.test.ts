import { describe, expect, it } from "vitest";
import { PlanningService } from "../src/specification/application/planning.js";
import { DeterministicTaskPlanner } from "../src/specification/application/planner.js";
import { buildSpecification } from "../src/domain/specification.js";
import { describePlannedTasks } from "../src/server/session.js";
import { TaskIntakeService } from "../src/task/application/intakeService.js";
import { DEFAULT_EXECUTION_TIMEOUT_MS } from "../src/worker/worker.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

const GIT_URL = "git@github.com:i12n/x-music.git";

async function setup() {
  const specifications = new InMemorySpecificationStore();
  const plans = new InMemorySpecificationPlanStore();
  const tasks = new InMemoryTaskStore();
  const repositories = new InMemoryRepositoryStore();
  const events = new InMemoryEventStore();
  await repositories.createRepository({ id: "repo-x", name: "x", url: GIT_URL });

  const specification = await specifications.createSpecification({
    id: "spec-1",
    problemId: "prob-1",
    title: "移动端间距",
    summary: "把按钮和标签的间距调大",
    requirements: ["间距被增大到合理的视觉间距"],
    acceptance: ["移动端专辑页按钮与标签之间可见明显空隙"],
    targets: [{ repositoryId: "repo-x", role: "primary" }],
    status: "READY",
  });
  return { specifications, plans, tasks, repositories, events, specification };
}

function intakeService(stores: Awaited<ReturnType<typeof setup>>) {
  return new TaskIntakeService({
    tasks: stores.tasks,
    repositories: stores.repositories,
    events: stores.events,
  });
}

describe("TASK-1219 auto start", () => {
  it("planning runs intake, so tasks come out READY for the scheduler", async () => {
    const stores = await setup();
    const planning = new PlanningService({
      specifications: stores.specifications,
      plans: stores.plans,
      tasks: stores.tasks,
      planner: new DeterministicTaskPlanner(),
      events: stores.events,
      intake: intakeService(stores),
    });

    const outcome = await planning.plan("spec-1");

    expect(outcome.tasks).toHaveLength(1);
    expect(outcome.tasks[0]!.status).toBe("READY");
    expect(await stores.events.listEvents({ type: "TaskReady" })).toHaveLength(1);
  });

  it("leaves tasks in INBOX when intake is not wired (AI_AUTO_START=off)", async () => {
    const stores = await setup();
    const planning = new PlanningService({
      specifications: stores.specifications,
      plans: stores.plans,
      tasks: stores.tasks,
      planner: new DeterministicTaskPlanner(),
      events: stores.events,
    });

    const outcome = await planning.plan("spec-1");

    expect(outcome.tasks[0]!.status).toBe("INBOX");
  });

  it("blocks a task whose repository is gone instead of starting it", async () => {
    const stores = await setup();
    // The repository the specification targets is no longer registered: this is
    // the realistic intake failure (a well-formed task still needs its repo).
    const orphan = await stores.specifications.createSpecification({
      id: "spec-orphan",
      problemId: "prob-2",
      title: "孤儿仓库",
      summary: "s",
      requirements: ["r"],
      acceptance: ["a"],
      targets: [{ repositoryId: "repo-gone", role: "primary" }],
      status: "READY",
    });
    expect(orphan.id).toBe("spec-orphan");
    const planning = new PlanningService({
      specifications: stores.specifications,
      plans: stores.plans,
      tasks: stores.tasks,
      planner: new DeterministicTaskPlanner(),
      events: stores.events,
      intake: intakeService(stores),
    });

    const outcome = await planning.plan("spec-orphan");

    expect(outcome.tasks[0]!.status).toBe("BLOCKED");
    const blocked = await stores.events.listEvents({ type: "TaskBlocked" });
    expect(JSON.stringify(blocked[0]?.payload)).toContain("没有找到仓库");
  });

  it("never re-intakes a task on a replayed plan", async () => {
    const stores = await setup();
    let calls = 0;
    const planning = new PlanningService({
      specifications: stores.specifications,
      plans: stores.plans,
      tasks: stores.tasks,
      planner: new DeterministicTaskPlanner(),
      events: stores.events,
      intake: {
        intakeAll: async (ids) => {
          calls += 1;
          return intakeService(stores).intakeAll(ids);
        },
      },
    });

    const first = await planning.plan("spec-1");
    await stores.tasks.updateTaskStatus(first.tasks[0]!.id, "DONE");
    const replay = await planning.plan("spec-1");

    expect(calls).toBe(1);
    expect(replay.tasks[0]!.status).toBe("DONE");
    expect(replay.replayed).toBe(true);
  });
});

describe("TASK-1219 run cap", () => {
  it("caps a Run at 30 minutes unless AI_RUN_TIMEOUT_MS says otherwise", () => {
    expect(DEFAULT_EXECUTION_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});

describe("TASK-1219 chat copy", () => {
  const task = (id: string, status: string) =>
    ({ id, title: "t", status }) as unknown as Parameters<typeof describePlannedTasks>[0][number];

  it("says it started by itself when tasks are READY", () => {
    const text = describePlannedTasks([task("task-1", "READY")]);
    expect(text).toContain("已自动排队开始");
  });

  it("asks for attention only on blocked tasks", () => {
    const text = describePlannedTasks([task("task-1", "READY"), task("task-2", "BLOCKED")]);
    expect(text).toContain("没通过 intake");
    expect(text).toContain("task-2");
  });

  it("keeps the manual instruction when auto-start is off", () => {
    const text = describePlannedTasks([task("task-1", "INBOX")]);
    expect(text).toContain("运行 task-1");
  });
});
