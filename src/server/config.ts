import { HarnessError } from "../errors.js";
import { isRole, type Role } from "../command/types.js";

/** Environment-driven configuration for the long-running Harness service. */

export interface FeishuServiceConfig {
  appId: string;
  appSecret: string;
  /** Notification fallback when a run has no chat binding (e.g. CLI-created). */
  defaultChatId?: string;
  /**
   * The bot's own open_id. Optional: it is fetched from the Feishu API at
   * startup so "was the bot mentioned?" can be answered precisely.
   */
  botOpenId?: string;
  /**
   * When the bot answers inside a topic thread on the triggering message.
   * "always" covers private chats too (verified supported by the Feishu reply
   * API); "group" keeps private chats in the main flow.
   */
  threadReplies: ThreadReplyMode;
}

export type ThreadReplyMode = "always" | "group" | "never";

export interface LlmServiceConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AccessConfig {
  /**
   * Feishu open_id allow-list. Empty denies everyone — the bot answers an
   * unknown sender with their own open_id so it can be added here. Deny by
   * default, because a chat message can start containerized code execution.
   */
  allowedUserIds: string[];
  /** open_id → role overrides. */
  roleMap: Record<string, Role>;
  /** Role granted to an allowed user without an explicit entry. */
  defaultRole: Role;
}

export interface ServerConfig {
  feishu: FeishuServiceConfig;
  llm: LlmServiceConfig;
  access: AccessConfig;
  /** Repository used when the user does not name one. */
  defaultRepositoryId?: string;
  loopIntervalMs: number;
  maxConcurrency: number;
  executionDriver: "local" | "docker";
  /** Turn a CONFIRMED problem into a READY specification + planned tasks. */
  autoBootstrapSpecification: boolean;
  /**
   * TASK-1219: run Task Intake automatically after planning so READY tasks are
   * picked up by the Scheduler without a human `运行 task-x` per task.
   */
  autoStart: boolean;
  /**
   * TASK-1221: `off` = human review only, `shadow` = record the reviewer's
   * verdict without acting on it, `on` = approve automatically when safe.
   */
  reviewer: "off" | "shadow" | "on";
  /** TASK-1215: tokens allowed per UTC day; 0 disables the guard. */
  dailyTokenBudget: number;
  /** Extra deployment knowledge appended to the intent prompt. */
  intentNotes?: string;
  /**
   * systemd EnvironmentFile the chat configuration commands read and write.
   * There is no web console: configuration is a chat surface.
   */
  configFile: string;
}

export type EnvLike = Record<string, string | undefined>;

const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";
const DEFAULT_LLM_MODEL = "deepseek-v4-flash";
const DEFAULT_LOOP_INTERVAL_MS = 2_000;
const DEFAULT_MAX_CONCURRENCY = 2;

/**
 * Reads and validates the service configuration. Throws a `HarnessError` with
 * the missing variable names instead of failing later at the first message.
 */
export function loadServerConfig(env: EnvLike = process.env): ServerConfig {
  const appId = required(env, "FEISHU_APP_ID");
  const appSecret = required(env, "FEISHU_APP_SECRET");
  const apiKey = required(env, "AI_LLM_API_KEY");

  return {
    feishu: {
      appId,
      appSecret,
      defaultChatId: optional(env, "FEISHU_DEFAULT_CHAT_ID"),
      botOpenId: optional(env, "FEISHU_BOT_OPEN_ID"),
      threadReplies: parseThreadReplies(env.FEISHU_THREAD_REPLIES),
    },
    llm: {
      baseUrl: optional(env, "AI_LLM_BASE_URL") ?? DEFAULT_LLM_BASE_URL,
      apiKey,
      model: optional(env, "AI_LLM_MODEL") ?? DEFAULT_LLM_MODEL,
    },
    access: {
      allowedUserIds: splitList(env.FEISHU_ALLOWED_OPEN_IDS),
      roleMap: parseRoleMap(env.FEISHU_ROLE_MAP),
      defaultRole: parseRole(env.FEISHU_DEFAULT_ROLE, "developer"),
    },
    defaultRepositoryId: optional(env, "AI_DEFAULT_REPOSITORY_ID"),
    loopIntervalMs: positiveInt(
      env.AI_LOOP_INTERVAL_MS,
      DEFAULT_LOOP_INTERVAL_MS,
      "AI_LOOP_INTERVAL_MS",
    ),
    maxConcurrency: positiveInt(
      env.AI_MAX_CONCURRENCY,
      DEFAULT_MAX_CONCURRENCY,
      "AI_MAX_CONCURRENCY",
    ),
    executionDriver: parseDriver(env.AI_EXECUTION_DRIVER),
    autoBootstrapSpecification: envFlag(env.AI_AUTO_BOOTSTRAP_SPECIFICATION, true),
    autoStart: envFlag(env.AI_AUTO_START, true),
    reviewer: parseReviewerMode(env.AI_REVIEWER),
    dailyTokenBudget: nonNegativeInt(env.AI_TOKEN_BUDGET_PER_DAY, "AI_TOKEN_BUDGET_PER_DAY"),
    intentNotes: optional(env, "AI_INTENT_NOTES"),
    configFile: optional(env, "AI_ENV_FILE") ?? resolveEnvFileDefault(),
  };
}

function parseReviewerMode(value: string | undefined): "off" | "shadow" | "on" {
  const mode = (value ?? "on").trim().toLowerCase();
  if (mode === "off" || mode === "shadow" || mode === "on") {
    return mode;
  }
  throw new Error(`invalid AI_REVIEWER '${value}' (use off|shadow|on)`);
}

/** Env booleans accept the usual spellings (`false`, `off`, `0`, `no`). */
function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return !["false", "off", "0", "no"].includes(value.trim().toLowerCase());
}

function parseThreadReplies(value: string | undefined): ThreadReplyMode {
  const mode = (value ?? "always").trim().toLowerCase();
  if (mode === "always" || mode === "group" || mode === "never") {
    return mode;
  }
  throw new HarnessError(
    `invalid FEISHU_THREAD_REPLIES '${value}' (use always|group|never)`,
  );
}

/** The systemd EnvironmentFile the deployment page edits by default. */
export function resolveEnvFileDefault(cwd: string = process.cwd()): string {
  return `${cwd.replace(/\/+$/, "")}/deploy/ai-harness.env`;
}

/** Roles a chat sender is granted; empty list means "not allowed". */
export function resolveRoles(config: AccessConfig, userId: string): Role[] {
  if (!config.allowedUserIds.includes(userId)) {
    return [];
  }
  const explicit = config.roleMap[userId];
  return [explicit ?? config.defaultRole];
}

function required(env: EnvLike, name: string): string {
  const value = optional(env, name);
  if (!value) {
    throw new HarnessError(`${name} is required to run the Feishu service`);
  }
  return value;
}

function optional(env: EnvLike, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseRole(value: string | undefined, fallback: Role): Role {
  const role = value?.trim();
  if (!role) {
    return fallback;
  }
  if (!isRole(role)) {
    throw new HarnessError(`invalid role '${role}' (use guest|developer|reviewer|admin)`);
  }
  return role;
}

/** `FEISHU_ROLE_MAP` accepts JSON or `ou_x=admin,ou_y=reviewer`. */
function parseRoleMap(value: string | undefined): Record<string, Role> {
  const raw = value?.trim();
  if (!raw) {
    return {};
  }
  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new HarnessError(
        `FEISHU_ROLE_MAP is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HarnessError("FEISHU_ROLE_MAP must be an object of open_id → role");
    }
    const result: Record<string, Role> = {};
    for (const [userId, role] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof role !== "string" || !isRole(role)) {
        throw new HarnessError(`FEISHU_ROLE_MAP has an invalid role for ${userId}`);
      }
      result[userId.trim()] = role;
    }
    return result;
  }
  const result: Record<string, Role> = {};
  for (const entry of raw.split(",")) {
    const [userId, role] = entry.split("=").map((part) => part.trim());
    if (!userId || !role) {
      throw new HarnessError(`invalid FEISHU_ROLE_MAP entry '${entry}' (expected open_id=role)`);
    }
    if (!isRole(role)) {
      throw new HarnessError(`invalid role '${role}' in FEISHU_ROLE_MAP`);
    }
    result[userId] = role;
  }
  return result;
}

function parseDriver(value: string | undefined): "local" | "docker" {
  const driver = (value ?? "local").trim().toLowerCase();
  if (driver === "local" || driver === "docker") {
    return driver;
  }
  throw new HarnessError(`invalid AI_EXECUTION_DRIVER '${value}' (use local|docker)`);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HarnessError(`${name} must be a positive number`);
  }
  return Math.trunc(parsed);
}

/** Like {@link positiveInt} but 0 (and an absent value) means "disabled". */
function nonNegativeInt(value: string | undefined, name: string): number {
  if (!value?.trim()) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HarnessError(`${name} must be zero or a positive number`);
  }
  return Math.trunc(parsed);
}
