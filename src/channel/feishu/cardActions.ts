/**
 * TASK-1216: Feishu interactive-card callbacks (`card.action.trigger`).
 *
 * The long connection hands us the *inner* event body (the same shape the
 * message handler gets), so this module only normalises it into a small,
 * transport-agnostic record. Everything about who may do what, and what a
 * click means, lives above this layer.
 */

export interface ParsedCardAction {
  /** `om_…` — the card message the user interacted with. */
  messageId: string;
  /** `oc_…` — the chat the card lives in. */
  chatId: string;
  operatorOpenId: string;
  operatorUserId?: string;
  /** Button id, e.g. `problem.clarification.answer` or `card.choice.toggle`. */
  actionId: string;
  /** Opaque string payload the button carried. */
  value?: string;
  tag: string;
}

/**
 * Returns `undefined` for anything malformed. A card action without a message
 * id, chat id, operator or action id cannot be routed, and answering it with
 * a half-built response is exactly how the client ends up showing an error.
 */
export function parseCardAction(raw: unknown): ParsedCardAction | undefined {
  const event = asRecord(raw);
  if (!event) {
    return undefined;
  }
  const context = asRecord(event.context);
  const operator = asRecord(event.operator);
  const action = asRecord(event.action);
  const messageId = firstString(context?.open_message_id, event.open_message_id);
  const chatId = firstString(context?.open_chat_id, event.open_chat_id);
  const operatorOpenId = firstString(operator?.open_id);
  if (!messageId || !chatId || !operatorOpenId || !action) {
    return undefined;
  }
  const { actionId, value } = readActionValue(action.value);
  if (!actionId) {
    return undefined;
  }
  // TASK-1269: a form submit carries the typed text next to the button value
  // (`action.form_value`), not inside it. Older/newer shapes may instead pack
  // the fields into the value record itself; fold both in so every command
  // handler keeps seeing one payload record, exactly like a plain button.
  const formValue = {
    ...scalarFields(asRecord(action.value), ["action", "value"]),
    ...scalarFields(asRecord(action.form_value) ?? asRecord(event.form_value)),
  };
  return {
    messageId,
    chatId,
    operatorOpenId,
    operatorUserId: firstString(operator?.user_id),
    actionId,
    value: mergeFormValue(value, Object.keys(formValue).length > 0 ? formValue : undefined),
    tag: firstString(action.tag) ?? "unknown",
  };
}

/** The string/number/boolean entries of a record, minus the routing keys. */
function scalarFields(
  record: Record<string, unknown> | undefined,
  exclude: string[] = [],
): Record<string, unknown> {
  if (!record) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (exclude.includes(key)) {
      continue;
    }
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
      fields[key] = field;
    }
  }
  return fields;
}

/**
 * Typed form fields win over the button's static value: the value is what the
 * card declared, the form fields are what the human just wrote.
 */
function mergeFormValue(
  value: string | undefined,
  formValue: Record<string, unknown> | undefined,
): string | undefined {
  if (!formValue || Object.keys(formValue).length === 0) {
    return value;
  }
  return JSON.stringify({ ...parseRecord(value), ...formValue });
}

function parseRecord(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Buttons built by the harness carry `{ action, value }`. Older / hand-made
 * cards may carry a bare string, and v2 form submits send a record — accept
 * all three, preferring an explicit `action` field.
 */
function readActionValue(raw: unknown): { actionId?: string; value?: string } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        return readActionValue(JSON.parse(trimmed));
      } catch {
        return { actionId: trimmed };
      }
    }
    return { actionId: trimmed || undefined };
  }
  const record = asRecord(raw);
  if (!record) {
    return {};
  }
  const actionId = firstString(record.action);
  const value = typeof record.value === "string" ? record.value : undefined;
  return { actionId, value };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
