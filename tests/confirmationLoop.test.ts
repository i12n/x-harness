import { describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { HarnessError } from "../src/errors.js";
import { ProblemAnalyzer } from "../src/problem/analyzer.js";
import { ConfirmationLoop } from "../src/problem/confirmationLoop.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";

class QueueEngine implements AgentEngine {
  readonly prompts: string[] = [];
  constructor(private readonly outputs: string[]) {}

  async execute(context: AgentContext): Promise<AgentResult> {
    this.prompts.push(context.prompt);
    const stdout = this.outputs.shift() ?? "";
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout,
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  async cancel(): Promise<void> {}
}

const NEEDS_INPUT_JSON = JSON.stringify({
  summary: "需要先确认“慢”的类型",
  needsInput: true,
  uncertainties: ["问题类型"],
  clarifications: [
    {
      question: "“加载很慢”具体是指哪一种情况？",
      type: "scope",
      required: true,
      options: [
        { id: "initial", label: "首次打开页面很慢" },
        { id: "interaction", label: "页面打开后操作很慢" },
      ],
      reason: "不同类型的问题需要调查不同的技术路径",
    },
  ],
});

const SUFFICIENT_JSON = JSON.stringify({
  summary: "已明确：首屏加载慢，范围所有用户",
  needsInput: false,
  uncertainties: [],
  clarifications: [],
});

describe("ConfirmationLoop", () => {
  async function setup(outputs: string[]) {
    const problems = new InMemoryProblemStore();
    const events = new InMemoryEventStore();
    const engine = new QueueEngine(outputs);
    const loop = new ConfirmationLoop({
      problems,
      events,
      analyzer: new ProblemAnalyzer(engine),
    });
    await problems.createProblem({
      id: "prob-001",
      title: "首页加载很慢",
      statement: "用户反馈首页加载很慢。",
    });
    return { problems, events, engine, loop };
  }

  it("creates clarifications instead of asking for free-form input", async () => {
    const { problems, events, loop } = await setup([NEEDS_INPUT_JSON]);

    const outcome = await loop.analyze("prob-001");

    expect(outcome.needsInput).toBe(true);
    expect(outcome.problem.status).toBe("NEEDS_INPUT");
    expect(outcome.clarifications).toHaveLength(1);
    expect(outcome.clarifications[0]?.options.map((option) => option.id)).toEqual([
      "initial",
      "interaction",
    ]);
    expect((await problems.listAnalyses("prob-001"))[0]?.needsInput).toBe(true);

    const types = (await events.listEvents({ problemId: "prob-001" })).map((e) => e.type);
    expect(types).toEqual(["problem.analysis.updated", "problem.clarification.created"]);
  });

  it("re-analyses after the answer and confirms when information is sufficient", async () => {
    const { problems, events, engine, loop } = await setup([
      NEEDS_INPUT_JSON,
      SUFFICIENT_JSON,
    ]);
    const first = await loop.analyze("prob-001");
    const clarificationId = first.clarifications[0]?.id;

    const outcome = await loop.answer("prob-001", clarificationId!, {
      optionId: "initial",
    });

    expect(outcome.needsInput).toBe(false);
    expect(outcome.problem.status).toBe("CONFIRMED");
    expect((await problems.listAnalyses("prob-001"))).toHaveLength(2);
    expect((await problems.findClarification(clarificationId!)).status).toBe("ANSWERED");

    const types = (await events.listEvents({ problemId: "prob-001" })).map((e) => e.type);
    expect(types).toEqual([
      "problem.analysis.updated",
      "problem.clarification.created",
      "problem.clarification.answered",
      "problem.analysis.updated",
      "problem.confirmed",
    ]);
    // The re-analysis prompt must carry the answered clarification so the
    // model does not ask the same question again.
    expect(engine.prompts[1]).toContain("Clarifications already answered");
    expect(engine.prompts[1]).toContain("首次打开页面很慢");
  });

  it("keeps waiting when other clarifications are still open", async () => {
    const twoQuestions = JSON.stringify({
      summary: "两个待确认项",
      needsInput: true,
      uncertainties: ["范围", "约束"],
      clarifications: [
        { question: "影响范围？", type: "fact", required: true, options: [{ id: "all", label: "所有用户" }], reason: "r" },
        { question: "允许改 schema 吗？", type: "constraint", required: true, options: [{ id: "yes", label: "允许" }], reason: "r" },
      ],
    });
    const { loop } = await setup([twoQuestions]);
    const first = await loop.analyze("prob-001");

    const outcome = await loop.answer("prob-001", first.clarifications[0]!.id, {
      optionId: "all",
    });

    expect(outcome.needsInput).toBe(true);
    expect(outcome.problem.status).toBe("ANSWERED");
    expect(outcome.clarifications.map((clarification) => clarification.id)).toEqual([
      first.clarifications[1]!.id,
    ]);
  });

  it("accepts codex JSONL output as well as plain stdout", async () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":${JSON.stringify(
        NEEDS_INPUT_JSON,
      )}}}`,
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");
    const { loop } = await setup([jsonl]);

    const outcome = await loop.analyze("prob-001");
    expect(outcome.clarifications).toHaveLength(1);
  });

  it("fails loudly when the analyzer returns no valid JSON", async () => {
    const { loop } = await setup(["I could not analyze this."]);
    await expect(loop.analyze("prob-001")).rejects.toBeInstanceOf(HarnessError);
  });
});
