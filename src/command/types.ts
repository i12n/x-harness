export const COMMAND_VERSION = 1;

export const COMMAND_TYPES = [
  "problem.create",
  "problem.confirm",
  "problem.clarification.answer",
  "task.show",
  "task.run",
  "run.show",
  "run.cancel",
  "review.show",
  "review.list",
  "review.approve",
  "review.approve_batch",
  "review.request_changes",
  "spec.create",
  "spec.update",
  "spec.ready",
  "spec.show",
  "spec.plan",
  "delivery.show",
  "delivery.release",
  "preview.build",
  "deploy.test",
  "deploy.status",
  "deploy.promote",
  "config.show",
  "config.set",
  "config.setDirect",
  "config.apply",
  "access.grant",
  "access.revoke",
  "git.publish",
  "conversation.show",
  "repository.list",
  "repository.show",
  "task.list",
  "run.list",
  "problem.list",
  "delivery.list",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export const ROLES = ["guest", "developer", "reviewer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export interface CommandActor {
  channel: string;
  userId: string;
}

export interface Command {
  id: string;
  type: CommandType;
  version: number;
  actor: CommandActor;
  conversation?: { id: string };
  payload: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
}

export type CommandStatus = "succeeded" | "failed" | "rejected";

export interface CommandResult {
  commandId: string;
  type: CommandType | "unknown";
  status: CommandStatus;
  data?: unknown;
  error?: { code: string; message: string };
  /** True when the result was replayed from the idempotency store. */
  replayed?: boolean;
}

export interface AuthorizationContext {
  channel: string;
  userId: string;
  roles: Role[];
}

/**
 * Minimal projection of an incoming chat message. The command layer does not
 * import the channel layer; adapters map IncomingMessage → IntentInput.
 */
export interface IntentInput {
  channel: string;
  conversationId: string;
  messageId: string;
  senderId: string;
  text: string;
}

export interface IntentResult {
  /** Unvalidated command shape produced by an IntentEngine. */
  command: unknown;
  confidence?: number;
  /**
   * Triage classification (TASK: intent triage). "query" = read-only question,
   * "act" = action on existing work, "work" = new development work,
   * "chat" = neither.
   */
  kind?: "query" | "act" | "work" | "chat";
  /** Why the engine chose this — surfaced in the audit event. */
  reason?: string;
}

export interface IntentEngine {
  parse(input: IntentInput): Promise<IntentResult>;
}

export type CommandHandler = (
  payload: Record<string, unknown>,
  command: Command,
  context: AuthorizationContext,
) => Promise<unknown> | unknown;
