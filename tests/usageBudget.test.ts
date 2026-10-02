import { describe, expect, it } from "vitest";
import { parseAgentUsage } from "../src/agent/usage.js";
import { TokenBudget, totalTokensOf } from "../src/loop/budget.js";
import type { Run } from "../src/domain/run.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

describe("agent usage capture (TASK-1215 ①)", () => {
  it("sums the usage codex reports over a JSONL stream", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "message" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 300 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }),
    ].join("\n");

    expect(parseAgentUsage(stdout)).toEqual({
      inputTokens: 1300,
      outputTokens: 320,
      totalTokens: 1620,
    });
  });

  it("returns nothing when the stream carries no usage", () => {
    expect(parseAgentUsage("plain output\n")).toBeUndefined();
    expect(parseAgentUsage(undefined)).toBeUndefined();
  });

  it("tolerates the OpenAI-style token field names", () => {
    expect(
      parseAgentUsage(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } })),
    ).toMatchObject({ totalTokens: 15 });
  });
});

describe("daily token budget (TASK-1215 ③)", () => {
  const run = (finishedAt: string, totalTokens: number): Run => ({
    id: `run-${finishedAt}`,
    taskId: "task-1",
    status: "SUCCEEDED",
    attempt: 1,
    agent: "codex",
    engine: "codex",
    createdAt: finishedAt,
    finishedAt,
    result: { usage: { inputTokens: totalTokens - 1, outputTokens: 1, totalTokens } },
  });

  it("counts only today's runs", async () => {
    const runs = new InMemoryRunStore();
    await runs.createRun({ id: "run-today", taskId: "task-1", attempt: 1, agent: "codex", engine: "codex" });
    await runs.completeRun("run-today", {
      status: "SUCCEEDED",
      result: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      finishedAt: "2026-10-02T05:00:00.000Z",
    });

    const budget = new TokenBudget({
      runs,
      dailyTokenBudget: 100,
      now: () => new Date("2026-10-02T12:00:00.000Z"),
    });
    expect(await budget.spentToday()).toBe(15);
    expect(await budget.canStart()).toBe(true);
  });

  it("refuses new work once the budget is spent, and reports the transition once", async () => {
    const runs = new InMemoryRunStore();
    await runs.createRun({ id: "run-1", taskId: "task-1", attempt: 1, agent: "codex", engine: "codex" });
    await runs.completeRun("run-1", {
      status: "SUCCEEDED",
      result: { usage: { inputTokens: 900, outputTokens: 200, totalTokens: 1100 } },
      finishedAt: "2026-10-02T05:00:00.000Z",
    });
    const events = new InMemoryEventStore();
    const budget = new TokenBudget({
      runs,
      events,
      dailyTokenBudget: 1000,
      now: () => new Date("2026-10-02T12:00:00.000Z"),
    });

    expect(await budget.canStart()).toBe(false);
    expect(await budget.canStart()).toBe(false);
    const emitted = await events.listEvents({ type: "TokenBudgetExhausted" });
    expect(emitted).toHaveLength(1);
  });

  it("is enabled only when a budget is configured", async () => {
    const budget = new TokenBudget({ runs: new InMemoryRunStore(), dailyTokenBudget: 0 });
    expect(budget.enabled).toBe(false);
    expect(await budget.canStart()).toBe(true);
  });

  it("reads usage out of a run result", () => {
    expect(totalTokensOf(run("2026-10-02T00:00:00.000Z", 42))).toBe(42);
    expect(totalTokensOf({ ...run("2026-10-02T00:00:00.000Z", 0), result: {} })).toBe(0);
  });
});

describe("scheduler honours the budget (TASK-1215 ③)", () => {
  it("creates no runs while the budget is exhausted", async () => {
    const tasks = new InMemoryTaskStore();
    await tasks.createTask({ id: "task-1", repositoryId: "repo-1", title: "t", status: "READY" });
    const runs = new InMemoryRunStore();

    const blocked = new Scheduler({
      taskStore: tasks,
      runStore: runs,
      budget: { canStart: async () => false },
    });
    expect(await blocked.schedule()).toEqual([]);

    const open = new Scheduler({ taskStore: tasks, runStore: runs });
    expect(await open.schedule()).toHaveLength(1);
  });
});
