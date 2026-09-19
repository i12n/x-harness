import type { IncomingMessage } from "../message.js";

export const FEISHU_MESSAGE_EVENT = "im.message.receive_v1";

export interface ParseFeishuOptions {
  channel?: string;
  now?: () => number;
}

export type ParsedFeishuEvent =
  | { kind: "message"; message: IncomingMessage }
  | { kind: "ignored"; reason: string; eventType?: string };

/**
 * Parses a Feishu event callback into the Harness' IncomingMessage. Unsupported
 * events are ignored explicitly; conversations never see raw Feishu JSON.
 */
export function parseFeishuEvent(
  payload: Record<string, unknown>,
  options: ParseFeishuOptions = {},
): ParsedFeishuEvent {
  const header = asRecord(payload.header);
  const eventType =
    (typeof header?.event_type === "string" ? header.event_type : undefined) ??
    (typeof payload.type === "string" ? payload.type : undefined);
  if (eventType !== FEISHU_MESSAGE_EVENT) {
    return {
      kind: "ignored",
      reason: eventType ? `unsupported event: ${eventType}` : "unsupported event",
      eventType,
    };
  }

  const event = asRecord(payload.event);
  const message = asRecord(event?.message);
  const sender = asRecord(event?.sender);
  const senderIds = asRecord(sender?.sender_id);
  if (!message) {
    return { kind: "ignored", reason: "malformed message event", eventType };
  }

  const messageType = typeof message.message_type === "string" ? message.message_type : "text";
  if (messageType !== "text") {
    return {
      kind: "ignored",
      reason: `unsupported message type: ${messageType}`,
      eventType,
    };
  }
  const messageId = typeof message.message_id === "string" ? message.message_id : "";
  const chatId = typeof message.chat_id === "string" ? message.chat_id : "";
  if (!messageId || !chatId) {
    return { kind: "ignored", reason: "malformed message event", eventType };
  }

  const text = extractText(message.content);
  const senderId =
    firstString(senderIds?.open_id, senderIds?.union_id, senderIds?.user_id) ?? "";
  const threadId =
    firstString(message.thread_id, message.root_id, message.parent_id) ?? undefined;
  const createTime = firstString(message.create_time, header?.create_time);

  return {
    kind: "message",
    message: {
      channel: options.channel ?? "feishu",
      // The external chat id doubles as the conversation identifier here; the
      // ingestion layer maps it to Conversation.externalChatId.
      conversationId: chatId,
      messageId,
      senderId,
      text,
      timestamp: toDate(createTime, options.now),
      metadata: {
        chatId,
        chatType: typeof message.chat_type === "string" ? message.chat_type : undefined,
        threadId,
        messageType,
        eventType,
        eventId: typeof header?.event_id === "string" ? header.event_id : undefined,
      },
    },
  };
}

function extractText(content: unknown): string {
  if (typeof content !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function toDate(value: string | undefined, now?: () => number): Date {
  if (value) {
    const millis = Number(value);
    if (Number.isFinite(millis) && millis > 0) {
      return new Date(millis);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(now?.() ?? Date.now());
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
