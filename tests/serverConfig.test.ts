import { describe, expect, it } from "vitest";
import { loadServerConfig, resolveRoles } from "../src/server/config.js";

const BASE = {
  FEISHU_APP_ID: "cli_app",
  FEISHU_APP_SECRET: "secret",
  AI_LLM_API_KEY: "key",
};

describe("loadServerConfig", () => {
  it("requires Feishu credentials and an LLM key", () => {
    expect(() => loadServerConfig({})).toThrowError(/FEISHU_APP_ID/);
    expect(() => loadServerConfig({ FEISHU_APP_ID: "a" })).toThrowError(
      /FEISHU_APP_SECRET/,
    );
    expect(
      () => loadServerConfig({ FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "b" }),
    ).toThrowError(/AI_LLM_API_KEY/);
  });

  it("applies defaults", () => {
    const config = loadServerConfig(BASE);
    expect(config.llm.baseUrl).toBe("https://api.deepseek.com");
    expect(config.llm.model).toBe("deepseek-v4-flash");
    expect(config.loopIntervalMs).toBe(2000);
    expect(config.maxConcurrency).toBe(2);
    expect(config.executionDriver).toBe("local");
    expect(config.autoBootstrapSpecification).toBe(true);
    expect(config.access.allowedUserIds).toEqual([]);
  });

  it("parses an allow-list, role map and driver override", () => {
    const config = loadServerConfig({
      ...BASE,
      FEISHU_ALLOWED_OPEN_IDS: "ou_a, ou_b",
      FEISHU_ROLE_MAP: "ou_a=admin,ou_b=reviewer",
      AI_EXECUTION_DRIVER: "docker",
      AI_AUTO_BOOTSTRAP_SPECIFICATION: "false",
      AI_DEFAULT_REPOSITORY_ID: "repo-x",
    });
    expect(config.access.allowedUserIds).toEqual(["ou_a", "ou_b"]);
    expect(config.access.roleMap).toEqual({ ou_a: "admin", ou_b: "reviewer" });
    expect(config.executionDriver).toBe("docker");
    expect(config.autoBootstrapSpecification).toBe(false);
    expect(config.defaultRepositoryId).toBe("repo-x");
  });

  it("accepts a JSON role map and rejects invalid roles", () => {
    const config = loadServerConfig({
      ...BASE,
      FEISHU_ROLE_MAP: '{"ou_a":"reviewer"}',
    });
    expect(config.access.roleMap).toEqual({ ou_a: "reviewer" });
    expect(() => loadServerConfig({ ...BASE, FEISHU_ROLE_MAP: "ou_a=root" })).toThrowError(
      /invalid role/,
    );
    expect(() => loadServerConfig({ ...BASE, FEISHU_DEFAULT_ROLE: "root" })).toThrowError(
      /invalid role/,
    );
  });
});

describe("resolveRoles", () => {
  it("grants nothing to users outside the allow-list", () => {
    expect(
      resolveRoles(
        { allowedUserIds: ["ou_a"], roleMap: {}, defaultRole: "developer" },
        "ou_b",
      ),
    ).toEqual([]);
  });

  it("uses the explicit role, else the default", () => {
    const access = {
      allowedUserIds: ["ou_a", "ou_b"],
      roleMap: { ou_a: "reviewer" as const },
      defaultRole: "developer" as const,
    };
    expect(resolveRoles(access, "ou_a")).toEqual(["reviewer"]);
    expect(resolveRoles(access, "ou_b")).toEqual(["developer"]);
  });
});
