import { describe, expect, it } from "vitest";
import { describeConversationSubject } from "../src/server/subjectContext.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

async function deps() {
  return {
    problems: new InMemoryProblemStore(),
    tasks: new InMemoryTaskStore(),
    runs: new InMemoryRunStore(),
  };
}

const conversation = (over: Partial<{ subjectType: "problem" | "task" | "run"; subjectId: string }>) => ({
  id: "conv-1",
  channel: "feishu",
  externalChatId: "oc_1",
  status: "ACTIVE" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("describeConversationSubject", () => {
  it("lists open clarifications with their ids and options", async () => {
    const stores = await deps();
    await stores.problems.createProblem({ id: "prob-1", title: "空状态", statement: "首页" });
    const clarification = await stores.problems.createClarification({
      id: "clar-1",
      problemId: "prob-1",
      question: "范围是？",
      type: "scope",
      options: [
        { id: "all", label: "全部" },
        { id: "mobile", label: "仅移动端" },
      ],
      reason: "scope",
    });

    const lines = await describeConversationSubject(
      conversation({ subjectType: "problem", subjectId: "prob-1" }),
      stores,
    );

    const joined = lines.join("\n");
    expect(joined).toContain("prob-1");
    expect(joined).toContain(`clarificationId=${clarification.id}`);
    expect(joined).toContain("mobile=仅移动端");
  });

  it("reports the latest run for a task subject", async () => {
    const stores = await deps();
    await stores.tasks.createTask({
      id: "task-1",
      repositoryId: "repo-1",
      title: "Implement",
    });
    await stores.runs.createRun({
      id: "run-1",
      taskId: "task-1",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });

    const lines = await describeConversationSubject(
      conversation({ subjectType: "task", subjectId: "task-1" }),
      stores,
    );

    expect(lines.join("\n")).toContain("latest run run-1");
  });

  it("returns nothing for a conversation without a subject", async () => {
    const stores = await deps();
    expect(await describeConversationSubject(conversation({}), stores)).toEqual([]);
  });
});
