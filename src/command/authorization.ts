import { COMMAND_SCHEMAS } from "./schema.js";
import { isRole, type AuthorizationContext, type Command } from "./types.js";

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * TASK-1106: authorization is decided by the Harness, never by the Intent
 * Engine. Roles are resolved by the caller (channel → identity → roles).
 */
export function authorize(
  command: Command,
  context: AuthorizationContext,
): AuthorizationDecision {
  const roles = (context.roles ?? []).filter(isRole);
  const required = COMMAND_SCHEMAS[command.type].roles;
  if (roles.some((role) => required.includes(role))) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `${command.type} requires one of: ${required.join(", ")}`,
  };
}
