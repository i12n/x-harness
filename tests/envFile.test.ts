import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseEnvFile,
  serializeEnvValue,
  writeManagedEnvFile,
} from "../src/server/deployment/envFile.js";

let dir: string;
let envFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-envfile-"));
  envFile = join(dir, "ai-harness.env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseEnvFile", () => {
  it("reads bare, single-quoted and commented lines", () => {
    const values = parseEnvFile(
      [
        "# comment",
        "A=1",
        "B='hello world'",
        'C={"x":"y"}',
        "",
        "  D = spaced  ",
      ].join("\n"),
    );
    expect(values).toEqual({
      A: "1",
      B: "hello world",
      C: '{"x":"y"}',
      D: "spaced",
    });
  });
});

describe("serializeEnvValue", () => {
  it("leaves simple tokens bare and quotes everything else", () => {
    expect(serializeEnvValue("postgres://ai:ai@127.0.0.1:55432/ai_harness")).toBe(
      "postgres://ai:ai@127.0.0.1:55432/ai_harness",
    );
    expect(serializeEnvValue("hello world")).toBe("'hello world'");
    // JSON survives both systemd EnvironmentFile and `source`.
    expect(serializeEnvValue('{"a":"b"}')).toBe('\'{"a":"b"}\'');
    expect(serializeEnvValue("")).toBe("");
  });
});

describe("writeManagedEnvFile", () => {
  it("updates in place and preserves comments, order and unknown keys", async () => {
    writeFileSync(
      envFile,
      [
        "# deployment file",
        "FEISHU_APP_ID=cli_old",
        "UNRELATED_KEY=keep-me",
        "# a note about the model",
        "AI_LLM_MODEL=old-model",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = await writeManagedEnvFile(envFile, {
      FEISHU_APP_ID: "cli_new",
      AI_LLM_MODEL: "new-model",
    });

    expect(result.changed.sort()).toEqual(["AI_LLM_MODEL", "FEISHU_APP_ID"]);
    expect(result.added).toEqual([]);
    const text = readFileSync(envFile, "utf8");
    expect(text).toContain("# deployment file");
    expect(text).toContain("# a note about the model");
    expect(text).toContain("UNRELATED_KEY=keep-me");
    expect(text).toContain("FEISHU_APP_ID=cli_new");
    expect(text).toContain("AI_LLM_MODEL=new-model");
  });

  it("appends missing keys and keeps the file 0600", async () => {
    writeFileSync(envFile, "FEISHU_APP_ID=cli_x\n", { mode: 0o644 });

    const result = await writeManagedEnvFile(envFile, {
      AI_LLM_API_KEY: "sk-abc",
      AI_CODEX_CONFIG: '{"model_provider":"deepseek"}',
    });

    expect(result.added).toEqual(["AI_LLM_API_KEY", "AI_CODEX_CONFIG"]);
    const values = parseEnvFile(readFileSync(envFile, "utf8"));
    expect(values.AI_LLM_API_KEY).toBe("sk-abc");
    expect(values.AI_CODEX_CONFIG).toBe('{"model_provider":"deepseek"}');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("clears a value without deleting the key line", async () => {
    writeFileSync(envFile, "FEISHU_ALLOWED_OPEN_IDS=ou_a\n");

    await writeManagedEnvFile(envFile, { FEISHU_ALLOWED_OPEN_IDS: "" });

    const text = readFileSync(envFile, "utf8");
    expect(text.trim()).toBe("FEISHU_ALLOWED_OPEN_IDS=");
    expect(parseEnvFile(text).FEISHU_ALLOWED_OPEN_IDS).toBe("");
  });

  it("reports no change when the value is identical", async () => {
    writeFileSync(envFile, "FEISHU_APP_ID=cli_x\n");
    const result = await writeManagedEnvFile(envFile, { FEISHU_APP_ID: "cli_x" });
    expect(result.changed).toEqual([]);
  });
});
