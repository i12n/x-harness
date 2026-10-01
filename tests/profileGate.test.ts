import { describe, expect, it } from "vitest";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import type { ExecutionProfile } from "../src/domain/executionProfile.js";
import {
  collectProfileIssues,
  gateRepositoryProfile,
  isHostAllowed,
  providerHostFromEnv,
} from "../src/execution/profileGate.js";
import type { ImageCheckResult } from "../src/execution/imageCheck.js";

const imagePresent = async (): Promise<ImageCheckResult> => ({ ok: true, message: "ok" });

function profile(overrides: Partial<Parameters<typeof buildExecutionProfile>[0]> = {}) {
  return buildExecutionProfile({
    name: "default",
    image: "harness/execution:node22",
    ...overrides,
  });
}

const SERVICE_ENV = {
  DEEPSEEK_API_KEY: "sk-test",
  AI_CODEX_CONFIG: JSON.stringify({
    model_providers: {
      deepseek: { base_url: "https://api.deepseek.com", env_key: "DEEPSEEK_API_KEY" },
    },
  }),
};

function gateInput(overrides: {
  profile?: ExecutionProfile;
  verificationCommands?: string[];
  env?: Record<string, string | undefined>;
}) {
  return {
    repositoryId: "repo-x",
    verificationCommands: overrides.verificationCommands ?? ["node test/verify.js"],
    profile: overrides.profile ?? profile(),
    env: overrides.env,
    checkImage: imagePresent,
  };
}

const codes = async (input: ReturnType<typeof gateInput>): Promise<string[]> =>
  (await collectProfileIssues(input)).map((issue) => issue.code);

describe("repository profile gate (TASK-1218)", () => {
  it("accepts a profile that can actually run", async () => {
    const issues = await collectProfileIssues(
      gateInput({
        profile: profile({
          network: { mode: "restricted", allow: ["api.deepseek.com"] },
          secrets: ["DEEPSEEK_API_KEY"],
        }),
        env: SERVICE_ENV,
      }),
    );
    expect(issues).toEqual([]);
  });

  it("flags a repository with no verification commands", async () => {
    expect(await codes(gateInput({ verificationCommands: [] }))).toContain(
      "no_verification_commands",
    );
  });

  it("flags a missing image", async () => {
    const issues = await collectProfileIssues({
      ...gateInput({}),
      checkImage: async () => ({ ok: false, message: "missing" }),
    });
    expect(issues.map((issue) => issue.code)).toContain("missing_image");
  });

  it("reproduces the repo-x-music failures from the service environment", async () => {
    const issues = await codes(
      gateInput({
        profile: profile({ network: { mode: "none", allow: [] }, secrets: [] }),
        env: SERVICE_ENV,
      }),
    );
    expect(issues).toContain("agent_has_no_network");
    // No secrets declared at all is its own problem: the provider config says
    // codex reads DEEPSEEK_API_KEY, and the container would never get it.
    expect(issues).toContain("provider_key_not_injected");
    expect(issues).not.toContain("unresolvable_secret");
  });

  it("accepts a declared provider key that the environment can resolve", async () => {
    const issues = await codes(
      gateInput({
        profile: profile({
          network: { mode: "restricted", allow: ["api.deepseek.com"] },
          secrets: ["DEEPSEEK_API_KEY"],
        }),
        env: SERVICE_ENV,
      }),
    );
    expect(issues).not.toContain("provider_key_not_injected");
  });

  it("flags a declared secret the service environment cannot resolve", async () => {
    const issues = await codes(
      gateInput({
        profile: profile({
          network: { mode: "restricted", allow: ["api.deepseek.com"] },
          secrets: ["DEEPSEEK_API_KEY"],
        }),
        env: {},
      }),
    );
    expect(issues).toContain("unresolvable_secret");
  });

  it("flags a restricted network that does not allow the provider host", async () => {
    const issues = await codes(
      gateInput({
        profile: profile({ network: { mode: "restricted", allow: ["example.com"] }, secrets: [] }),
        env: SERVICE_ENV,
      }),
    );
    expect(issues).toContain("provider_host_not_allowed");
  });

  it("skips environment checks when no environment is given (CLI registration)", async () => {
    const issues = await codes(
      gateInput({ profile: profile({ network: { mode: "none" }, secrets: ["NOPE"] }) }),
    );
    expect(issues).toEqual([]);
  });

  it("reports every issue at once when it refuses", async () => {
    await expect(
      gateRepositoryProfile(
        gateInput({
          verificationCommands: [],
          profile: profile({ network: { mode: "none" }, secrets: [] }),
          env: SERVICE_ENV,
        }),
      ),
    ).rejects.toThrow(/no_verification_commands|没有配置验证命令/);
  });
});

describe("provider host detection", () => {
  it("prefers the codex config provider base_url", () => {
    expect(providerHostFromEnv(SERVICE_ENV)).toBe("api.deepseek.com");
  });

  it("falls back to the intent model base url", () => {
    expect(providerHostFromEnv({ AI_LLM_BASE_URL: "https://api.example.com/v1" })).toBe(
      "api.example.com",
    );
  });

  it("returns nothing for a broken config", () => {
    expect(providerHostFromEnv({ AI_CODEX_CONFIG: "{not json" })).toBeUndefined();
  });

  it("matches subdomains but not suffix lookalikes", () => {
    expect(isHostAllowed("api.deepseek.com", ["deepseek.com"])).toBe(true);
    expect(isHostAllowed("evildeepseek.com", ["deepseek.com"])).toBe(false);
  });
});
