import { describe, expect, it } from "vitest";
import {
  ClarificationNotFoundError,
  ProblemNotFoundError,
  ValidationError,
} from "../src/errors.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";

describe("InMemoryProblemStore", () => {
  it("creates a problem with INBOX status and optional repository", async () => {
    const store = new InMemoryProblemStore();
    const problem = await store.createProblem({
      id: "prob-001",
      title: "首页加载很慢",
      statement: "用户反馈首页加载很慢。",
    });

    expect(problem.id).toBe("prob-001");
    expect(problem.status).toBe("INBOX");
    expect(problem.repositoryId).toBeUndefined();
    expect(problem.confirmedSpec).toBeUndefined();
    expect(problem.createdAt).toBe(problem.updatedAt);
  });

  it("rejects empty title or statement", async () => {
    const store = new InMemoryProblemStore();
    await expect(
      store.createProblem({ title: "  ", statement: "x" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.createProblem({ title: "x", statement: "  " }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("filters problems by status and repository", async () => {
    const store = new InMemoryProblemStore();
    await store.createProblem({ id: "prob-001", title: "a", statement: "a", repositoryId: "repo-001" });
    await store.createProblem({ id: "prob-002", title: "b", statement: "b", repositoryId: "repo-002" });
    await store.createProblem({ id: "prob-003", title: "c", statement: "c", repositoryId: "repo-001", status: "CONFIRMED" });

    await expect(store.listProblems({ repositoryId: "repo-001" })).resolves.toHaveLength(2);
    await expect(store.listProblems({ status: "CONFIRMED" })).resolves.toMatchObject([
      { id: "prob-003" },
    ]);
    await expect(store.findProblem("prob-missing")).rejects.toBeInstanceOf(
      ProblemNotFoundError,
    );
  });

  it("advances status and stores the confirmed spec", async () => {
    const store = new InMemoryProblemStore();
    await store.createProblem({ id: "prob-001", title: "a", statement: "a" });

    const confirmed = await store.updateProblemStatus("prob-001", "CONFIRMED");
    expect(confirmed.status).toBe("CONFIRMED");

    const withSpec = await store.setProblemSpec("prob-001", {
      problem: "登录状态在页面刷新后丢失",
      expected: "刷新后仍保持登录",
      scope: "所有用户",
      investigation: "检查 Token hydration",
    });
    expect(withSpec.confirmedSpec?.expected).toBe("刷新后仍保持登录");
  });

  it("records analyses", async () => {
    const store = new InMemoryProblemStore();
    await store.createProblem({ id: "prob-001", title: "a", statement: "a" });
    await store.addAnalysis({
      problemId: "prob-001",
      summary: "首屏慢还是交互慢不明确",
      uncertainties: ["问题类型", "问题类型", "  "],
      needsInput: true,
    });

    const analyses = await store.listAnalyses("prob-001");
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.needsInput).toBe(true);
    expect(analyses[0]?.uncertainties).toEqual(["问题类型"]);
  });

  it("creates clarifications with structured options", async () => {
    const store = new InMemoryProblemStore();
    await store.createProblem({ id: "prob-001", title: "a", statement: "a" });
    const clarification = await store.createClarification({
      id: "clar-001",
      problemId: "prob-001",
      question: "“加载很慢”具体指哪一种情况？",
      type: "scope",
      options: [
        { id: "initial", label: "首次打开页面很慢" },
        { id: "interaction", label: "页面打开后操作很慢" },
        { id: "initial", label: "duplicate dropped" },
      ],
      reason: "不同类型的问题需要调查不同的技术路径",
    });

    expect(clarification.status).toBe("OPEN");
    expect(clarification.type).toBe("scope");
    expect(clarification.options.map((option) => option.id)).toEqual([
      "initial",
      "interaction",
    ]);
  });

  it("answers a clarification with an option or free text", async () => {
    const store = new InMemoryProblemStore();
    await store.createProblem({ id: "prob-001", title: "a", statement: "a" });
    await store.createClarification({
      id: "clar-001",
      problemId: "prob-001",
      question: "影响范围？",
      type: "fact",
      options: [
        { id: "all_users", label: "所有用户" },
        { id: "some_users", label: "部分用户" },
      ],
    });

    await expect(
      store.answerClarification("clar-001", { optionId: "nope" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.answerClarification("clar-001", {}),
    ).rejects.toBeInstanceOf(ValidationError);

    const answered = await store.answerClarification("clar-001", { optionId: "all_users" });
    expect(answered.status).toBe("ANSWERED");
    expect(answered.answer?.optionId).toBe("all_users");
    expect(answered.answeredAt).toBeDefined();

    const freeText = await store.createClarification({
      id: "clar-002",
      problemId: "prob-001",
      question: "其他情况？",
      type: "fact",
    });
    expect(freeText.options).toEqual([]);
    const other = await store.answerClarification("clar-002", {
      text: "只在 Safari 上出现过",
    });
    expect(other.answer?.text).toContain("Safari");

    await expect(store.findClarification("clar-missing")).rejects.toBeInstanceOf(
      ClarificationNotFoundError,
    );
  });
});
