import { describe, expect, it } from "vitest";
import {
  DuplicateSpecificationError,
  SpecificationNotFoundError,
  ValidationError,
} from "../src/errors.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";

describe("InMemorySpecificationStore", () => {
  it("creates, finds and lists specifications", async () => {
    const store = new InMemorySpecificationStore();
    const created = await store.createSpecification({
      id: "spec-001",
      problemId: "prob-001",
      title: "专辑页面",
      acceptance: ["可以打开专辑页"],
      targets: [{ repositoryId: "repo-001" }],
    });

    expect(created.status).toBe("DRAFT");
    await expect(store.findSpecification("spec-001")).resolves.toEqual(created);
    await expect(store.findSpecification("spec-missing")).rejects.toBeInstanceOf(
      SpecificationNotFoundError,
    );
    await expect(store.listSpecifications()).resolves.toHaveLength(1);
    await expect(
      store.listSpecifications({ problemId: "prob-other" }),
    ).resolves.toEqual([]);
  });

  it("rejects duplicate ids and invalid targets", async () => {
    const store = new InMemorySpecificationStore();
    await store.createSpecification({
      id: "spec-001",
      problemId: "prob-001",
      title: "a",
    });

    await expect(
      store.createSpecification({ id: "spec-001", problemId: "prob-001", title: "b" }),
    ).rejects.toBeInstanceOf(DuplicateSpecificationError);

    await expect(
      store.createSpecification({
        problemId: "prob-001",
        title: "c",
        targets: [{ repositoryId: "repo-a" }, { repositoryId: "repo-a" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("filters by status and keeps specification targets ordered", async () => {
    const store = new InMemorySpecificationStore();
    await store.createSpecification({
      id: "spec-001",
      problemId: "prob-001",
      title: "a",
      targets: [
        { repositoryId: "repo-b", role: "supporting", position: 1 },
        { repositoryId: "repo-a", role: "primary", position: 0 },
      ],
    });
    await store.createSpecification({
      id: "spec-002",
      problemId: "prob-001",
      title: "b",
      status: "READY",
    });

    const ready = await store.listSpecifications({ status: "READY" });
    expect(ready.map((specification) => specification.id)).toEqual(["spec-002"]);

    const first = await store.findSpecification("spec-001");
    expect(first.targets.map((target) => target.repositoryId)).toEqual([
      "repo-a",
      "repo-b",
    ]);
  });

  it("updates a specification and replaces its targets", async () => {
    const store = new InMemorySpecificationStore();
    await store.createSpecification({
      id: "spec-001",
      problemId: "prob-001",
      title: "a",
      targets: [{ repositoryId: "repo-a" }],
    });

    const updated = await store.updateSpecification("spec-001", {
      title: "b",
      acceptance: ["验收 1"],
      targets: [{ repositoryId: "repo-b" }],
    });

    expect(updated).toMatchObject({ title: "b", acceptance: ["验收 1"] });
    expect(updated.targets.map((target) => target.repositoryId)).toEqual(["repo-b"]);

    const statusChanged = await store.updateSpecificationStatus("spec-001", "PLANNED");
    expect(statusChanged.status).toBe("PLANNED");

    await expect(
      store.updateSpecification("spec-missing", { title: "x" }),
    ).rejects.toBeInstanceOf(SpecificationNotFoundError);
    await expect(
      store.updateSpecificationStatus("spec-missing", "READY"),
    ).rejects.toBeInstanceOf(SpecificationNotFoundError);
  });

  it("finds the latest specification of a problem", async () => {
    const store = new InMemorySpecificationStore();
    await store.createSpecification({
      id: "spec-001",
      problemId: "prob-001",
      title: "a",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.createSpecification({
      id: "spec-002",
      problemId: "prob-001",
      title: "b",
    });
    await store.createSpecification({
      id: "spec-003",
      problemId: "prob-002",
      title: "c",
    });

    await expect(store.findSpecificationByProblem("prob-001")).resolves.toMatchObject({
      id: "spec-002",
    });
    await expect(store.findSpecificationByProblem("prob-003")).resolves.toBeUndefined();
  });
});
