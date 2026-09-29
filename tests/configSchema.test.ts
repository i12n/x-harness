import { describe, expect, it } from "vitest";
import {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  agentProviderKeyName,
  resolveConfigFields,
  validateField,
  type ConfigField,
} from "../src/server/deployment/schema.js";

const field = (over: Partial<ConfigField>): ConfigField => ({
  key: "X",
  label: "X",
  type: "string",
  group: "runtime",
  ...over,
});

describe("config schema", () => {
  it("has unique keys and known groups", () => {
    const keys = CONFIG_FIELDS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of CONFIG_FIELDS) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("covers every environment variable the service reads", () => {
    const keys = new Set(CONFIG_FIELDS.map((entry) => entry.key));
    for (const expected of [
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "FEISHU_ALLOWED_OPEN_IDS",
      "FEISHU_ROLE_MAP",
      "FEISHU_DEFAULT_ROLE",
      "FEISHU_DEFAULT_CHAT_ID",
      "AI_LLM_BASE_URL",
      "AI_LLM_MODEL",
      "AI_LLM_API_KEY",
      "AI_CODEX_CONFIG",
      "AI_CODEX_BIN",
      "AI_CODEX_SANDBOX",
      "AI_RUN_TIMEOUT_MS",
      "AI_VERIFY_TIMEOUT_MS",
      "AI_EXECUTION_DRIVER",
      "AI_WORKSPACES_DIR",
      "AI_MAX_CONCURRENCY",
      "AI_DOCKER_BIN",
      "AI_PROXY_IMAGE",
      "DATABASE_URL",
      "AI_STORAGE",
      "AI_LOOP_INTERVAL_MS",
      "AI_WORKER_ID",
      "AI_CONFIG_PATH",
      "AI_DEFAULT_REPOSITORY_ID",
      "AI_AUTO_BOOTSTRAP_SPECIFICATION",
      "AI_INTENT_NOTES",
      "AI_ENV_FILE",
    ]) {
      expect(keys.has(expected), `${expected} missing from the config schema`).toBe(true);
    }
  });

  it("no longer exposes any web-console setting", () => {
    const keys = CONFIG_FIELDS.map((entry) => entry.key);
    expect(keys.filter((key) => key.startsWith("AI_ADMIN_"))).toEqual([]);
    expect(CONFIG_GROUPS.map((group) => group.id)).not.toContain("admin");
  });

  it("names the container secret after the provider env_key", () => {
    expect(agentProviderKeyName({})).toBe("DEEPSEEK_API_KEY");
    expect(
      agentProviderKeyName({
        AI_CODEX_CONFIG: '{"model_providers.openai.env_key":"OPENAI_API_KEY"}',
      }),
    ).toBe("OPENAI_API_KEY");
    const keys = resolveConfigFields({}).map((entry) => entry.key);
    expect(keys).toContain("DEEPSEEK_API_KEY");
  });
});

describe("validateField", () => {
  it("enforces required fields", () => {
    expect(validateField(field({ required: true }), " ")).toMatch(/不能为空/);
    expect(validateField(field({}), "")).toBeUndefined();
  });

  it("validates ints, bools and enums", () => {
    expect(validateField(field({ type: "int" }), "0")).toMatch(/正整数/);
    expect(validateField(field({ type: "int" }), "2000")).toBeUndefined();
    expect(validateField(field({ type: "bool" }), "yes")).toMatch(/true 或 false/);
    expect(validateField(field({ type: "enum", options: ["a", "b"] }), "c")).toMatch(/只能是/);
  });

  it("validates JSON and role maps", () => {
    expect(validateField(field({ type: "json" }), "nope")).toMatch(/JSON/);
    expect(validateField(field({ type: "json" }), '{"a":1}')).toBeUndefined();
    expect(
      validateField(field({ type: "rolemap" }), "ou_a=admin, ou_b=reviewer"),
    ).toBeUndefined();
    expect(validateField(field({ type: "rolemap" }), "ou_a=root")).toMatch(/无效/);
    expect(validateField(field({ type: "rolemap" }), '{"ou_a":"admin"}')).toBeUndefined();
  });

  it("rejects values the env file format cannot represent", () => {
    expect(validateField(field({}), "it's broken")).toMatch(/单引号/);
    expect(validateField(field({ type: "csv" }), "ou_a, ou_b")).toBeUndefined();
    expect(validateField(field({ type: "csv" }), "ou_a; rm -rf /")).toMatch(/逗号分隔/);
  });
});
