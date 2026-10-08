import { describe, expect, it } from "vitest";
import {
  buildSpecification,
  isExecutableCheck,
  readWorkItems,
  withWorkItems,
} from "../src/domain/specification.js";
import type { SpecificationWorkItem } from "../src/domain/specification.js";
import { repairWorkItems } from "../src/specification/application/workItems.js";
import { DeterministicTaskPlanner } from "../src/specification/application/planner.js";
import { normalizeDerived } from "../src/server/specificationBootstrap.js";
import { PlanningService } from "../src/specification/application/planning.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

const item = (over: Partial<SpecificationWorkItem>): SpecificationWorkItem => ({
  title: "t",
  description: "d",
  acceptance: [0],
  checks: ["npm test"],
  ...over,
});

describe("work item repair (TASK-1224)", () => {
  it("tells a command apart from a manual step", () => {
    expect(isExecutableCheck("npm test")).toBe(true);
    expect(isExecutableCheck("node scripts/check-docs.mjs && npm test")).toBe(true);
    expect(isExecutableCheck("   ")).toBe(false);
    expect(isExecutableCheck("在运行应用的开发者工具中选取面包屑 sep 元素，断言间距为 16px")).toBe(
      false,
    );
    expect(isExecutableCheck("Select the sep element and assert its margin is 16px.")).toBe(false);
  });

  it("drops a non-command check instead of planning a Run that cannot pass", () => {
    const repaired = repairWorkItems(
      [
        item({
          title: "给面包屑 sep 加 16px 间距",
          acceptance: [0, 1],
          checks: [
            "npm test",
            "在运行应用的开发者工具中选取面包屑 sep 元素，断言 getComputedStyle(el).marginLeft === '16px'",
          ],
        }),
      ],
      2,
    );

    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.checks).toEqual(["npm test"]);
  });

  it("treats an item whose only check was prose as check-less", () => {
    const repaired = repairWorkItems(
      [
        item({ title: "改间距", acceptance: [0], checks: ["npm test"] }),
        item({ title: "人工确认间距", acceptance: [1], checks: ["请人工在浏览器里确认间距"] }),
      ],
      2,
    );

    // Rule 2: the prose item is not a deliverable, its criterion joins the real one.
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.acceptance).toEqual([0, 1]);
  });

  it("collapses the x-music shape into one deliverable", () => {
    // 5 acceptance criteria; the model described the same change three times:
    // one real change with checks, plus a scope constraint and a stability note.
    const repaired = repairWorkItems(
      [
        item({ title: "调大间距", acceptance: [0, 1], checks: ["node scripts/check-docs.mjs"] }),
        item({ title: "只作用于移动端", acceptance: [3], checks: [] }),
        item({ title: "多宽度稳定", acceptance: [2, 4], checks: [] }),
      ],
      5,
    );

    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.acceptance).toEqual([0, 1, 2, 3, 4]);
    expect(repaired[0]!.checks).toEqual(["node scripts/check-docs.mjs"]);
  });

  it("merges two items that prove exactly the same criteria", () => {
    const repaired = repairWorkItems(
      [
        item({ title: "a", acceptance: [0, 1], checks: ["a"] }),
        item({ title: "b", acceptance: [1, 0], checks: ["b"] }),
      ],
      2,
    );
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.checks).toEqual(["a", "b"]);
  });

  it("drops criteria indices that do not exist", () => {
    const repaired = repairWorkItems([item({ acceptance: [0, 99] })], 1);
    expect(repaired[0]!.acceptance).toEqual([0]);
    expect(repairWorkItems([item({ acceptance: [9] })], 2)).toEqual([]);
  });

  it("still covers criteria the model forgot to claim", () => {
    const repaired = repairWorkItems([item({ acceptance: [0] })], 2);
    expect(repaired[0]!.acceptance).toEqual([0, 1]);
  });

  it("attaches criteria no work item claimed to the last deliverable", () => {
    const repaired = repairWorkItems(
      [item({ acceptance: [0] }), item({ title: "b", acceptance: [1] })],
      3,
    );
    expect(repaired[1]!.acceptance).toEqual([1, 2]);
  });

  it("keeps one deliverable when nothing has a check", () => {
    const repaired = repairWorkItems(
      [item({ acceptance: [0], checks: [] }), item({ title: "b", acceptance: [1], checks: [] })],
      2,
    );
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.acceptance).toEqual([0, 1]);
  });
});

describe("work items on the specification", () => {
  it("round-trips through constraints and drops malformed entries", () => {
    const spec = buildSpecification({
      problemId: "prob-1",
      title: "spec",
      acceptance: ["a", "b"],
      constraints: withWorkItems({}, [
        item({ title: "good", acceptance: [0] }),
        { title: "", description: "", acceptance: [1], checks: [] } as SpecificationWorkItem,
      ]),
    });

    const items = readWorkItems(spec);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("good");
  });
});

describe("planner granularity (TASK-1224)", () => {
  function specWith(workItems: SpecificationWorkItem[] | undefined) {
    return buildSpecification({
      problemId: "prob-1",
      title: "spec",
      summary: "s",
      requirements: ["r1", "r2", "r3"],
      acceptance: ["a0", "a1", "a2"],
      constraints: workItems ? withWorkItems({}, workItems) : {},
    });
  }

  it("plans one task per work item, with only that item's acceptance", async () => {
    const planner = new DeterministicTaskPlanner();
    const plan = await planner.plan(
      specWith([
        item({ title: "改间距", acceptance: [0], checks: ["c1"] }),
        item({ title: "补文档", acceptance: [1, 2], checks: ["c2"] }),
      ]),
    );

    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({ title: "改间距", acceptance: ["a0"], checks: ["c1"] });
    expect(plan.items[1]).toMatchObject({ acceptance: ["a1", "a2"] });
  });

  it("ignores work items with no checks left after repair and still covers all criteria", async () => {
    const planner = new DeterministicTaskPlanner();
    const plan = await planner.plan(
      specWith([
        item({ title: "真正的改动", acceptance: [0, 1], checks: ["c"] }),
        item({ title: "约束", acceptance: [2], checks: [] }),
      ]),
    );

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.acceptance).toEqual(["a0", "a1", "a2"]);
  });

  it("falls back to one item per requirement when there are no work items", async () => {
    const planner = new DeterministicTaskPlanner();
    const plan = await planner.plan(specWith(undefined));

    expect(plan.items).toHaveLength(3);
    expect(plan.items.map((entry) => entry.title)).toEqual(["r1", "r2", "r3"]);
    expect(plan.items[0]!.acceptance).toBeUndefined();
  });
});

describe("derive normalisation (TASK-1224)", () => {
  it("repairs the model's decomposition before it is stored", () => {
    const derived = normalizeDerived(
      {
        title: "间距",
        summary: "s",
        requirements: ["调大间距", "只作用于移动端", "多宽度稳定"],
        acceptance: ["可见空隙", ">= 12px", "无横向滚动", "桌面端不变", "构建通过"],
        workItems: [
          { title: "调大间距", description: "d", acceptance: [0, 1], checks: ["npm run build"] },
          { title: "只作用于移动端", description: "d", acceptance: [3], checks: [] },
          { title: "多宽度稳定", description: "d", acceptance: [2, 4], checks: [] },
        ],
        targets: [{ repositoryId: "repo-x", role: "primary" }],
      },
      [{ id: "repo-x", name: "x" }],
    );

    expect(derived.workItems).toHaveLength(1);
    expect(derived.workItems[0]!.acceptance).toEqual([0, 1, 2, 3, 4]);
  });

  it("produces no work items for a malformed payload (falls back to requirements)", () => {
    const derived = normalizeDerived(
      { title: "t", requirements: ["r"], acceptance: ["a"], workItems: "nope" },
      [],
    );
    expect(derived.workItems).toEqual([]);
  });
});

describe("tasks inherit their own acceptance (TASK-1224)", () => {
  it("gives each task its work item's criteria and checks", async () => {
    const specifications = new InMemorySpecificationStore();
    const plans = new InMemorySpecificationPlanStore();
    const tasks = new InMemoryTaskStore();
    const repositories = new InMemoryRepositoryStore();
    await repositories.createRepository({
      id: "repo-x",
      name: "x",
      url: "git@github.com:i12n/x-music.git",
    });
    await specifications.createSpecification({
      id: "spec-1",
      problemId: "prob-1",
      title: "spec",
      summary: "s",
      requirements: ["r"],
      acceptance: ["a0", "a1", "a2"],
      constraints: withWorkItems({}, [
        item({ title: "第一件", acceptance: [0], checks: ["c1"] }),
        item({ title: "第二件", acceptance: [1, 2], checks: ["c2"] }),
      ]),
      targets: [{ repositoryId: "repo-x", role: "primary" }],
      status: "READY",
    });
    const planning = new PlanningService({
      specifications,
      plans,
      tasks,
      planner: new DeterministicTaskPlanner(),
    });

    const outcome = await planning.plan("spec-1");

    expect(outcome.tasks).toHaveLength(2);
    expect(outcome.tasks[0]!.acceptance).toEqual(["a0"]);
    expect(outcome.tasks[0]!.constraints.checks).toEqual(["c1"]);
    expect(outcome.tasks[1]!.acceptance).toEqual(["a1", "a2"]);
  });
});
