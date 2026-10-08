import { isRole } from "../../command/types.js";

/**
 * The single source of truth for "everything a deployment configures".
 *
 * The chat configuration commands, the validation and the env-file writer are
 * all driven from this list, so adding a setting means adding one entry here —
 * never a second place that can drift.
 */

export type ConfigFieldType =
  | "string"
  | "secret"
  | "int"
  | "bool"
  | "enum"
  | "csv"
  | "rolemap"
  | "json"
  | "text";

export interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  group: ConfigGroupId;
  help?: string;
  placeholder?: string;
  options?: readonly string[];
  required?: boolean;
  /** Rendered under a collapsed "高级" section. */
  advanced?: boolean;
  /** Value written when the key is absent from the env file. */
  default?: string;
}

export const CONFIG_GROUPS = [
  {
    id: "channel",
    label: "飞书机器人",
    description: "长连接凭证、授权白名单与通知目标。",
  },
  {
    id: "model",
    label: "模型（控制面）",
    description: "意图解析、问题分析、规格推导使用。",
  },
  {
    id: "agent",
    label: "编码代理（Codex）",
    description: "每次 Run 在容器内执行的编码代理。",
  },
  {
    id: "execution",
    label: "执行与隔离",
    description: "驱动、工作区、容器资源与并发。",
  },
  {
    id: "git",
    label: "Git / GitHub",
    description: "取代码与推送（均在宿主机执行，agent 容器不持有任何仓库凭证）。",
  },
  {
    id: "runtime",
    label: "存储与循环",
    description: "数据库、调度循环与进程标识。",
  },
  {
    id: "behavior",
    label: "对话行为",
    description: "机器人如何把聊天变成开发流程。",
  },
  {
    id: "preview",
    label: "预览构建证据",
    description: "构建改动并收集证据（截图/产物）；部署由 GitHub Actions 负责。",
  },
] as const;

export type ConfigGroupId = (typeof CONFIG_GROUPS)[number]["id"];

const ROLES = ["guest", "developer", "reviewer", "admin"] as const;

export const CONFIG_FIELDS: readonly ConfigField[] = [
  // ---- 飞书 ---------------------------------------------------------------
  {
    key: "FEISHU_APP_ID",
    label: "App ID",
    type: "string",
    group: "channel",
    required: true,
    placeholder: "cli_xxxxxxxxxxxxxxxx",
    help: "飞书开放平台 → 凭证与基础信息。",
  },
  {
    key: "FEISHU_APP_SECRET",
    label: "App Secret",
    type: "secret",
    group: "channel",
    required: true,
    help: "长连接用它认证，不会出现在页面上。",
  },
  {
    key: "FEISHU_ALLOWED_OPEN_IDS",
    label: "授权用户（open_id）",
    type: "csv",
    group: "channel",
    placeholder: "ou_xxx, ou_yyy",
    help: "逗号分隔。留空 = 拒绝所有人；被拒的人会在聊天里收到自己的 open_id。",
  },
  {
    key: "FEISHU_ROLE_MAP",
    label: "角色分配",
    type: "rolemap",
    group: "channel",
    placeholder: "ou_xxx=admin, ou_yyy=reviewer",
    help: "未列出的人使用默认角色。格式：open_id=角色，或 JSON 对象。",
  },
  {
    key: "FEISHU_DEFAULT_ROLE",
    label: "默认角色",
    type: "enum",
    group: "channel",
    options: ROLES,
    default: "developer",
    help: "guest 只能查询/提问；developer 可确认与开工；reviewer/admin 可审批与发布。",
  },
  {
    key: "FEISHU_DEFAULT_CHAT_ID",
    label: "通知群（chat_id）",
    type: "string",
    group: "channel",
    placeholder: "oc_xxxxxxxxxxxxxxxx",
    help: "Delivery 进入 READY_FOR_RELEASE / BLOCKED 时推到这里；留空则不推送。",
  },
  {
    key: "FEISHU_BOT_OPEN_ID",
    label: "机器人 open_id",
    type: "string",
    group: "channel",
    advanced: true,
    placeholder: "留空 = 启动时自动获取",
    help: "用于判断群里是否 @ 了机器人；留空时服务启动会向飞书查询并打印。",
  },
  {
    key: "FEISHU_THREAD_REPLIES",
    label: "话题式回复",
    type: "enum",
    group: "channel",
    options: ["always", "group", "never"],
    default: "always",
    help: "always = 群和单聊都在话题里回复；group = 只有群里；never = 直接发到会话里。",
  },

  // ---- 控制面模型 ---------------------------------------------------------
  {
    key: "AI_LLM_BASE_URL",
    label: "API Base URL",
    type: "string",
    group: "model",
    default: "https://api.deepseek.com",
    help: "任意 OpenAI 兼容端点；不需要 /chat/completions 后缀。",
  },
  {
    key: "AI_LLM_MODEL",
    label: "模型名",
    type: "string",
    group: "model",
    default: "deepseek-v4-flash",
  },
  {
    key: "AI_LLM_API_KEY",
    label: "API Key",
    type: "secret",
    group: "model",
    required: true,
  },

  // ---- 编码代理 -----------------------------------------------------------
  {
    key: "AI_CODEX_CONFIG",
    label: "Codex 配置覆盖",
    type: "json",
    group: "agent",
    advanced: true,
    help:
      "以 `codex exec -c key=value` 注入。容器内没有 provider 配置，靠这里指定 provider/base_url/wire_api/env_key。",
  },
  {
    key: "AI_CODEX_BIN",
    label: "codex 可执行文件",
    type: "string",
    group: "agent",
    advanced: true,
    placeholder: "/usr/local/bin/codex",
  },
  {
    key: "AI_CODEX_SANDBOX",
    label: "沙箱模式",
    type: "string",
    group: "agent",
    advanced: true,
    placeholder: "留空 = 按执行驱动自动",
    help:
      "docker 驱动下容器即隔离边界，自动用 danger-full-access；local 驱动用 workspace-write。",
  },
  {
    key: "AI_RUN_TIMEOUT_MS",
    label: "单次 Run 超时(ms)",
    type: "int",
    group: "agent",
    advanced: true,
    placeholder: "留空 = 默认",
  },
  {
    key: "AI_VERIFY_TIMEOUT_MS",
    label: "单条验证超时(ms)",
    type: "int",
    group: "agent",
    advanced: true,
    placeholder: "留空 = 默认",
  },

  // ---- 执行与隔离 ---------------------------------------------------------
  {
    key: "AI_EXECUTION_DRIVER",
    label: "执行驱动",
    type: "enum",
    group: "execution",
    options: ["docker", "local"],
    default: "docker",
    help: "docker = 每次 Run 起一个隔离容器；local = 直接在宿主机执行。",
  },
  {
    key: "AI_WORKSPACES_DIR",
    label: "工作区目录",
    type: "string",
    group: "execution",
    placeholder: "/root/ai-workspaces",
    help: "每个 Run 一个 git worktree；docker 驱动只允许挂载这个目录下的路径。",
  },
  {
    key: "AI_MAX_CONCURRENCY",
    label: "最大并发 Run",
    type: "int",
    group: "execution",
    default: "2",
    help: "受限于机器核数与内存：2 vCPU / 2GB 建议 1。",
  },
  {
    key: "AI_DOCKER_BIN",
    label: "docker 可执行文件",
    type: "string",
    group: "execution",
    advanced: true,
    placeholder: "docker",
  },
  {
    key: "AI_PROXY_IMAGE",
    label: "网络代理镜像",
    type: "string",
    group: "execution",
    advanced: true,
    placeholder: "harness/execution-proxy:latest",
    help: "restricted 网络模式下唯一的出网通道（allow-list 代理）。",
  },

  // ---- Git / GitHub -------------------------------------------------------
  {
    key: "AI_GIT_AUTHOR_NAME",
    label: "提交作者名",
    type: "string",
    group: "git",
    default: "AI Harness",
    help: "提交时以 `git -c user.name=…` 传入，不需要在宿主机配全局 git 身份。",
  },
  {
    key: "AI_GIT_AUTHOR_EMAIL",
    label: "提交作者邮箱",
    type: "string",
    group: "git",
    default: "ai-harness@localhost",
    help: "想让它归属到 GitHub 账号，就填该账号已验证的邮箱。",
  },
  {
    key: "AI_GIT_PUSH_PREFIX",
    label: "可推送分支前缀",
    type: "string",
    group: "git",
    default: "ai/",
    help:
      "硬约束：只有这个前缀下的分支会被推送，且永不推送默认分支。" +
      "TASK-1230 的测试分支是 test/<dlv>，需要把它纳入（多个前缀用逗号分隔）。",
  },
  // ---- GitHub App（TASK-1230：部署监控）------------------------------------
  // 部署由各仓库的 GitHub Actions 负责；harness 只用 App 推测试分支、开/合并 PR、
  // 读 workflow run 状态。填了 App 三项就用 App，否则回退到 AI_GITHUB_TOKEN。
  {
    key: "AI_GITHUB_APP_ID",
    label: "GitHub App ID",
    type: "string",
    group: "git",
    advanced: true,
    placeholder: "123456",
    help: "App 的 ID；安装令牌 1 小时自动续期，无人值守不会因令牌过期停摆。",
  },
  {
    key: "AI_GITHUB_APP_ACCOUNT",
    label: "GitHub App 账号",
    type: "string",
    group: "git",
    advanced: true,
    placeholder: "i12n",
    help: "App 装在多个账号时用来选中一个；只装了一个可留空。",
  },
  {
    key: "AI_GITHUB_APP_INSTALLATION_ID",
    label: "GitHub App 安装 ID（可留空）",
    type: "string",
    group: "git",
    advanced: true,
    help: "留空则自动发现（查 App 的 installations）；装了一个账号时无需填。",
  },
  {
    key: "AI_GITHUB_APP_PRIVATE_KEY_PATH",
    label: "GitHub App 私钥路径",
    type: "string",
    group: "git",
    advanced: true,
    placeholder: "/srv/ai-harness/deploy/github-app.pem",
    help: "App 私钥文件路径（只读 600）；不要把它放进仓库。",
  },
  {
    key: "AI_GITHUB_TOKEN",
    label: "GitHub 令牌（回退）",
    type: "secret",
    group: "git",
    advanced: true,
    help: "没有配置 App 时使用的 fine-grained PAT；有有效期，建议仅作过渡。",
  },
  {
    key: "AI_GITHUB_API_BASE",
    label: "GitHub API 地址",
    type: "string",
    group: "git",
    advanced: true,
    placeholder: "https://api.github.com",
    help: "GitHub Enterprise 才需要改。",
  },
  // TASK-1231：部署监控（loop 轮询 GitHub Actions 的 run 状态并反馈）
  {
    key: "AI_DEPLOY_WATCH",
    label: "自动监控部署",
    type: "enum",
    group: "git",
    options: ["on", "off"],
    default: "on",
    help: "on：交付部署后自动轮询 run 状态并推送结果；off：只能用「部署状态」手动查。",
  },
  {
    key: "AI_DEPLOY_WATCH_INTERVAL_SECONDS",
    label: "部署轮询间隔（秒）",
    type: "int",
    group: "git",
    default: "30",
    advanced: true,
    help: "只轮询有活跃部署的交付；GitHub API 配额 5000/小时。",
  },
  {
    key: "AI_DEPLOY_WATCH_TTL_MINUTES",
    label: "部署监控超时（分钟）",
    type: "int",
    group: "git",
    default: "30",
    advanced: true,
    help: "超过这个时间仍未结束就停止跟踪并提示一次。",
  },
  {
    key: "AI_GIT_BIN",
    label: "git 可执行文件",
    type: "string",
    group: "git",
    advanced: true,
    placeholder: "git",
  },

  // ---- 存储与循环 ---------------------------------------------------------
  {
    key: "DATABASE_URL",
    label: "数据库连接串",
    type: "string",
    group: "runtime",
    required: true,
    placeholder: "postgres://ai:ai@127.0.0.1:55432/ai_harness",
  },
  {
    key: "AI_STORAGE",
    label: "存储后端",
    type: "enum",
    group: "runtime",
    options: ["postgres", "memory"],
    default: "postgres",
    help: "memory 仅用于本地试用，重启即丢数据。",
  },
  {
    key: "AI_LOOP_INTERVAL_MS",
    label: "循环间隔(ms)",
    type: "int",
    group: "runtime",
    default: "2000",
  },
  {
    key: "AI_WORKER_ID",
    label: "Worker 标识",
    type: "string",
    group: "runtime",
    advanced: true,
    placeholder: "feishu-service",
  },
  {
    key: "AI_CONFIG_PATH",
    label: "config.yaml 路径",
    type: "string",
    group: "runtime",
    advanced: true,
    help: "仅在 DATABASE_URL 未设置时用于读取 db.url。",
  },

  // ---- 对话行为 -----------------------------------------------------------
  {
    key: "AI_DEFAULT_REPOSITORY_ID",
    label: "默认开发仓库",
    type: "string",
    group: "behavior",
    placeholder: "repo-xmusic",
    help: "用户没有点名仓库时落到哪个（需先用 `ai repository create` 注册）。",
  },
  {
    key: "AI_AUTO_BOOTSTRAP_SPECIFICATION",
    label: "确认后自动推导规格并拆任务",
    type: "bool",
    group: "behavior",
    default: "true",
    help: "关闭后需要显式 `建规格`/`拆任务` 才继续。",
  },
  {
    key: "AI_INTENT_NOTES",
    label: "意图提示补充",
    type: "text",
    group: "behavior",
    advanced: true,
    help: "追加到意图模型的部署说明，例如「repo-a 是前台，repo-b 是后台」。",
  },

  {
    key: "AI_ENV_FILE",
    label: "配置文件路径",
    type: "string",
    group: "runtime",
    advanced: true,
    placeholder: "deploy/ai-harness.env",
    help: "机器人写配置时落盘的文件；改动它本身需要手动重启一次。",
  },

  // ---- 预览构建证据（TASK-1226）--------------------------------------------
  // 部署由 GitHub Actions 负责（见 docs/test-environment-deployment-plan.md），
  // 所以这里只剩 harness 仍要做的一件事：构建改动、收集证据。所有仓库共用。
  {
    key: "AI_PREVIEW_MEMORY_MB",
    label: "预览内存上限（MB）",
    type: "int",
    group: "preview",
    default: "768",
    advanced: true,
  },
  {
    key: "AI_PREVIEW_CPUS",
    label: "预览 CPU 上限",
    type: "int",
    group: "preview",
    default: "1",
    advanced: true,
  },
  {
    key: "AI_PREVIEW_ALLOW",
    label: "预览构建放行的包源",
    type: "csv",
    group: "preview",
    default: "registry.npmjs.org",
    advanced: true,
    help: "预览构建容器唯一可访问的外部主机。",
  },
];

/**
 * The provider key the agent uses inside the container. Its *name* is decided
 * by `model_providers.<id>.env_key` in AI_CODEX_CONFIG, so the page exposes
 * whichever name the deployment actually uses.
 */
export function agentProviderKeyName(
  env: Record<string, string | undefined>,
): string {
  const raw = env.AI_CODEX_CONFIG?.trim();
  if (raw?.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (/^model_providers\.[^.]+\.env_key$/.test(key) && typeof value === "string") {
          const name = value.trim();
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            return name;
          }
        }
      }
    } catch {
      // Fall through to the deployment default.
    }
  }
  return "DEEPSEEK_API_KEY";
}

export function resolveConfigFields(
  env: Record<string, string | undefined>,
): ConfigField[] {
  const providerKey = agentProviderKeyName(env);
  return [
    ...CONFIG_FIELDS,
    {
      key: providerKey,
      label: "容器内模型密钥",
      type: "secret",
      group: "agent",
      help:
        `注入到 Run 容器（仓库需以 --secret ${providerKey} 注册）。` +
        "名字由 AI_CODEX_CONFIG 的 env_key 决定。",
    },
  ];
}

export interface FieldError {
  key: string;
  message: string;
}

/** Empty is always allowed unless the field is required. */
export function validateField(field: ConfigField, raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return field.required ? `${field.label} 不能为空` : undefined;
  }
  switch (field.type) {
    case "int":
      return Number.isFinite(Number(value)) && Number(value) > 0
        ? undefined
        : `${field.label} 必须是正整数`;
    case "bool":
      return ["true", "false"].includes(value.toLowerCase())
        ? undefined
        : `${field.label} 必须是 true 或 false`;
    case "enum":
      return field.options?.includes(value)
        ? undefined
        : `${field.label} 只能是 ${field.options?.join(" | ")}`;
    case "json": {
      if (!(value.startsWith("{") || value.startsWith("["))) {
        return `${field.label} 必须是 JSON 对象或数组`;
      }
      try {
        JSON.parse(value);
        return undefined;
      } catch {
        return `${field.label} 不是合法 JSON`;
      }
    }
    case "csv":
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .every((entry) => /^[A-Za-z0-9_.:@-]+$/.test(entry))
        ? undefined
        : `${field.label} 只能包含逗号分隔的标识（不能有空格或引号）`;
    case "rolemap":
      return validateRoleMap(value);
    case "secret":
      return /[A-Za-z0-9_\-.:/@+=]/.test(value) ? undefined : `${field.label} 不是合法值`;
    default:
      // Single quotes would break both `EnvironmentFile` parsing and `source`.
      return value.includes("'") ? `${field.label} 不能包含单引号 '` : undefined;
  }
}

export function validateRoleMap(value: string): string | undefined {
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "角色分配必须是对象";
      }
      for (const role of Object.values(parsed as Record<string, unknown>)) {
        if (typeof role !== "string" || !isRole(role)) {
          return "角色只能是 guest | developer | reviewer | admin";
        }
      }
      return undefined;
    } catch {
      return "角色分配不是合法 JSON";
    }
  }
  for (const entry of value.split(",")) {
    // `=` is the stored form; `:` is accepted because that is what models
    // produce, and neither an open_id nor a role can contain either one.
    const separator = entry.search(/[=:]/);
    const userId = separator > 0 ? entry.slice(0, separator).trim() : "";
    const role = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!userId || !role) {
      return `条目 '${entry.trim()}' 应为 open_id=角色`;
    }
    if (!isRole(role)) {
      return `角色 '${role}' 无效（guest | developer | reviewer | admin）`;
    }
  }
  return undefined;
}

/** `ou_a, ou_b` → `["ou_a", "ou_b"]` (order preserved, duplicates dropped). */
export function parseCsvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Accepts both accepted spellings of the role map and normalizes to
 * `open_id=role,open_id=role` (what the env file stores).
 */
export function parseRoleMapValue(value: string | undefined): Record<string, string> {
  const raw = value?.trim();
  if (!raw) {
    return {};
  }
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [userId, role] of Object.entries(parsed)) {
        if (typeof role === "string") {
          result[userId.trim()] = role.trim();
        }
      }
      return result;
    } catch {
      return {};
    }
  }
  const result: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    // `=` is the documented separator; `:` is what models reach for, and
    // neither an open_id nor a role can contain either, so accepting both is
    // safe and removes a whole class of "the bot refused my command" moments.
    const separator = entry.search(/[=:]/);
    if (separator <= 0) {
      continue;
    }
    const userId = entry.slice(0, separator).trim();
    const role = entry.slice(separator + 1).trim();
    if (userId && role) {
      result[userId] = role;
    }
  }
  return result;
}

/** Canonical env-file form of a role map. */
export function formatRoleMap(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([userId, role]) => `${userId}=${role}`)
    .join(",");
}

export const FEISHU_OPEN_ID = /^ou_[A-Za-z0-9_-]{4,}$/;

/** Never send a secret value to the browser. */
export function isSecret(field: ConfigField): boolean {
  return field.type === "secret";
}
