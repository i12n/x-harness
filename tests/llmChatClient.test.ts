import { describe, expect, it } from "vitest";
import {
  HttpChatClient,
  chatCompletionsUrl,
  extractContent,
  type ChatFetchLike,
} from "../src/llm/chatClient.js";
import { HarnessError } from "../src/errors.js";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("chat completions url", () => {
  it("accepts host, /v1 and full endpoint forms", () => {
    expect(chatCompletionsUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://host/v1/chat/completions")).toBe(
      "https://host/v1/chat/completions",
    );
  });
});

describe("HttpChatClient", () => {
  it("posts an OpenAI-compatible request and returns the message content", async () => {
    const calls: { url: string; init: Parameters<ChatFetchLike>[1] }[] = [];
    const fetchImpl: ChatFetchLike = async (url, init) => {
      calls.push({ url, init });
      return response(200, { choices: [{ message: { content: '{"ok":true}' } }] });
    };
    const client = new HttpChatClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret",
      model: "model-x",
      fetchImpl,
    });

    const content = await client.complete({
      messages: [{ role: "user", content: "hi" }],
      json: true,
    });

    expect(content).toBe('{"ok":true}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0]!.init.headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(calls[0]!.init.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("model-x");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0);
  });

  it("maps provider errors to a HarnessError with the status", async () => {
    const client = new HttpChatClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "model-x",
      fetchImpl: async () => response(429, "rate limited"),
    });

    await expect(client.complete({ messages: [] })).rejects.toThrowError(
      /status 429/,
    );
  });

  it("rejects a response without choices", async () => {
    const client = new HttpChatClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "model-x",
      fetchImpl: async () => response(200, { choices: [] }),
    });

    await expect(client.complete({ messages: [] })).rejects.toThrow(HarnessError);
  });

  it("requires an api key", () => {
    expect(
      () => new HttpChatClient({ baseUrl: "https://x", apiKey: "  ", model: "m" }),
    ).toThrowError(/api key/);
  });
});

describe("extractContent", () => {
  it("rejects non-JSON provider output", () => {
    expect(() => extractContent("<html>oops</html>")).toThrowError(/no JSON/);
  });
});
