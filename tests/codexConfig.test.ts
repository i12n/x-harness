import { describe, expect, it } from "vitest";
import { codexConfigArgs, parseCodexConfig } from "../src/agent/codexEngine.js";

describe("parseCodexConfig", () => {
  it("reads a JSON object of overrides", () => {
    expect(
      parseCodexConfig(
        '{"model_provider":"deepseek","model_providers.deepseek.base_url":"https://api.deepseek.com"}',
      ),
    ).toEqual({
      model_provider: "deepseek",
      "model_providers.deepseek.base_url": "https://api.deepseek.com",
    });
  });

  it("reads a key=value list", () => {
    expect(parseCodexConfig("model=deepseek-v4-flash,model_provider=deepseek")).toEqual({
      model: "deepseek-v4-flash",
      model_provider: "deepseek",
    });
  });

  it("is empty when unset", () => {
    expect(parseCodexConfig(undefined)).toEqual({});
    expect(parseCodexConfig("  ")).toEqual({});
  });

  it("rejects malformed input instead of silently ignoring it", () => {
    expect(() => parseCodexConfig("{not json")).toThrowError(/not valid JSON/);
    expect(() => parseCodexConfig("nonsense")).toThrowError(/expected key=value/);
    expect(() => parseCodexConfig("[1,2]")).toThrowError(/must be an object/);
  });
});

describe("codexConfigArgs", () => {
  it("emits quoted -c arguments that a TOML parser accepts", () => {
    expect(
      codexConfigArgs({
        model_provider: "deepseek",
        "model_providers.deepseek.base_url": "https://api.deepseek.com",
      }),
    ).toEqual([
      "-c",
      'model_provider="deepseek"',
      "-c",
      'model_providers.deepseek.base_url="https://api.deepseek.com"',
    ]);
  });

  it("emits nothing without overrides", () => {
    expect(codexConfigArgs({})).toEqual([]);
  });
});
