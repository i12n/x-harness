import { authorize } from "./authorization.js";
import type { IdempotencyStore } from "./idempotency.js";
import {
  CommandValidationError,
  validateCommand,
  type ValidateCommandOptions,
} from "./validation.js";
import type {
  AuthorizationContext,
  Command,
  CommandHandler,
  CommandResult,
  CommandType,
} from "./types.js";

export interface CommandDispatcherOptions {
  /** Explicit Command → handler map; no dynamic method lookup. */
  handlers: Partial<Record<CommandType, CommandHandler>>;
  idempotency?: IdempotencyStore;
  validateOptions?: ValidateCommandOptions;
}

/**
 * TASK-1106: the only path from a structured Command into the Harness
 * Application:
 *
 *   validate → authorize → idempotency → route(handler) → CommandResult
 *
 * Handlers are wired explicitly by the composition root; command payloads can
 * never name internal methods, stores, docker, git or workers.
 */
export class CommandDispatcher {
  private readonly handlers: Partial<Record<CommandType, CommandHandler>>;
  private readonly idempotency: IdempotencyStore | undefined;
  private readonly validateOptions: ValidateCommandOptions;

  constructor(options: CommandDispatcherOptions) {
    this.handlers = options.handlers;
    this.idempotency = options.idempotency;
    this.validateOptions = options.validateOptions ?? {};
  }

  async dispatch(
    input: unknown,
    context: AuthorizationContext,
  ): Promise<CommandResult> {
    let command: Command;
    try {
      command = validateCommand(input, this.validateOptions);
    } catch (error) {
      if (error instanceof CommandValidationError) {
        return {
          commandId: extractCommandId(input),
          type: extractCommandType(input),
          status: "rejected",
          error: { code: error.code, message: error.message },
        };
      }
      throw error;
    }

    const decision = authorize(command, context);
    if (!decision.allowed) {
      return {
        commandId: command.id,
        type: command.type,
        status: "rejected",
        error: { code: "unauthorized", message: decision.reason ?? "not allowed" },
      };
    }

    const cached = await this.idempotency?.get(command.idempotencyKey);
    if (cached) {
      return { ...cached, replayed: true };
    }

    const handler = this.handlers[command.type];
    if (!handler) {
      return {
        commandId: command.id,
        type: command.type,
        status: "failed",
        error: {
          code: "handler_not_configured",
          message: `no handler configured for ${command.type}`,
        },
      };
    }

    let result: CommandResult;
    try {
      const data = await handler(command.payload, command, context);
      result = {
        commandId: command.id,
        type: command.type,
        status: "succeeded",
        data,
      };
    } catch (error) {
      result = {
        commandId: command.id,
        type: command.type,
        status: "failed",
        error: {
          code: "handler_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    await this.idempotency?.set(command.idempotencyKey, result);
    return result;
  }
}

function extractCommandId(input: unknown): string {
  const record = asRecord(input);
  return typeof record?.id === "string" && record.id ? record.id : "unknown";
}

function extractCommandType(input: unknown): CommandType | "unknown" {
  const record = asRecord(input);
  return typeof record?.type === "string" ? (record.type as CommandType) : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
