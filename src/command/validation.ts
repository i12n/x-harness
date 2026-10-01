import { HarnessError } from "../errors.js";
import { makeId } from "../util/id.js";
import { COMMAND_SCHEMAS, type FieldSpec } from "./schema.js";
import {
  COMMAND_TYPES,
  COMMAND_VERSION,
  type Command,
  type CommandType,
} from "./types.js";

export class CommandValidationError extends HarnessError {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CommandValidationError";
    this.code = code;
    this.details = details;
  }
}

export interface ValidateCommandOptions {
  supportedVersion?: number;
  /** Injected for deterministic tests. */
  now?: () => string;
  makeCommandId?: () => string;
}

/**
 * TASK-1106: strict validation gate. Anything an Intent Engine produces must
 * pass through here before a dispatcher or application sees it.
 */
export function validateCommand(
  input: unknown,
  options: ValidateCommandOptions = {},
): Command {
  const record = asRecord(input, "command must be an object");

  const type = record.type;
  if (!isCommandType(type)) {
    throw new CommandValidationError(
      "unsupported_command",
      `unsupported command type: ${String(type)}`,
    );
  }

  const supportedVersion = options.supportedVersion ?? COMMAND_VERSION;
  const version = record.version ?? COMMAND_VERSION;
  if (version !== supportedVersion) {
    throw new CommandValidationError(
      "unsupported_version",
      `unsupported command version: ${String(version)}`,
    );
  }

  const actor = asRecord(record.actor, "command actor is required");
  const channel = requireNonEmptyString(actor.channel, "actor.channel");
  const userId = requireNonEmptyString(actor.userId, "actor.userId");
  const idempotencyKey = requireNonEmptyString(record.idempotencyKey, "idempotencyKey");
  const payload = validatePayload(type, record.payload);

  let conversationId: string | undefined;
  if (record.conversation !== undefined) {
    const conversation = asRecord(record.conversation, "conversation must be an object");
    conversationId = requireNonEmptyString(conversation.id, "conversation.id");
  }

  const id =
    typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : (options.makeCommandId ?? (() => makeId("cmd")))();
  const createdAt =
    typeof record.createdAt === "string" && record.createdAt
      ? record.createdAt
      : (options.now ?? (() => new Date().toISOString()))();

  return {
    id,
    type,
    version,
    actor: { channel, userId },
    conversation: conversationId ? { id: conversationId } : undefined,
    payload,
    idempotencyKey,
    createdAt,
  };
}

export function isCommandType(value: unknown): value is CommandType {
  return typeof value === "string" && (COMMAND_TYPES as readonly string[]).includes(value);
}

function validatePayload(type: CommandType, raw: unknown): Record<string, unknown> {
  const payload = asRecord(raw ?? {}, "command payload must be an object");
  const schema = COMMAND_SCHEMAS[type];
  const validated: Record<string, unknown> = {};

  for (const [field, spec] of Object.entries(schema.fields)) {
    const value = payload[field];
    if (value === undefined) {
      if (spec.required) {
        throw new CommandValidationError(
          "missing_field",
          `command ${type} requires payload.${field}`,
        );
      }
      continue;
    }
    validated[field] = validateField(type, field, spec, value);
  }

  const allowed = new Set(Object.keys(schema.fields));
  for (const field of Object.keys(payload)) {
    if (!allowed.has(field)) {
      throw new CommandValidationError(
        "unknown_field",
        `command ${type} does not accept payload.${field}`,
      );
    }
  }
  return validated;
}

function validateField(
  type: CommandType,
  field: string,
  spec: FieldSpec,
  value: unknown,
): unknown {
  if (spec.type === "string[]") {
    if (!Array.isArray(value)) {
      throw new CommandValidationError(
        "invalid_field_type",
        `command ${type} payload.${field} must be an array of non-empty strings`,
      );
    }
    return value.map((item) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new CommandValidationError(
          "invalid_field_type",
          `command ${type} payload.${field} must be an array of non-empty strings`,
        );
      }
      return item.trim();
    });
  }
  if (typeof value !== spec.type) {
    throw new CommandValidationError(
      "invalid_field_type",
      `command ${type} payload.${field} must be ${spec.type}`,
    );
  }
  if (spec.type === "string" && !(value as string).trim()) {
    throw new CommandValidationError(
      "invalid_field_type",
      `command ${type} payload.${field} must be a non-empty string`,
    );
  }
  return value;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommandValidationError("invalid_command", message);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CommandValidationError(
      "invalid_field_type",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}
