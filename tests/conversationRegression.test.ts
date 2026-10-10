import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IntentAction } from "../src/command/types.js";
import { commandsForRequirementAction } from "../src/requirement/application/actions.js";
import { createRequirementResolver } from "../src/requirement/application/resolver.js";
import type { RequirementView } from "../src/requirement/application/resolver.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

/**
 * TASK-1267: the offline half of the conversation regression.
 *
 * The model eval (`scripts/eval-intent.mjs` + `intentPhrasings.json`) answers
 * "did we understand the sentence". This suite answers the next question:
 * **given what we understood, what does the harness do to the user** — across
 * every stage, not just the one message that started this work.
 *
 * It is table-driven from `fixtures/conversationRegression.json`, so adding a
 * phrasing is a data change, and it protects two things that were wrong before:
 * the harness must act on the user's own words, and it must never put the
 * internal task split in front of them.
 */

interface Scenario {
  titles?: string[];
  tasks: { id: string; status: string }[];
  delivery?: string;
  bound?: "task" | "problem";
}

interface CaseExpectation {
  command?: string;
  count?: number;
  payloadTaskId?: string;
  noCommands?: boolean;
  askContains?: string;
  showCard?: boolean;
}

interface Case {
  message: string;
  scenario: string;
  action: IntentAction;
  expect: CaseExpectation;
}

interface Fixture {
  scenarios: Record<string, Scenario>;
  cases: Case[];
  $voice: { forbidden: string[] };
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "conversationRegression.json"), "utf8"),
);

async function viewOf(scenario: Scenario): Promise<RequirementView> {
  const tasks = new InMemoryTaskStore();
  const specifications = new InMemorySpecificationStore();
  const plans = new InMemorySpecificationPlanStore();
  const deliveries = new InMemoryDeliveryStore();
  const problems = new InMemoryProblemStore();
  const conversations = new InMemoryConversationStore();
  const runs = new InMemoryRunStore();

  const hasRequirement = scenario.delivery !== undefined || scenario.tasks.length > 0;
  if (hasRequirement) {
    await problems.createProblem({
      id: "prob-1",
      title: "x-music 添加下载歌曲功能",
      statement: "在歌曲页面加下载",
    });
    await problems.updateProblemStatus("prob-1", "CONFIRMED");
    await specifications.createSpecification({
      id: "spec-1",
      problemId: "prob-1",
      title: "x-music 添加下载歌曲功能",
    });
  }

  for (const [index, entry] of scenario.tasks.entries()) {
    const title = scenario.titles?.[index] ?? `开发点 ${index + 1}`;
    await tasks.createTask({
      id: entry.id,
      repositoryId: "repo-1",
      title,
      status: entry.status as never,
    });
    await plans.createPlanItem({
      specificationId: "spec-1",
      position: index,
      title,
      taskId: entry.id,
    });
  }

  if (scenario.delivery) {
    await deliveries.createDelivery({
      id: "dlv-1",
      specificationId: "spec-1",
      status: scenario.delivery as never,
    });
  }
  await conversations.createConversation({
    id: "conv-1",
    channel: "feishu",
    externalChatId: "chat-1",
    subjectType: scenario.bound === "task" && scenario.tasks[0] ? "task" : "problem",
    subjectId: scenario.bound === "task" && scenario.tasks[0] ? scenario.tasks[0].id : "prob-1",
  });

  const resolver = createRequirementResolver({
    conversations,
    problems,
    specifications,
    deliveries,
    plans,
    runs,
    tasks,
  });
  return (await resolver.resolve("conv-1")) as RequirementView;
}

describe("conversation regression (TASK-1267)", () => {
  const scenarios = new Map(
    Object.entries(fixture.scenarios).map(([name, scenario]) => [
      name,
      scenario,
    ]),
  );

  it("covers every declared scenario, not just the message that started this", () => {
    const used = new Set(fixture.cases.map((entry) => entry.scenario));
    for (const name of Object.keys(fixture.scenarios)) {
      expect(used, `scenario "${name}" has no case`).toContain(name);
    }
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const entry of fixture.cases) {
    it(`${entry.scenario} · ${entry.message}`, async () => {
      const scenario = scenarios.get(entry.scenario)!;
      const view = await viewOf(scenario);
      const outcome = commandsForRequirementAction(entry.action, view);

      if (entry.expect.showCard) {
        expect(outcome.showCard).toBe(true);
        return;
      }
      if (entry.expect.noCommands) {
        expect(outcome.commands).toHaveLength(0);
      }
      if (entry.expect.command) {
        expect(outcome.commands[0]?.type).toBe(entry.expect.command);
      }
      if (entry.expect.count !== undefined) {
        expect(outcome.commands).toHaveLength(entry.expect.count);
      }
      if (entry.expect.payloadTaskId) {
        expect(outcome.commands[0]?.payload.taskId).toBe(entry.expect.payloadTaskId);
      }
      if (entry.expect.askContains) {
        expect(outcome.ask).toContain(entry.expect.askContains);
      }
      // The voice rule: whatever we say back, the internal split stays internal.
      for (const forbidden of fixture.$voice.forbidden) {
        expect(outcome.ask ?? "").not.toContain(forbidden);
      }
    });
  }
});
