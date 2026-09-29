import type { ConfigEntryView, ConfigSetOutcomeView } from "../../channel/rendering/config.js";
import { ConfigAdminError, type ConfigAdminPort } from "../../command/handlers/config.js";
import { isRole } from "../../command/types.js";
import type { EventStore } from "../../store/eventStore.js";
import { readManagedEnvFile, writeManagedEnvFile } from "./envFile.js";
import {
  CONFIG_GROUPS,
  FEISHU_OPEN_ID,
  formatRoleMap,
  isSecret,
  parseCsvList,
  parseRoleMapValue,
  resolveConfigFields,
  validateField,
} from "./schema.js";

/**
 * Keys whose bad value can only be repaired on the box (SSH + file): they
 * break the bot's own connection, the database, or the harness process.
 */
const RISKY_KEYS = new Set([
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "DATABASE_URL",
  "AI_EXECUTION_DRIVER",
  "AI_WORKSPACES_DIR",
  "AI_ENV_FILE",
]);

export interface ConfigAdminPortOptions {
  envFile: string;
  env?: NodeJS.ProcessEnv;
  events?: EventStore;
}

/**
 * Chat-side configuration, written into the systemd EnvironmentFile.
 *
 * Two rules make this safe to expose to an admin in a chat client:
 *   1. `set()` refuses secrets; they only travel through `setSecret()`, which
 *      the session reaches via a deterministic pattern — the value never goes
 *      to the language model and is redacted before it reaches the database;
 *   2. saving never restarts anything. Values are validated and written, the
 *      reply shows the diff, and "重启服务" is a separate, explicit step.
 */
export function createConfigAdminPort(options: ConfigAdminPortOptions): ConfigAdminPort {
  const env = options.env ?? process.env;

  const load = async (): Promise<{
    values: Record<string, string>;
    fields: ReturnType<typeof resolveConfigFields>;
  }> => {
    const values = await readManagedEnvFile(options.envFile);
    return { values, fields: resolveConfigFields({ ...env, ...values }) };
  };

  const groupLabel = (id: string): string =>
    CONFIG_GROUPS.find((group) => group.id === id)?.label ?? id;

  const pendingChanges = async (): Promise<number> => {
    const values = await readManagedEnvFile(options.envFile);
    let pending = 0;
    for (const [key, fileValue] of Object.entries(values)) {
      if ((env[key] ?? "") !== fileValue) {
        pending += 1;
      }
    }
    return pending;
  };

  const secretEntryHint = (): string => {
    return [
      "🔑 设置密钥请用确定性格式（不经过模型、不写入会话记录）：",
      "   `设置 <KEY> <值>`   例如：`设置 FEISHU_APP_SECRET hydU…`",
      "该格式会被直接解析并写入配置；原文不会发给模型，也不会存进会话表。",
      "⚠️ 飞书自身的消息历史仍保留你发出的原文——设置完请在飞书里撤回该消息。",
    ].join("\n");
  };

  return {
    secretEntryHint,

    async describe(key) {
      const { values, fields } = await load();
      const selected = key
        ? fields.filter((field) => field.key === key)
        : fields;
      if (key && selected.length === 0) {
        throw new ConfigAdminError(
          "unknown_config_key",
          `未知配置项 ${key}（回复「查看配置」可列出全部）`,
        );
      }
      return selected.map<ConfigEntryView>((field) => {
        const stored = values[field.key];
        const isFieldSecret = isSecret(field);
        return {
          key: field.key,
          label: field.label,
          group: groupLabel(field.group),
          isSecret: isFieldSecret,
          value: stored === undefined ? undefined : isFieldSecret ? null : stored,
        };
      });
    },

    async set({ key, value, actor }) {
      const { values, fields } = await load();
      const field = fields.find((entry) => entry.key === key);
      if (!field) {
        throw new ConfigAdminError(
          "unknown_config_key",
          `未知配置项 ${key}（回复「查看配置」可列出全部）`,
        );
      }
      if (isSecret(field)) {
        throw new ConfigAdminError(
          "secret_not_accepted_in_chat",
          `${key} 是密钥类配置，不能通过聊天设置。请在配置页填写。`,
        );
      }
      const trimmed = value.trim();
      const problem = validateField(field, trimmed);
      if (problem) {
        throw new ConfigAdminError("invalid_config_value", problem);
      }

      // A model (or a hurried human) writing a list field from chat tends to
      // send only the new entry. Overwriting there would silently drop every
      // existing open_id — including the operator's own, locking them out
      // after the restart. Lists therefore only ever grow; removal has its own
      // explicit command.
      const normalized = guardListWrite(field, values, trimmed);

      const previous = values[key] ?? null;
      await writeManagedEnvFile(options.envFile, { [key]: normalized });
      await record(options.events, "config.changed", {
        key,
        previous,
        value: normalized,
        actor: `${actor.channel}:${actor.userId}`,
      });

      return {
        key,
        label: field.label,
        previous,
        value: normalized,
        restartRequired: true,
        risky: RISKY_KEYS.has(key),
      };
    },

    async setDirect({ key, value, actor }) {
      const { values, fields } = await load();
      const field = fields.find((entry) => entry.key === key);
      if (!field) {
        throw new ConfigAdminError(
          "unknown_config_key",
          `未知配置项 ${key}（回复「查看配置」可列出全部）`,
        );
      }
      const trimmed = value.trim();
      if (!trimmed) {
        throw new ConfigAdminError("invalid_config_value", `${key} 的值不能为空`);
      }
      if (trimmed.includes("'") || /[\r\n]/.test(value)) {
        throw new ConfigAdminError(
          "invalid_config_value",
          `${key} 的值不能包含单引号或换行（环境文件格式限制）`,
        );
      }

      // Secrets are opaque tokens: never apply the semantic validators to them.
      if (!isSecret(field)) {
        const problem = validateField(field, trimmed);
        if (problem) {
          throw new ConfigAdminError("invalid_config_value", problem);
        }
        const normalized = guardListWrite(field, values, trimmed);
        const previous = values[key] ?? null;
        await writeManagedEnvFile(options.envFile, { [key]: normalized });
        await record(options.events, "config.changed", {
          key,
          previous,
          value: normalized,
          actor: `${actor.channel}:${actor.userId}`,
        });
        return {
          key,
          label: field.label,
          previous,
          value: normalized,
          restartRequired: true,
          risky: RISKY_KEYS.has(key),
        };
      }

      const hadPrevious = (values[key] ?? "") !== "";
      await writeManagedEnvFile(options.envFile, { [key]: trimmed });
      // Audit records the key and who changed it — never the value.
      await record(options.events, "config.secret_changed", {
        key,
        hadPrevious,
        actor: `${actor.channel}:${actor.userId}`,
      });

      return {
        key,
        label: field.label,
        previous: hadPrevious ? "***" : null,
        value: "***",
        secret: true,
        restartRequired: true,
        risky: RISKY_KEYS.has(key),
      };
    },

    pendingChanges,

    async apply(actor) {
      const pending = await pendingChanges();
      if (pending > 0) {
        await record(options.events, "config.apply_requested", {
          pending,
          actor: `${actor.channel}:${actor.userId}`,
        });
      }
      return { pending };
    },

    async grantAccess({ openId, role, actor }) {
      if (!FEISHU_OPEN_ID.test(openId)) {
        throw new ConfigAdminError(
          "invalid_open_id",
          `open_id 形如 ou_xxx（收到的是 ${openId}）`,
        );
      }
      if (role !== undefined && !isRole(role)) {
        throw new ConfigAdminError(
          "invalid_role",
          `角色只能是 guest | developer | reviewer | admin（收到的是 ${role}）`,
        );
      }

      const values = await readManagedEnvFile(options.envFile);
      const allowed = parseCsvList(values.FEISHU_ALLOWED_OPEN_IDS);
      const roles = parseRoleMapValue(values.FEISHU_ROLE_MAP);
      const changed =
        !allowed.includes(openId) || (role !== undefined && roles[openId] !== role);
      if (!allowed.includes(openId)) {
        allowed.push(openId);
      }
      if (role !== undefined) {
        roles[openId] = role;
      }

      if (changed) {
        await writeManagedEnvFile(options.envFile, {
          FEISHU_ALLOWED_OPEN_IDS: allowed.join(","),
          FEISHU_ROLE_MAP: formatRoleMap(roles),
        });
        await record(options.events, "access.granted", {
          openId,
          role: role ?? null,
          actor: `${actor.channel}:${actor.userId}`,
        });
      }
      return { action: "granted", openId, role, changed, allowed };
    },

    async revokeAccess({ openId, actor }) {
      if (!FEISHU_OPEN_ID.test(openId)) {
        throw new ConfigAdminError(
          "invalid_open_id",
          `open_id 形如 ou_xxx（收到的是 ${openId}）`,
        );
      }
      const values = await readManagedEnvFile(options.envFile);
      const allowed = parseCsvList(values.FEISHU_ALLOWED_OPEN_IDS).filter(
        (entry) => entry !== openId,
      );
      const roles = parseRoleMapValue(values.FEISHU_ROLE_MAP);
      const changed = allowed.includes(openId) || openId in roles;
      delete roles[openId];

      if (allowed.length === 0) {
        // Never leave the deployment with nobody able to talk to it.
        throw new ConfigAdminError(
          "last_admin_protected",
          `${openId} 是允许列表里最后一个人，已拒绝移除；请先授权其他人`,
        );
      }
      if (changed) {
        await writeManagedEnvFile(options.envFile, {
          FEISHU_ALLOWED_OPEN_IDS: allowed.join(","),
          FEISHU_ROLE_MAP: formatRoleMap(roles),
        });
        await record(options.events, "access.revoked", {
          openId,
          actor: `${actor.channel}:${actor.userId}`,
        });
      }
      return { action: "revoked", openId, changed, allowed };
    },
  };
}

/**
 * List-shaped values (`FEISHU_ALLOWED_OPEN_IDS`, `FEISHU_ROLE_MAP`) may be
 * extended from chat but never silently shrunk. The role map is normalized so
 * `ou_x:admin` (what models like to emit) and `ou_x=admin` both work.
 */
function guardListWrite(
  field: { key: string; type: string },
  current: Record<string, string>,
  next: string,
): string {
  if (field.type === "csv") {
    const before = parseCsvList(current[field.key]);
    const after = parseCsvList(next);
    const removed = before.filter((entry) => !after.includes(entry));
    if (removed.length > 0) {
      throw new ConfigAdminError(
        "config_list_shrink_refused",
        `${field.key} 现有 ${before.length} 项，本次会移除 ${removed.join(", ")}；` +
          "用「移除 ou_xxx」或配置页操作（避免把自己锁在外面）",
      );
    }
    return after.join(",");
  }
  if (field.type === "rolemap") {
    const before = parseRoleMapValue(current[field.key]);
    const after = parseRoleMapValue(next);
    const removed = Object.keys(before).filter((userId) => !(userId in after));
    if (removed.length > 0) {
      throw new ConfigAdminError(
        "config_list_shrink_refused",
        `${field.key} 会移除 ${removed.join(", ")}；用「移除 ou_xxx」或配置页操作`,
      );
    }
    return formatRoleMap(after);
  }
  return next;
}

async function record(
  events: EventStore | undefined,
  type: string,
  payload: unknown,
): Promise<void> {
  if (!events) {
    return;
  }
  try {
    await events.record({ type, payload });
  } catch {
    // Auditing must never fail the operation itself.
  }
}
