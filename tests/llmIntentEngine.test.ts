import { describe, expect, it } from "vitest";
import {
  LlmIntentEngine,
  intentSystemPrompt,
  normalizeIntent,
} from "../src/command/llmIntentEngine.js";
import type { ChatClient, ChatCompletionRequest } from "../src/llm/chatClient.js";

class ScriptedChatClient implements ChatClient {
  readonly model = "test-model";
  requests: ChatCompletionRequest[] = [];
  constructor(private readonly response: string) {}
  async complete(request: ChatCompletionRequest): Promise<string> {
    this.requests.push(request);
    return this.response;
  }
}

const input = {
  channel: "feishu",
  conversationId: "conv-1",
  messageId: "om-1",
  senderId: "ou_dev",
  text: "给首页加个空状态提示",
};

describe("normalizeIntent", () => {
  it("keeps known commands and their payload", () => {
    const result = normalizeIntent({
      type: "problem.create",
      payload: { title: "t", statement: "s" },
      confidence: 0.8,
    });
    expect(result.command).toEqual({
      type: "problem.create",
      version: 1,
      payload: { title: "t", statement: "s" },
    });
    expect(result.confidence).toBe(0.8);
  });

  it("treats null, unknown and malformed types as no intent", () => {
    expect(normalizeIntent({ type: null }).command).toBeUndefined();
    expect(normalizeIntent({ type: "rm -rf /" }).command).toBeUndefined();
    expect(normalizeIntent("nope").command).toBeUndefined();
    // A command with a non-object payload still routes, with an empty payload.
    expect(normalizeIntent({ type: "task.show", payload: "x" }).command).toEqual({
      type: "task.show",
      version: 1,
      payload: {},
    });
  });
});

describe("LlmIntentEngine", () => {
  it("parses a model response into a command", async () => {
    const client = new ScriptedChatClient(
      '```json\n{"type":"task.run","payload":{"taskId":"task-1"}}\n```',
    );
    const engine = new LlmIntentEngine({ client });

    const result = await engine.parse(input);

    expect(result.command).toEqual({
      type: "task.run",
      version: 1,
      payload: { taskId: "task-1" },
    });
    expect(client.requests[0]!.json).toBe(true);
  });

  it("passes conversation context and the current message to the model", async () => {
    const client = new ScriptedChatClient('{"type":null}');
    const engine = new LlmIntentEngine({
      client,
      defaultRepositoryId: "repo-x",
      context: async () => ["user: 首页太空", "harness: 需要确认吗"],
    });

    await engine.parse(input);

    const userTurn = client.requests[0]!.messages.find((m) => m.role === "user")!.content;
    expect(userTurn).toContain("user: 首页太空");
    expect(userTurn).toContain("harness: 需要确认吗");
    expect(userTurn).toContain("给首页加个空状态提示");
    const system = client.requests[0]!.messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("repo-x");
  });

  it("lists every command type in the prompt", () => {
    const prompt = intentSystemPrompt();
    for (const type of [
      "problem.create",
      "problem.confirm",
      "problem.clarification.answer",
      "task.run",
      "run.cancel",
      "review.approve",
      "spec.create",
      "spec.update",
      "spec.ready",
      "spec.plan",
      "delivery.release",
    ]) {
      expect(prompt).toContain(type);
    }
  });
});
