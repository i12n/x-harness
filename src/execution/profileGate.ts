import type { ExecutionProfile } from "../domain/executionProfile.js";
import { HarnessError } from "../errors.js";
import { checkLocalExecutionImage, type ImageChecker } from "./imageCheck.js";

export interface ProfileGateIssue {
  code: string;
  message: string;
}

export interface RepositoryProfileGateInput {
  repositoryId: string;
  verificationCommands: string[];
  profile: ExecutionProfile;
  /**
   * Environment that will resolve secrets and provide the provider URL.
   * Omitted at registration (the CLI shell is not the service environment, so
   * a secret missing here proves nothing); supplied by the service preflight.
   */
  env?: Record<string, string | undefined>;
  /** Refuse a repository whose Runs could never be verified. Default true. */
  requireVerification?: boolean;
  checkImage?: ImageChecker;
}

/**
 * TASK-1218: everything that would make a repository's Runs fail, checked while
 * a human is still in the loop instead of at Run time.
 *
 * The second production failure in a row came from a profile that was valid in
 * shape but unusable in practice: `repo-x-music` had no verification commands
 * (so verification is designed to FAIL), no secrets (so nothing injected
 * DEEPSEEK_API_KEY) and `network: none` (so the agent could not reach its model
 * provider). Each of those is detectable before the first Run.
 */
export async function collectProfileIssues(
  input: RepositoryProfileGateInput,
): Promise<ProfileGateIssue[]> {
  const issues: ProfileGateIssue[] = [];
  const { profile } = input;

  if ((input.requireVerification ?? true) && input.verificationCommands.length === 0) {
    issues.push({
      code: "no_verification_commands",
      message:
        "没有配置验证命令：没有验证的 Run 不会被当作成功（每个 Run 都会 FAIL）。" +
        "用 --verify \"<命令>\" 指定（可重复）。",
    });
  }

  const checkImage = input.checkImage ?? checkLocalExecutionImage;
  const image = await checkImage(profile.image);
  if (!image.ok) {
    issues.push({ code: "missing_image", message: image.message });
  }

  const env = input.env;
  if (!env) {
    return issues;
  }

  const missingSecrets = profile.secrets.filter(
    (name) => !env[`AI_SECRET_${name}`] && !env[name],
  );
  if (missingSecrets.length > 0) {
    issues.push({
      code: "unresolvable_secret",
      message:
        `执行档案声明了 secret ${missingSecrets.join(", ")}，但服务环境里没有对应值` +
        "（AI_SECRET_<NAME> 或 <NAME>）——Run 时容器里不会有这个变量。",
    });
  }

  // A declared secret can still be the wrong secret: the provider config names
  // the env var codex will read, and if that name is not in the profile the
  // container simply will not have it.
  const requiredKeys = providerEnvKeysFromEnv(env).filter(
    (key) => !profile.secrets.includes(key),
  );
  if (requiredKeys.length > 0) {
    issues.push({
      code: "provider_key_not_injected",
      message:
        `服务环境用 ${requiredKeys.join(", ")} 调模型，但执行档案没有声明它` +
        `——Run 时容器里不会有这个变量。用 --secret ${requiredKeys[0]} 补上。`,
    });
  }

  const providerHost = providerHostFromEnv(env);
  if (profile.network.mode === "none") {
    issues.push({
      code: "agent_has_no_network",
      message:
        "网络模式是 none：容器没有任何出网，agent 够不到模型服务" +
        (providerHost ? `（${providerHost}）` : "") +
        "，会在几秒内以非零码退出。改成 --network restricted --allow <provider 域名>。",
    });
  } else if (providerHost && !isHostAllowed(providerHost, profile.network.allow)) {
    issues.push({
      code: "provider_host_not_allowed",
      message:
        `网络是 restricted，但允许列表里没有 provider 域名 ${providerHost}` +
        `（当前：${profile.network.allow.join(", ") || "空"}）——agent 会被代理拒绝。`,
    });
  }

  return issues;
}

/**
 * Hard gate for registration/update. All issues are reported at once so one
 * fix pass is enough.
 */
export async function gateRepositoryProfile(
  input: RepositoryProfileGateInput,
): Promise<void> {
  const issues = await collectProfileIssues(input);
  if (issues.length === 0) {
    return;
  }
  throw new HarnessError(
    [
      `仓库 ${input.repositoryId} 的执行档案会让每个 Run 失败：`,
      ...issues.map((issue) => `  · ${issue.message}`),
      "确认无误可用 --skip-profile-check 跳过这些检查。",
    ].join("\n"),
  );
}

/** Provider host the agent must reach, taken from the service environment. */
export function providerHostFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return parseProviderConfig(env).hosts[0];
}

/** `env_key` names the provider config tells codex to read. */
export function providerEnvKeysFromEnv(
  env: Record<string, string | undefined>,
): string[] {
  return parseProviderConfig(env).envKeys;
}

function parseProviderConfig(env: Record<string, string | undefined>): {
  hosts: string[];
  envKeys: string[];
} {
  const hosts: string[] = [];
  const envKeys: string[] = [];
  const codexConfig = env.AI_CODEX_CONFIG;
  if (codexConfig) {
    try {
      const parsed = JSON.parse(codexConfig) as {
        model_providers?: Record<string, { base_url?: unknown; env_key?: unknown }>;
      };
      for (const provider of Object.values(parsed.model_providers ?? {})) {
        const host = hostOf(provider?.base_url);
        if (host) {
          hosts.push(host);
        }
        if (typeof provider?.env_key === "string" && provider.env_key.trim()) {
          envKeys.push(provider.env_key.trim());
        }
      }
    } catch {
      // Fall through to the intent-model URL.
    }
  }
  const fallback = hostOf(env.AI_LLM_BASE_URL);
  if (fallback) {
    hosts.push(fallback);
  }
  return { hosts, envKeys };
}

export function isHostAllowed(host: string, allow: string[]): boolean {
  const candidate = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const allowed = entry.toLowerCase().replace(/\.$/, "");
    return allowed.length > 0 && (candidate === allowed || candidate.endsWith(`.${allowed}`));
  });
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url.trim()) {
    return undefined;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
