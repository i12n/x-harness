import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";

export const CONVERSATION_STATUSES = ["ACTIVE", "CLOSED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_TYPES = ["text", "command", "result", "system"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const SUBJECT_TYPES = ["problem", "task", "run"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/**
 * One chat thread. The conversation may exist without a subject and must not
 * own the subject's lifecycle (Problem/Task/Run outlive the chat).
 */
export interface Conversation {
  id: string;
  channel: string;
  externalChatId: string;
  externalThreadId?: string;
  title?: string;
  subjectType?: SubjectType;
  subjectId?: string;
  /**
   * TASK-1243: the message this conversation's topic is anchored to.
   *
   * Feishu has no "send into thread X" API — a message can only be placed into
   * a topic by replying to a message that lives in it. The anchor is that
   * message, so every reply for one requirement lands in the same topic.
   */
  anchorMessageId?: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationInput {
  id?: string;
  channel: string;
  externalChatId: string;
  externalThreadId?: string;
  title?: string;
  subjectType?: SubjectType;
  subjectId?: string;
  anchorMessageId?: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  channel: string;
  direction: MessageDirection;
  senderId: string;
  messageType: MessageType;
  content: string;
  metadata?: Record<string, unknown>;
  externalMessageId?: string;
  createdAt: string;
}

export interface AppendMessageInput {
  id?: string;
  conversationId: string;
  channel: string;
  direction: MessageDirection;
  senderId: string;
  messageType?: MessageType;
  content?: string;
  metadata?: Record<string, unknown>;
  externalMessageId?: string;
  createdAt?: string;
}

export function isConversationStatus(value: unknown): value is ConversationStatus {
  return typeof value === "string" && (CONVERSATION_STATUSES as readonly string[]).includes(value);
}

export function isMessageDirection(value: unknown): value is MessageDirection {
  return typeof value === "string" && (MESSAGE_DIRECTIONS as readonly string[]).includes(value);
}

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && (MESSAGE_TYPES as readonly string[]).includes(value);
}

export function isSubjectType(value: unknown): value is SubjectType {
  return typeof value === "string" && (SUBJECT_TYPES as readonly string[]).includes(value);
}

export function buildConversation(input: CreateConversationInput): Conversation {
  const channel = input.channel?.trim();
  if (!channel) {
    throw new ValidationError("conversation channel is required");
  }
  const externalChatId = input.externalChatId?.trim();
  if (!externalChatId) {
    throw new ValidationError("conversation external chat id is required");
  }
  if (input.subjectType !== undefined && !isSubjectType(input.subjectType)) {
    throw new ValidationError(`invalid subject type: ${String(input.subjectType)}`);
  }
  const now = new Date().toISOString();
  return {
    id: input.id?.trim() || makeId("conv"),
    channel,
    externalChatId,
    externalThreadId: input.externalThreadId?.trim() || undefined,
    title: input.title?.trim() || undefined,
    subjectType: input.subjectType,
    subjectId: input.subjectId?.trim() || undefined,
    anchorMessageId: input.anchorMessageId?.trim() || undefined,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
}

export function buildConversationMessage(
  input: AppendMessageInput,
): ConversationMessage {
  if (!isMessageDirection(input.direction)) {
    throw new ValidationError(`invalid message direction: ${String(input.direction)}`);
  }
  const senderId = input.senderId?.trim();
  if (!senderId) {
    throw new ValidationError("conversation message sender id is required");
  }
  const messageType = input.messageType ?? "text";
  if (!isMessageType(messageType)) {
    throw new ValidationError(`invalid message type: ${String(messageType)}`);
  }
  return {
    id: input.id?.trim() || makeId("msg"),
    conversationId: input.conversationId,
    channel: input.channel,
    direction: input.direction,
    senderId,
    messageType,
    content: input.content ?? "",
    metadata: input.metadata,
    externalMessageId: input.externalMessageId?.trim() || undefined,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
