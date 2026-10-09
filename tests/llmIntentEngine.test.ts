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
      repositories: async () => [{ id: "repo-x", name: "xmusic" }],
      context: async () => ["user: 首页太空", "harness: 需要确认吗"],
    });

    await engine.parse(input);

    const userTurn = client.requests[0]!.messages.find((m) => m.role === "user")!.content;
    expect(userTurn).toContain("user: 首页太空");
    expect(userTurn).toContain("harness: 需要确认吗");
    expect(userTurn).toContain("给首页加个空状态提示");
    const system = client.requests[0]!.messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("repo-x");
    expect(system).toContain("xmusic");
    expect(system).toContain("conversation context");
  });

  it("tells the model to leave repositoryId out when nothing is registered", async () => {
    const client = new ScriptedChatClient('{"type":null}');
    const engine = new LlmIntentEngine({ client, repositories: async () => [] });

    await engine.parse(input);

    const system = client.requests[0]!.messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("none registered");
  });

  it("keeps a registered repositoryId the model resolved from context", async () => {
    const client = new ScriptedChatClient(
      '{"kind":"work","type":"problem.create","payload":{"title":"t","statement":"s","repositoryId":"repo-x"}}',
    );
    const engine = new LlmIntentEngine({
      client,
      repositories: async () => [{ id: "repo-x", name: "xmusic" }],
    });

    const result = await engine.parse(input);

    expect(result.command?.payload.repositoryId).toBe("repo-x");
  });

  it("drops a repositoryId the model invented", async () => {
    const client = new ScriptedChatClient(
      '{"kind":"work","type":"problem.create","payload":{"title":"t","statement":"s","repositoryId":"repo-ghost"}}',
    );
    const engine = new LlmIntentEngine({
      client,
      repositories: async () => [{ id: "repo-x", name: "xmusic" }],
    });

    const result = await engine.parse(input);

    expect(result.command?.payload.repositoryId).toBeUndefined();
  });

  // TASK-1244: the prompt describes user-level actions and refuses to teach the
  // model any id or layer vocabulary — the harness resolves the target itself.
  it("describes the user-level actions and none of the internal ids", () => {
    const prompt = intentSystemPrompt();
    for (const action of [
      "show",
      "reject",
      "deploy",
      "publish",
      "rerun",
      "create",
      "chat",
      "clarify",
    ]) {
      expect(prompt).toContain(action);
    }
    // The six decision rules that made the phrasing evaluation safe.
    expect(prompt).toContain("Questions first");
    expect(prompt).toContain("Bare short replies");
    expect(prompt).toContain("irreversible");
    expect(prompt).toContain("Stage decides meaning");
    // No internal ids or layer names are taught any more.
    for (const forbidden of ["prob-", "task-", "spec-", "dlv-", "review.approve"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });
});
