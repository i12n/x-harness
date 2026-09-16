import { describe, expect, it } from "vitest";
import { extractAgentText, parseJsonObject } from "../src/agent/output.js";

describe("agent output helpers", () => {
  it("extracts the last agent message from codex --json JSONL", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"final {\\"ok\\":true}"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");

    expect(extractAgentText(stdout)).toBe('final {"ok":true}');
  });

  it("falls back to raw stdout for plain-text engines", () => {
    expect(extractAgentText("  plain output  ")).toBe("plain output");
  });

  it("parses JSON surrounded by prose or code fences", () => {
    expect(
      parseJsonObject('Here you go:\n```json\n{"needsInput": false}\n```\nthanks'),
    ).toEqual({ needsInput: false });
    expect(() => parseJsonObject("no json here")).toThrow();
  });
});
