import { describe, expect, it } from "vitest";
import { buildSpecification } from "../src/domain/specification.js";
import { buildSpecificationPlanItem } from "../src/domain/specificationPlan.js";
import { ValidationError } from "../src/errors.js";
import {
  DeterministicTaskPlanner,
  ScriptedTaskPlanner,
} from "../src/specification/application/planner.js";
import { PlanningService } from "../src/specification/application/planning.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import type { Specification } from "../src/domain/specification.js";

describe("DeterministicTaskPlanner", () => {
  it("plans one item per requirement, in order", async () => {
    const planner = new DeterministicTaskPlanner();
    const plan = await planner.plan(
      buildSpecification({
        problemId: "prob-001",
        title: "专辑页面",
        summary: "浏览专辑曲目",
        requirements: ["列表页显示曲目", "详情页显示歌词"],
      }),
    );

    expect(plan.items).toEqual([
      { title: "列表页显示曲目", description: "列表页显示曲目" },
      { title: "详情页显示歌词", description: "详情页显示歌词" },
    ]);
  });

  it("plans a single item for the whole specification without requirements", async () => {
    const planner = new DeterministicTaskPlanner();
    const plan = await planner.plan(
      buildSpecification({
        problemId: "prob-001",
        title: "专辑页面",
        summary: "浏览专辑曲目",
      }),
    );

    expect(plan.items).toEqual([{ title: "专辑页面", description: "" }]);
  });

  it("keeps task titles single-line", async () => {
    const planner = new DeterministicTaskPlanner();
    const plan = await planner.plan(
      buildSpecification({
        problemId: "prob-001",
        title: "x",
        requirements: ["第一行\n第二行"],
      }),
    );

    expect(plan.items[0]).toEqual({
      title: "第一行",
      description: "第一行\n第二行",
    });
  });
});

interface Harness {
  specifications: InMemorySpecificationStore;
  plans: InMemorySpecificationPlanStore;
  tasks: InMemoryTaskStore;
  events: InMemoryEventStore;
  planning: PlanningService;
}

function harness(planner = new DeterministicTaskPlanner()): Harness {
  const specifications = new InMemorySpecificationStore();
  const plans = new InMemorySpecificationPlanStore();
  const tasks = new InMemoryTaskStore();
  const events = new InMemoryEventStore();
  return {
    specifications,
    plans,
    tasks,
    events,
    planning: new PlanningService({ specifications, plans, tasks, planner, events }),
  };
}

async function seedSpecification(
  h: Harness,
  overrides: Partial<Parameters<typeof buildSpecification>[0]> = {},
): Promise<Specification> {
  return h.specifications.createSpecification({
    id: "spec-001",
    problemId: "prob-001",
    title: "专辑页面",
    summary: "浏览专辑曲目",
    acceptance: ["可以打开专辑页"],
    status: "READY",
    targets: [
      { repositoryId: "repo-a", role: "primary", position: 0, baseRef: "main" },
      { repositoryId: "repo-b", role: "supporting", position: 1, baseRef: "develop" },
    ],
    requirements: ["列表页显示曲目", "详情页显示歌词"],
    ...overrides,
  });
}

describe("PlanningService (TASK-1202)", () => {
  it("plans a READY specification into N tasks and marks it PLANNED", async () => {
    const h = harness();
    const specification = await seedSpecification(h);

    const outcome = await h.planning.plan(specification.id);

    expect(outcome.replayed).toBe(false);
    expect(outcome.specification.status).toBe("PLANNED");
    expect(outcome.planItems.map((item) => item.position)).toEqual([0, 1]);
    expect(outcome.tasks).toHaveLength(2);
    expect(outcome.tasks.map((task) => task.title)).toEqual([
      "列表页显示曲目",
      "详情页显示歌词",
    ]);
    const [first, second] = outcome.tasks;
    expect(first).toMatchObject({
      id: "task-spec-001-0",
      repositoryId: "repo-a",
      status: "INBOX",
      acceptance: ["可以打开专辑页"],
      description: "浏览专辑曲目\n\n列表页显示曲目",
      constraints: {},
    });
    expect(first!.targets).toEqual([
      expect.objectContaining({ repositoryId: "repo-a", role: "primary", position: 0, baseRef: "main" }),
      expect.objectContaining({ repositoryId: "repo-b", role: "supporting", position: 1, baseRef: "develop" }),
    ]);
    expect(second!.id).toBe("task-spec-001-1");
    expect(outcome.planItems.map((item) => item.taskId)).toEqual([
      first!.id,
      second!.id,
    ]);
  });

  it("is idempotent: a second plan returns the same plan and tasks", async () => {
    const h = harness();
    const specification = await seedSpecification(h);

    const first = await h.planning.plan(specification.id);
    const second = await h.planning.plan(specification.id);

    expect(second.replayed).toBe(true);
    expect(second.planItems.map((item) => item.id)).toEqual(
      first.planItems.map((item) => item.id),
    );
    expect(second.tasks.map((task) => task.id)).toEqual(
      first.tasks.map((task) => task.id),
    );
    const allTasks = await h.tasks.listTasks();
    expect(allTasks).toHaveLength(2);
    expect(new Set(allTasks.map((task) => task.id)).size).toBe(2);
    expect(allTasks.every((task) => task.targets.length === 2)).toBe(true);
  });

  it("rejects DRAFT and incomplete specifications", async () => {
    const h = harness();
    const draft = await seedSpecification(h, { id: "spec-draft", status: "DRAFT" });
    await expect(h.planning.plan(draft.id)).rejects.toMatchObject({
      code: "specification_not_ready",
    });

    const incomplete = await seedSpecification(h, {
      id: "spec-incomplete",
      acceptance: [],
      targets: [],
    });
    await expect(h.planning.plan(incomplete.id)).rejects.toMatchObject({
      code: "specification_incomplete",
      issues: ["specification has no acceptance criteria", "specification has no targets"],
    });
    await expect(h.tasks.listTasks()).resolves.toHaveLength(0);
    await expect(h.specifications.findSpecification(incomplete.id)).resolves.toMatchObject({
      status: "READY",
    });
  });

  it("reverts to READY when the planner produces nothing", async () => {
    const h = harness(new ScriptedTaskPlanner({ items: [] }));
    const specification = await seedSpecification(h);

    await expect(h.planning.plan(specification.id)).rejects.toMatchObject({
      code: "plan_empty",
    });
    await expect(h.specifications.findSpecification(specification.id)).resolves.toMatchObject({
      status: "READY",
    });
    await expect(h.plans.listPlanItems(specification.id)).resolves.toEqual([]);
  });

  it("completes a partially materialized plan (crash recovery)", async () => {
    const h = harness();
    const specification = await seedSpecification(h);
    // Simulate a crash right after plan items were written.
    await h.plans.createPlanItem({
      id: `plan-${specification.id}-0`,
      specificationId: specification.id,
      position: 0,
      title: "列表页显示曲目",
      description: "列表页显示曲目",
    });
    await h.plans.createPlanItem({
      id: `plan-${specification.id}-1`,
      specificationId: specification.id,
      position: 1,
      title: "详情页显示歌词",
      description: "详情页显示歌词",
    });

    const outcome = await h.planning.plan(specification.id);

    expect(outcome.tasks.map((task) => task.id)).toEqual([
      "task-spec-001-0",
      "task-spec-001-1",
    ]);
    expect(outcome.specification.status).toBe("PLANNED");
    expect(outcome.planItems.map((item) => item.taskId)).toEqual([
      "task-spec-001-0",
      "task-spec-001-1",
    ]);
    await expect(h.tasks.listTasks()).resolves.toHaveLength(2);
  });

  it("reuses an already created task with the deterministic id", async () => {
    const h = harness();
    const specification = await seedSpecification(h);
    await h.tasks.createTask({
      id: "task-spec-001-0",
      repositoryId: "repo-a",
      title: "existing",
      status: "READY",
    });

    const outcome = await h.planning.plan(specification.id);

    expect(outcome.tasks[0]).toMatchObject({ id: "task-spec-001-0", title: "existing" });
    expect(outcome.tasks[1]).toMatchObject({ id: "task-spec-001-1" });
    await expect(h.tasks.listTasks()).resolves.toHaveLength(2);
  });

  it("records specification.planned once and shows the plan read-only", async () => {
    const h = harness();
    const specification = await seedSpecification(h);
    await h.planning.plan(specification.id);
    await h.planning.plan(specification.id);

    const events = await h.events.listEvents({ type: "specification.planned" });
    expect(events).toHaveLength(1);
    expect(events[0]?.problemId).toBe("prob-001");
    expect(events[0]?.payload).toMatchObject({ specificationId: specification.id, planItems: 2 });

    const shown = await h.planning.show(specification.id);
    expect(shown.planItems).toHaveLength(2);
    expect(shown.tasks.map((task) => task.id)).toEqual([
      "task-spec-001-0",
      "task-spec-001-1",
    ]);
  });

  it("does not plan an unknown specification", async () => {
    const h = harness();
    await expect(h.planning.plan("spec-missing")).rejects.toThrow(
      /specification not found/,
    );
    await expect(h.planning.show("spec-missing")).rejects.toThrow(
      /specification not found/,
    );
  });

  it("requires a non-negative integer position for plan items", () => {
    expect(() =>
      buildSpecificationPlanItem({
        specificationId: "spec-001",
        title: "item",
        position: -1,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildSpecificationPlanItem({
        specificationId: "spec-001",
        title: " ",
        position: 0,
      }),
    ).toThrow(ValidationError);
  });
});
