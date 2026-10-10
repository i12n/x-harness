import { describe, expect, it } from "vitest";
import { isCommandEnvelope } from "../src/channel/command.js";
import {
  CliChannel,
  renderOutgoingMessage,
} from "../src/channel/cli/adapter.js";
import type { IncomingMessage } from "../src/channel/message.js";

function incoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: "cli",
    conversationId: "conv-1",
    messageId: "msg-1",
    senderId: "user-1",
    text: "hello harness",
    timestamp: new Date("2026-09-19T00:00:00Z"),
    ...overrides,
  };
}

describe("Channel abstraction (TASK-1101)", () => {
  it("renders text, code and divider blocks", () => {
    expect(
      renderOutgoingMessage({
        conversationId: "conv-1",
        text: "Run: run-001",
        blocks: [
          { type: "text", text: "Targets:" },
          { type: "code", text: "npm test", language: "sh" },
          { type: "divider" },
        ],
      }),
    ).toEqual(["Run: run-001", "Targets:", "```sh", "npm test", "```", "---"]);
  });

  // TASK-1269: the 验收结果反馈 box is a real input on Feishu; the CLI fallback
  // still has to show what it is and how it is submitted.
  it("renders an input block as a labeled field plus a submit button", () => {
    expect(
      renderOutgoingMessage({
        conversationId: "conv-1",
        blocks: [
          {
            type: "input",
            name: "feedback",
            label: "验收结果反馈",
            submit: { action: "requirement.next", label: "提交验收意见" },
          },
        ],
      }),
    ).toEqual(["[输入：验收结果反馈]", "[提交验收意见]"]);
  });

  it("sends multi-line text exactly as the old CLI printed it", async () => {
    const lines: string[] = [];
    const channel = new CliChannel({ write: (line) => lines.push(line) });

    await channel.send({
      conversationId: "conv-1",
      text: ["run id: run-001", "Status: SUCCEEDED", "Targets:"].join("\n"),
    });

    expect(channel.id).toBe("cli");
    expect(lines).toEqual(["run id: run-001\nStatus: SUCCEEDED\nTargets:"]);
  });

  it("receive forwards the exact message to the handler and sends the reply", async () => {
    const received: IncomingMessage[] = [];
    const lines: string[] = [];
    const channel = new CliChannel({
      write: (line) => lines.push(line),
      onMessage: (message) => {
        received.push(message);
        return { conversationId: message.conversationId, text: `echo: ${message.text}` };
      },
    });

    await channel.receive(incoming());

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channel: "cli",
      conversationId: "conv-1",
      messageId: "msg-1",
      senderId: "user-1",
      text: "hello harness",
    });
    expect(lines).toEqual(["echo: hello harness"]);
  });

  it("receive without a handler is a no-op", async () => {
    const lines: string[] = [];
    const channel = new CliChannel({ write: (line) => lines.push(line) });
    await expect(channel.receive(incoming())).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("validates command envelopes without executing anything", () => {
    expect(isCommandEnvelope({ name: "task.approve", payload: { taskId: "T" } })).toBe(true);
    expect(isCommandEnvelope({ name: "", payload: {} })).toBe(false);
    expect(isCommandEnvelope({ name: "x" })).toBe(false);
    expect(isCommandEnvelope("task.approve")).toBe(false);
  });
});
