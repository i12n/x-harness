import { readFileSync } from "node:fs";
import { StaticTokenProvider, AppTokenProvider, type GitHubTokenProvider } from "./tokenProvider.js";

/**
 * TASK-1230: how the harness reaches GitHub.
 *
 * GitHub App first (recommended): the installation token rotates hourly, so an
 * unattended service never dies at a PAT's expiry. A plain token is kept as a
 * fallback so the feature can be switched on before the App exists.
 */
export interface GitHubSettings {
  provider: GitHubTokenProvider;
  /** Test branches are `<prefix><deliveryId>`; default `test/`. */
  testBranchPrefix: string;
  apiBase?: string;
}

export type EnvLike = Record<string, string | undefined>;

export interface GitHubSettingsOptions {
  /** Injectable for tests: reads the App private key. */
  readFile?: (path: string) => string;
}

export function githubSettingsFromEnv(
  env: EnvLike = process.env,
  options: GitHubSettingsOptions = {},
): GitHubSettings | undefined {
  const apiBase = blank(env.AI_GITHUB_API_BASE);
  const appId = blank(env.AI_GITHUB_APP_ID);
  const keyPath = blank(env.AI_GITHUB_APP_PRIVATE_KEY_PATH);
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  if (appId && keyPath) {
    let privateKeyPem: string;
    try {
      privateKeyPem = read(keyPath);
    } catch (error) {
      throw new Error(
        `无法读取 GitHub App 私钥 ${keyPath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      provider: new AppTokenProvider({
        appId,
        privateKeyPem,
        ...(blank(env.AI_GITHUB_APP_INSTALLATION_ID)
          ? { installationId: blank(env.AI_GITHUB_APP_INSTALLATION_ID)! }
          : {}),
        ...(blank(env.AI_GITHUB_APP_ACCOUNT) ? { installationAccount: blank(env.AI_GITHUB_APP_ACCOUNT)! } : {}),
        ...(apiBase ? { apiBase } : {}),
      }),
      testBranchPrefix: blank(env.AI_GITHUB_TEST_BRANCH_PREFIX) ?? "test/",
      ...(apiBase ? { apiBase } : {}),
    };
  }

  const token = blank(env.AI_GITHUB_TOKEN);
  if (token) {
    return {
      provider: new StaticTokenProvider(token),
      testBranchPrefix: blank(env.AI_GITHUB_TEST_BRANCH_PREFIX) ?? "test/",
      ...(apiBase ? { apiBase } : {}),
    };
  }

  // No credential → the deployment feature is simply off (the rest of the
  // harness keeps working; `测试部署` says why it cannot run).
  return undefined;
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
