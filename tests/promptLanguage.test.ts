import { describe, expect, it } from "vitest";
import { composeAnalyzerPrompt } from "../src/problem/analyzer.js";
import { derivePrompt } from "../src/server/specificationBootstrap.js";

const problem = {
  id: "prob-1",
  title: "首页空状态",
  statement: "首页在没有数据时没有任何提示",
  status: "ANALYZING" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("chat prompts", () => {
  it("asks the analyzer to answer in the problem's language", () => {
    expect(composeAnalyzerPrompt(problem, undefined, [])).toContain(
      "SAME\nLANGUAGE as the problem statement",
    );
  });

  it("asks the specification derivation to stay at outcome level", () => {
    const prompt = derivePrompt(problem, [{ id: "repo-x", name: "x" }]);
    expect(prompt).toContain("2..4 requirements");
    expect(prompt).toContain("SAME LANGUAGE as the problem statement");
  });
});
