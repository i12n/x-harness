import {
  renderConfigAppliedMessage,
  renderConfigMessage,
  renderConfigSetMessage,
  type ConfigEntryView,
  type ConfigSetOutcomeView,
} from "../../channel/rendering/config.js";
import { renderAccessMessage, type AccessOutcomeView } from "../../channel/rendering/access.js";
import { HarnessError } from "../../errors.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

/** Domain rejection of a configuration command. */
export class ConfigAdminError extends HarnessError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigAdminError";
    this.code = code;
  }
}

export interface ConfigActor {
  channel: string;
  userId: string;
}

/**
 * Port between the command layer and the deployment's configuration store.
 *
 * The command layer must not know about env files, systemd or the schema
 * implementation, so the server composition root supplies this — the same
 * shape as every other handler dependency.
 */
export interface ConfigAdminPort {
  /** All known entries; `value` is undefined when the key is not set. */
  describe(key?: string): Promise<ConfigEntryView[]>;
  /** Non-secret values, from the language-model path. */
  set(input: { key: string; value: string; actor: ConfigActor }): Promise<ConfigSetOutcomeView>;
  /**
   * Secret values. Only the session's deterministic `设置 <KEY> <值>` router
   * reaches this — never the intent model, so the value cannot leak into a
   * model request or the conversation history.
   */
  setDirect(input: { key: string; value: string; actor: ConfigActor }): Promise<ConfigSetOutcomeView>;
  /** Number of saved values that differ from the running process. */
  pendingChanges(): Promise<number>;
  /**
   * Marks the pending values for the next process start. It does NOT restart:
   * the chat session restarts only after the reply has been delivered.
   */
  apply(actor: ConfigActor): Promise<{ pending: number }>;
  /** Shown when a secret was requested over chat. */
  secretEntryHint?(): string | undefined;
  /** Merge (never overwrite) into the allow-list / role map. */
  grantAccess(input: {
    openId: string;
    role?: string;
    actor: ConfigActor;
  }): Promise<AccessOutcomeView>;
  revokeAccess(input: { openId: string; actor: ConfigActor }): Promise<AccessOutcomeView>;
}

function reject(error: unknown): never {
  if (error instanceof ConfigAdminError) {
    throw new CommandRejectionError(error.code, error.message);
  }
  throw error;
}

/**
 * `config.show` / `config.set` / `config.apply` — the same configuration the
 * page edits, driven from chat.
 *
 * Secrets are deliberately refused: a chat message is retained by Feishu *and*
 * stored verbatim in `conversation_messages`, so a key typed here would leak
 * into two durable stores. The reply points at the config page instead.
 */
export function createConfigCommandHandlers(deps: {
  config: ConfigAdminPort;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "config.show": async (payload) => {
      const key = typeof payload.key === "string" ? payload.key.trim() : undefined;
      try {
        const entries = await deps.config.describe(key);
        return {
          entries,
          pendingChanges: await deps.config.pendingChanges(),
          message: renderConfigMessage(entries, {
            secretEntryHint: deps.config.secretEntryHint?.(),
          }),
        };
      } catch (error) {
        reject(error);
      }
    },

    "config.set": async (payload, command) => {
      try {
        const outcome = await deps.config.set({
          key: String(payload.key).trim(),
          value: String(payload.value),
          actor: { channel: command.actor.channel, userId: command.actor.userId },
        });
        return { ...outcome, message: renderConfigSetMessage(outcome) };
      } catch (error) {
        reject(error);
      }
    },

    "config.setDirect": async (payload, command) => {
      try {
        const outcome = await deps.config.setDirect({
          key: String(payload.key).trim(),
          value: String(payload.value),
          actor: { channel: command.actor.channel, userId: command.actor.userId },
        });
        return { ...outcome, message: renderConfigSetMessage(outcome) };
      } catch (error) {
        reject(error);
      }
    },

    "config.apply": async (_payload, command) => {
      try {
        const outcome = await deps.config.apply({
          channel: command.actor.channel,
          userId: command.actor.userId,
        });
        return {
          pending: outcome.pending,
          message: renderConfigAppliedMessage(outcome.pending > 0),
        };
      } catch (error) {
        reject(error);
      }
    },

    "access.grant": async (payload, command) => {
      try {
        const outcome = await deps.config.grantAccess({
          openId: String(payload.openId).trim(),
          role: typeof payload.role === "string" && payload.role.trim() ? payload.role.trim() : undefined,
          actor: { channel: command.actor.channel, userId: command.actor.userId },
        });
        return { ...outcome, message: renderAccessMessage(outcome) };
      } catch (error) {
        reject(error);
      }
    },

    "access.revoke": async (payload, command) => {
      try {
        const outcome = await deps.config.revokeAccess({
          openId: String(payload.openId).trim(),
          actor: { channel: command.actor.channel, userId: command.actor.userId },
        });
        return { ...outcome, message: renderAccessMessage(outcome) };
      } catch (error) {
        reject(error);
      }
    },
  };
}
