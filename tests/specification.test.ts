import { describe, expect, it } from "vitest";
import {
  applySpecificationUpdate,
  assessSpecification,
  buildSpecification,
} from "../src/domain/specification.js";
import { ValidationError } from "../src/errors.js";
import { SpecificationError, SpecificationService } from "../src/specification/application/service.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";

async function confirmedProblem(
  problems: InMemoryProblemStore,
  overrides: {
    id?: string;
    repositoryId?: string;
    status?: "CONFIRMED" | "NEEDS_INPUT";
    expected?: string;
  } = {},
) {
  const problem = await problems.createProblem({
    id: overrides.id ?? "prob-001",
    title: "专辑页面",
    statement: "用户希望有一个专辑页面。",
    repositoryId: overrides.repositoryId ?? "repo-001",
    status: overrides.status ?? "CONFIRMED",
  });
  await problems.setProblemSpec(problem.id, {
    problem: "专辑页面不存在",
    expected: overrides.expected ?? "可以浏览专辑曲目",
    scope: "所有用户",
  });
  return problems.findProblem(problem.id);
}

describe("Specification domain (TASK-1201)", () => {
  it("builds a DRAFT specification with normalized targets", () => {
    const specification = buildSpecification({
      id: "spec-001",
      problemId: "prob-001",
      title: "  专辑页面  ",
      summary: " 浏览专辑曲目 ",
      requirements: ["列表", "列表", "  ", "详情"],
      acceptance: ["可以打开专辑页"],
      targets: [
        { repositoryId: "repo-a" },
        { repositoryId: "repo-b", baseRef: "develop" },
      ],
    });

    expect(specification).toMatchObject({
      id: "spec-001",
      problemId: "prob-001",
      title: "专辑页面",
      summary: "浏览专辑曲目",
      status: "DRAFT",
      requirements: ["列表", "详情"],
      acceptance: ["可以打开专辑页"],
    });
    expect(specification.targets).toEqual([
      { repositoryId: "repo-a", role: "primary", position: 0, baseRef: undefined },
      { repositoryId: "repo-b", role: "supporting", position: 1, baseRef: "develop" },
    ]);
    expect(specification.id).toMatch(/^spec-/);
  });

  it("requires problem id and title", () => {
    expect(() => buildSpecification({ problemId: " ", title: "x" })).toThrow(
      ValidationError,
    );
    expect(() => buildSpecification({ problemId: "prob-001", title: "  " })).toThrow(
      ValidationError,
    );
  });

  it("rejects duplicate repositories and a missing/multiple primary target", () => {
    expect(() =>
      buildSpecification({
        problemId: "prob-001",
        title: "x",
        targets: [{ repositoryId: "repo-a" }, { repositoryId: "repo-a" }],
      }),
    ).toThrow(/must not repeat a repository/);

    expect(() =>
      buildSpecification({
        problemId: "prob-001",
        title: "x",
        targets: [
          { repositoryId: "repo-a", role: "supporting" },
          { repositoryId: "repo-b", role: "supporting" },
        ],
      }),
    ).toThrow(/exactly one primary target/);
  });

  it("rejects an unknown status", () => {
    expect(() =>
      buildSpecification({
        problemId: "prob-001",
        title: "x",
        // @ts-expect-error invalid status on purpose
        status: "SHIPPED",
      }),
    ).toThrow(ValidationError);
  });

  it("assesses readiness from title, acceptance and targets", () => {
    expect(assessSpecification({ title: "x", acceptance: [], targets: [] })).toEqual({
      ok: false,
      issues: ["specification has no acceptance criteria", "specification has no targets"],
    });
    expect(
      assessSpecification({
        title: "x",
        acceptance: ["a"],
        targets: [{ repositoryId: "repo-a", role: "primary", position: 0 }],
      }),
    ).toEqual({ ok: true, issues: [] });
  });

  it("applies a patch without mutating the original specification", () => {
    const specification = buildSpecification({
      id: "spec-001",
      problemId: "prob-001",
      title: "x",
      targets: [{ repositoryId: "repo-a" }],
    });
    const updated = applySpecificationUpdate(specification, {
      title: " y ",
      acceptance: ["a", "a"],
      targets: [
        { repositoryId: "repo-b", role: "primary", position: 0 },
        { repositoryId: "repo-c", role: "supporting", position: 1 },
      ],
    });

    expect(updated.title).toBe("y");
    expect(updated.acceptance).toEqual(["a"]);
    expect(updated.targets.map((target) => target.repositoryId)).toEqual([
      "repo-b",
      "repo-c",
    ]);
    expect(specification.title).toBe("x");
    expect(specification.targets.map((target) => target.repositoryId)).toEqual([
      "repo-a",
    ]);
    expect(() => applySpecificationUpdate(specification, { title: " " })).toThrow(
      ValidationError,
    );
  });
});

describe("SpecificationService (TASK-1201)", () => {
  function service(events?: InMemoryEventStore) {
    const problems = new InMemoryProblemStore();
    const specifications = new InMemorySpecificationStore();
    return {
      problems,
      specifications,
      service: new SpecificationService({ specifications, problems, events }),
    };
  }

  it("derives a DRAFT specification from a confirmed problem", async () => {
    const { problems, service: svc } = service();
    const problem = await confirmedProblem(problems);

    const specification = await svc.createFromProblem({ problemId: problem.id });

    expect(specification.status).toBe("DRAFT");
    expect(specification.problemId).toBe("prob-001");
    expect(specification.title).toBe("专辑页面");
    expect(specification.summary).toBe("可以浏览专辑曲目");
    expect(specification.requirements).toEqual(["专辑页面不存在"]);
    expect(specification.constraints).toEqual({ scope: "所有用户" });
    expect(specification.targets).toEqual([
      { repositoryId: "repo-001", role: "primary", position: 0, baseRef: undefined },
    ]);
  });

  it("rejects a problem that is not confirmed", async () => {
    const { problems, service: svc } = service();
    const problem = await confirmedProblem(problems, {
      id: "prob-002",
      status: "NEEDS_INPUT",
    });

    await expect(
      svc.createFromProblem({ problemId: problem.id }),
    ).rejects.toMatchObject({ code: "problem_not_confirmed" });
  });

  it("keeps caller-supplied fields and multi-repository targets", async () => {
    const { problems, service: svc } = service();
    const problem = await confirmedProblem(problems);

    const specification = await svc.createFromProblem({
      problemId: problem.id,
      title: "自定义标题",
      summary: "自定义摘要",
      acceptance: ["a"],
      constraints: { deadline: "2026-10" },
      targets: [
        { repositoryId: "repo-a" },
        { repositoryId: "repo-b", baseRef: "develop" },
      ],
    });

    expect(specification).toMatchObject({
      title: "自定义标题",
      summary: "自定义摘要",
      acceptance: ["a"],
      constraints: { deadline: "2026-10" },
    });
    expect(specification.targets.map((target) => target.repositoryId)).toEqual([
      "repo-a",
      "repo-b",
    ]);
  });

  it("updates a DRAFT specification but freezes it once READY", async () => {
    const { problems, service: svc } = service();
    const problem = await confirmedProblem(problems);
    const specification = await svc.createFromProblem({ problemId: problem.id });

    const updated = await svc.update(specification.id, { acceptance: ["验收 1"] });
    expect(updated.acceptance).toEqual(["验收 1"]);

    const ready = await svc.markReady(specification.id);
    expect(ready.status).toBe("READY");

    await expect(
      svc.update(specification.id, { title: "改不动" }),
    ).rejects.toMatchObject({ code: "specification_not_editable" });
    await expect(svc.markReady(specification.id)).rejects.toBeInstanceOf(
      SpecificationError,
    );
  });

  it("refuses READY without acceptance criteria or targets", async () => {
    const { problems, service: svc } = service();
    const problem = await confirmedProblem(problems);
    const withoutTargets = await svc.createFromProblem({
      problemId: problem.id,
      targets: [],
    });

    await expect(svc.markReady(withoutTargets.id)).rejects.toMatchObject({
      code: "specification_incomplete",
      issues: ["specification has no acceptance criteria", "specification has no targets"],
    });

    await svc.update(withoutTargets.id, {
      acceptance: ["验收 1"],
      targets: [{ repositoryId: "repo-001" }],
    });
    await expect(svc.markReady(withoutTargets.id)).resolves.toMatchObject({
      status: "READY",
    });
  });

  it("supersedes idempotently and records events", async () => {
    const events = new InMemoryEventStore();
    const { problems, service: svc } = service(events);
    const problem = await confirmedProblem(problems);
    const specification = await svc.createFromProblem({ problemId: problem.id });
    await svc.update(specification.id, { acceptance: ["a"] });
    await svc.markReady(specification.id);

    const superseded = await svc.supersede(specification.id);
    expect(superseded.status).toBe("SUPERSEDED");
    await expect(svc.supersede(specification.id)).resolves.toMatchObject({
      status: "SUPERSEDED",
    });

    const recorded = await events.listEvents({ problemId: problem.id });
    expect(recorded.map((event) => event.type)).toEqual([
      "specification.created",
      "specification.ready",
      "specification.superseded",
    ]);
    expect(recorded[0]?.payload).toMatchObject({ specificationId: specification.id });
  });

  it("finds the latest specification of a problem", async () => {
    const { problems, service: svc } = service();
    const problem = await confirmedProblem(problems);
    const first = await svc.createFromProblem({ problemId: problem.id });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await svc.createFromProblem({ problemId: problem.id });

    await expect(svc.findForProblem(problem.id)).resolves.toMatchObject({
      id: second.id,
    });
    await expect(svc.list({ problemId: problem.id })).resolves.toHaveLength(2);
    await expect(svc.list({ status: "DRAFT" })).resolves.toHaveLength(2);
    await expect(svc.get(first.id)).resolves.toMatchObject({ id: first.id });
    await expect(svc.findForProblem("prob-missing")).resolves.toBeUndefined();
  });
});
