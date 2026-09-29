import { Pool } from "pg";
import {
  buildConversation,
  buildConversationMessage,
} from "../domain/conversation.js";
import type {
  AppendMessageInput,
  Conversation,
  ConversationMessage,
  CreateConversationInput,
  SubjectType,
} from "../domain/conversation.js";
import { ConversationNotFoundError } from "../errors.js";
import type {
  ConversationListFilter,
  ConversationStore,
  FindConversationInput,
  MessageListOptions,
} from "./conversationStore.js";

interface ConversationRow {
  id: string;
  channel: string;
  external_chat_id: string;
  external_thread_id: string | null;
  title: string | null;
  subject_type: string | null;
  subject_id: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  channel: string;
  direction: string;
  sender_id: string;
  message_type: string;
  content: string;
  metadata: unknown;
  external_message_id: string | null;
  created_at: Date | string;
}

export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly pool: Pool) {}

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const conversation = buildConversation(input);
    const { rows } = await this.pool.query<ConversationRow>(
      `INSERT INTO conversations
         (id, channel, external_chat_id, external_thread_id, title,
          subject_type, subject_id, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       RETURNING *`,
      [
        conversation.id,
        conversation.channel,
        conversation.externalChatId,
        conversation.externalThreadId ?? null,
        conversation.title ?? null,
        conversation.subjectType ?? null,
        conversation.subjectId ?? null,
        conversation.status,
        conversation.createdAt,
      ],
    );
    return rowToConversation(requireRow(rows, "createConversation"));
  }

  async ensureConversation(input: CreateConversationInput): Promise<Conversation> {
    const existing = await this.findConversationByExternal({
      channel: input.channel,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId,
    });
    if (existing) {
      return existing;
    }
    try {
      return await this.createConversation(input);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const fallback = await this.findConversationByExternal({
          channel: input.channel,
          externalChatId: input.externalChatId,
          externalThreadId: input.externalThreadId,
        });
        if (fallback) {
          return fallback;
        }
      }
      throw error;
    }
  }

  async findConversation(id: string): Promise<Conversation> {
    const { rows } = await this.pool.query<ConversationRow>(
      "SELECT * FROM conversations WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new ConversationNotFoundError(id);
    }
    return rowToConversation(row);
  }

  async findConversationByExternal(
    input: FindConversationInput,
  ): Promise<Conversation | undefined> {
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT * FROM conversations
       WHERE channel = $1 AND external_chat_id = $2
         AND COALESCE(external_thread_id, '') = $3
       LIMIT 1`,
      [input.channel, input.externalChatId, input.externalThreadId?.trim() || ""],
    );
    return rows[0] ? rowToConversation(rows[0]) : undefined;
  }

  async listConversations(
    filter: ConversationListFilter = {},
  ): Promise<Conversation[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    };
    if (filter.channel !== undefined) push("channel", filter.channel);
    if (filter.status !== undefined) push("status", filter.status);
    if (filter.subjectType !== undefined) push("subject_type", filter.subjectType);
    if (filter.subjectId !== undefined) push("subject_id", filter.subjectId);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT * FROM conversations ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(rowToConversation);
  }

  async attachSubject(
    id: string,
    subject: { subjectType: SubjectType; subjectId: string },
  ): Promise<Conversation> {
    const { rows } = await this.pool.query<ConversationRow>(
      `UPDATE conversations
       SET subject_type = $1, subject_id = $2, updated_at = $3
       WHERE id = $4
       RETURNING *`,
      [subject.subjectType, subject.subjectId, new Date().toISOString(), id],
    );
    const row = rows[0];
    if (!row) {
      throw new ConversationNotFoundError(id);
    }
    return rowToConversation(row);
  }

  async appendMessage(input: AppendMessageInput): Promise<ConversationMessage> {
    await this.findConversation(input.conversationId);
    const message = buildConversationMessage(input);
    try {
      const { rows } = await this.pool.query<MessageRow>(
        `INSERT INTO conversation_messages
           (id, conversation_id, channel, direction, sender_id, message_type,
            content, metadata, external_message_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          message.id,
          message.conversationId,
          message.channel,
          message.direction,
          message.senderId,
          message.messageType,
          message.content,
          message.metadata ? JSON.stringify(message.metadata) : null,
          message.externalMessageId ?? null,
          message.createdAt,
        ],
      );
      await this.touchConversation(message.conversationId, message.createdAt);
      return rowToMessage(requireRow(rows, "appendMessage"));
    } catch (error) {
      if (isUniqueViolation(error) && message.externalMessageId) {
        const existing = await this.findMessageByExternal(
          message.channel,
          message.externalMessageId,
        );
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  async findMessageByExternal(
    channel: string,
    externalMessageId: string,
  ): Promise<ConversationMessage | undefined> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM conversation_messages
       WHERE channel = $1 AND external_message_id = $2
       LIMIT 1`,
      [channel, externalMessageId],
    );
    return rows[0] ? rowToMessage(rows[0]) : undefined;
  }

  async listMessages(
    conversationId: string,
    options: MessageListOptions = {},
  ): Promise<ConversationMessage[]> {
    const conditions = ["conversation_id = $1"];
    const params: unknown[] = [conversationId];
    if (options.before !== undefined) {
      params.push(options.before);
      conditions.push(`created_at < $${params.length}`);
    }
    if (options.after !== undefined) {
      params.push(options.after);
      conditions.push(`created_at > $${params.length}`);
    }
    const where = conditions.join(" AND ");

    if (options.limit !== undefined && options.limit > 0) {
      params.push(options.limit);
      const { rows } = await this.pool.query<MessageRow>(
        `SELECT * FROM (
           SELECT * FROM conversation_messages
           WHERE ${where}
           ORDER BY created_at DESC, id DESC
           LIMIT $${params.length}
         ) recent
         ORDER BY created_at ASC, id ASC`,
        params,
      );
      return rows.map(rowToMessage);
    }
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM conversation_messages
       WHERE ${where}
       ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(rowToMessage);
  }

  async deleteMessagesBefore(
    before: string,
    options: { dryRun?: boolean } = {},
  ): Promise<number> {
    if (options.dryRun) {
      const { rows } = await this.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM conversation_messages WHERE created_at < $1",
        [before],
      );
      return Number(rows[0]?.count ?? 0);
    }
    const { rowCount } = await this.pool.query(
      "DELETE FROM conversation_messages WHERE created_at < $1",
      [before],
    );
    return rowCount ?? 0;
  }

  private async touchConversation(id: string, updatedAt: string): Promise<void> {
    await this.pool.query(
      "UPDATE conversations SET updated_at = $1 WHERE id = $2",
      [updatedAt, id],
    );
  }
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    channel: row.channel,
    externalChatId: row.external_chat_id,
    externalThreadId: row.external_thread_id ?? undefined,
    title: row.title ?? undefined,
    subjectType: (row.subject_type as SubjectType | null) ?? undefined,
    subjectId: row.subject_id ?? undefined,
    status: row.status as Conversation["status"],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    channel: row.channel,
    direction: row.direction as ConversationMessage["direction"],
    senderId: row.sender_id,
    messageType: row.message_type as ConversationMessage["messageType"],
    content: row.content,
    metadata: (parseJson(row.metadata) as Record<string, unknown> | null) ?? undefined,
    externalMessageId: row.external_message_id ?? undefined,
    createdAt: toIso(row.created_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: string }).code === "23505"
  );
}

function parseJson(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`${label}: no row returned`);
  }
  return row;
}
