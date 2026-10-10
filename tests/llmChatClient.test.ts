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

  it("keeps doubling the budget while the model only reasons", async () => {
    const calls: { url: string; init: Parameters<ChatFetchLike>[1] }[] = [];
    // A reasoning model answers 200 with content:"" and finish_reason:"length"
    // when its hidden reasoning ate the whole max_tokens budget.
    const reasoningOnly = {
      choices: [
        {
          message: { role: "assistant", content: "", reasoning_content: "thinking…" },
          finish_reason: "length",
        },
      ],
      usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8192 } },
    };
    const fetchImpl: ChatFetchLike = async (url, init) => {
      calls.push({ url, init });
    // TASK-1262: 8192 is the starting budget; two attempts burn it on hidden
    // reasoning, the third (32768) finally writes an answer.
    return calls.length <= 2
      ? response(200, reasoningOnly)
      : response(200, { choices: [{ message: { content: '{"ok":true}' } }] });
    };
    const client = new HttpChatClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "model-x",
      fetchImpl,
    });

    await expect(client.complete({ messages: [], json: true })).resolves.toBe('{"ok":true}');

    expect(calls).toHaveLength(3);
    const first = JSON.parse(calls[0]!.init.body ?? "{}") as { max_tokens: number };
    const second = JSON.parse(calls[1]!.init.body ?? "{}") as { max_tokens: number };
    const third = JSON.parse(calls[2]!.init.body ?? "{}") as { max_tokens: number };
    expect(first.max_tokens).toBe(8192);
    expect(second.max_tokens).toBe(16384);
    expect(third.max_tokens).toBe(32768);
  });

  it("gives up after three attempts and names the last budget", async () => {
    let calls = 0;
    const client = new HttpChatClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "model-x",
      fetchImpl: async () => {
        calls += 1;
        return response(200, {
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { completion_tokens_details: { reasoning_tokens: 32768 } },
        });
      },
    });

    await expect(
      client.complete({ messages: [], maxTokens: 8192 }),
    ).rejects.toThrowError(/after 3 attempts[\s\S]*32768[\s\S]*reasoning/);
    expect(calls).toBe(3);
  });

  // TASK-1261: JSON mode truncates silently — the caller only sees
  // "Unexpected end of JSON input" (this is how a problem analysis failed).
  it("buys more room when JSON mode truncated the object", async () => {
    const calls: { url: string; init: Parameters<ChatFetchLike>[1] }[] = [];
    const fetchImpl: ChatFetchLike = async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? response(200, {
            choices: [
              {
                message: { content: '{"summary":"x","clarifications":[{"question":"y"}' },
                finish_reason: "length",
              },
            ],
          })
        : response(200, { choices: [{ message: { content: '{"summary":"x"}' } }] });
    };
    const client = new HttpChatClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "model-x",
      fetchImpl,
    });

    await expect(client.complete({ messages: [], json: true })).resolves.toBe('{"summary":"x"}');

    expect(calls).toHaveLength(2);
    const second = JSON.parse(calls[1]!.init.body ?? "{}") as { max_tokens: number };
    expect(second.max_tokens).toBe(16384);
  });

  it("errors after three truncated attempts instead of handing over half an object", async () => {
    let calls = 0;
    const client = new HttpChatClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret",
      model: "model-x",
      fetchImpl: async () => {
        calls += 1;
        return response(200, {
          choices: [{ message: { content: '{"partial":' }, finish_reason: "length" }],
        });
      },
    });

    await expect(
      client.complete({ messages: [], json: true, maxTokens: 8192 }),
    ).rejects.toThrowError(/after 3 attempts[\s\S]*32768/);
    expect(calls).toBe(3);
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

  it("explains an empty answer that ran out of output budget", () => {
    expect(() =>
      extractContent(
        JSON.stringify({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { completion_tokens_details: { reasoning_tokens: 2048 } },
        }),
      ),
    ).toThrowError(/empty content: finish_reason=length/);
  });
});
