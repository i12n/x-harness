import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => Promise<unknown> | unknown>,
  started: false,
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  class EventDispatcher {
    register(handlers: Record<string, (data: unknown) => unknown>): this {
      Object.assign(state.handlers, handlers);
      return this;
    }
  }
  class WSClient {
    async start(): Promise<void> {
      state.started = true;
    }
    close(): void {}
  }
  return { EventDispatcher, WSClient, LoggerLevel: { info: "info" } };
});

import {
  FEISHU_CARD_ACTION_EVENT,
  FeishuLongConnection,
} from "../src/server/feishuLongConnection.js";

describe("FeishuLongConnection", () => {
  it("registers a card.action.trigger handler (the 200672 regression)", async () => {
    const connection = new FeishuLongConnection({
      appId: "cli_x",
      appSecret: "s",
      onEvent: () => {},
      onCardAction: (body) => ({ card: "answer", body }),
    });
    await connection.start();

    expect(state.started).toBe(true);
    expect(state.handlers[FEISHU_CARD_ACTION_EVENT]).toBeTypeOf("function");
    await expect(state.handlers[FEISHU_CARD_ACTION_EVENT]!({ a: 1 })).resolves.toEqual({
      card: "answer",
      body: { a: 1 },
    });
  });

  it("answers a card click even without a configured handler", async () => {
    const connection = new FeishuLongConnection({
      appId: "cli_x",
      appSecret: "s",
      onEvent: () => {},
    });
    await connection.start();

    const handler = state.handlers[FEISHU_CARD_ACTION_EVENT]!;
    // Never the SDK placeholder string, which Feishu rejects as an invalid
    // callback body — that string is what produced error 200672.
    await expect(handler({})).resolves.not.toBe("no card.action.trigger event handle");
  });
});
