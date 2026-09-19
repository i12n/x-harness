/**
 * Structured command envelope (Phase 11 / TASK-1101).
 *
 * TASK-1101 only defines the shape: natural-language → Command conversion is
 * TASK-1106, authorization is TASK-1109. Channels never build commands
 * themselves and never call the Harness directly.
 */
export interface CommandEnvelope {
  name: string;
  payload: Record<string, unknown>;
  actorId?: string;
  conversationId?: string;
  /** Idempotency key (e.g. the channel message id). */
  idempotencyKey?: string;
}

export function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    record.name.length > 0 &&
    !!record.payload &&
    typeof record.payload === "object" &&
    !Array.isArray(record.payload)
  );
}
