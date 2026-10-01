import { describe, expect, it } from "vitest";
import { createPhase12Harness } from "./harness.js";

/**
 * TASK-1210: before this, `SpecificationService` had no call site in `src/`
 * and only `spec.show` / `spec.plan` existed, so the main chain could not be
 * started from production code (or from chat). These tests drive the whole
 * chain through the command layer only.
 */
describe("Phase 12 E2E — main-chain entry point (TASK-1210)", () => {
  it("runs Problem → spec.create → spec.update → spec.ready → spec.plan", async () => {
    const h = await createPhase12Harness();

    // Problem → CONFIRMED (the confirmation loop is TASK-1107, unchanged).
    const createdProblem = await h.dispatch("problem.create", {
      title: "专辑页面",
      statement: "用户希望有一个专辑页面。",
    });
    expect(createdProblem.status).toBe("succeeded");
    const problem = (createdProblem.data as { problem: { id: string; status: string } })
      .problem;
    expect(problem.status).toBe("CONFIRMED");

    // CONFIRMED Problem → DRAFT Specification (the entry point that was missing).
    const createdSpec = await h.dispatch("spec.create", {
      problemId: problem.id,
      repositories: ["repo-a"],
    });
    expect(createdSpec.status).toBe("succeeded");
    const specification = (
      createdSpec.data as {
        specification: {
          id: string;
          status: string;
          acceptance: string[];
          targets: { repositoryId: string }[];
        };
      }
    ).specification;
    expect(specification.status).toBe("DRAFT");
    expect(specification.acceptance).toEqual([]);
    expect(specification.targets.map((target) => target.repositoryId)).toEqual([
      "repo-a",
    ]);

    // DRAFT is editable.
    const updated = await h.dispatch("spec.update", {
      specificationId: specification.id,
      acceptance: ["可以打开专辑页"],
    });
    expect(updated.status).toBe("succeeded");

    // DRAFT → READY.
    const ready = await h.dispatch("spec.ready", {
      specificationId: specification.id,
    });
    expect(ready.status).toBe("succeeded");
    expect(
      (ready.data as { specification: { status: string } }).specification.status,
    ).toBe("READY");

    // READY → Tasks → PLANNED (TASK-1202, unchanged).
    const planned = await h.dispatch("spec.plan", {
      specificationId: specification.id,
    });
    expect(planned.status).toBe("succeeded");
    const plannedData = planned.data as {
      specification: { status: string };
      tasks: { id: string; acceptance: string[] }[];
    };
    expect(plannedData.specification.status).toBe("PLANNED");
    expect(plannedData.tasks).toHaveLength(1);
    expect(plannedData.tasks[0]?.acceptance).toEqual(["可以打开专辑页"]);

    // Planning only plans: nothing runs here.
    await expect(h.tasks.listTasks()).resolves.toHaveLength(1);
    await expect(h.runs.listRuns()).resolves.toHaveLength(0);
    await expect(
      h.events.listEvents({ type: "specification.created" }),
    ).resolves.toHaveLength(1);
  });

  it("keeps guests out of the entry point", async () => {
    const h = await createPhase12Harness();
    const createdProblem = await h.dispatch("problem.create", {
      title: "专辑页面",
      statement: "用户希望有一个专辑页面。",
    });
    const problemId = (createdProblem.data as { problem: { id: string } }).problem.id;

    const rejected = await h.dispatch(
      "spec.create",
      { problemId },
      { roles: ["guest"], messageId: "msg-guest" },
    );

    expect(rejected).toMatchObject({
      status: "rejected",
      error: { code: "unauthorized" },
    });
    await expect(h.specifications.listSpecifications()).resolves.toHaveLength(0);
  });
});
